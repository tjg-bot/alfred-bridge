import "dotenv/config";
import express, { type Request, type Response } from "express";
import { logger } from "./logger.js";
import { startWhatsappClient, type WAClient } from "./wa-client.js";
import { makeMessageHandler, makeButtonHandler } from "./handlers.js";
import {
  setPresenceAvailable,
  setPresenceUnavailable,
  getAlfredAvailabilityState,
} from "./humanizer.js";
import { createRateLimiter } from "./rate-limit.js";
import { startScribeJob, getScribeStatus } from "./scribe.js";
import { timingSafeSecretMatch } from "./scribe-security.js";

// Broadcast dedupe: cache dedupeKey -> timestamp for 24h. If FK-side cron
// hits /broadcast twice with the same key, the second call short-circuits.
const BROADCAST_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
const broadcastDedupe = new Map<string, number>();
const broadcastDedupeCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of broadcastDedupe) {
    if (now - ts > BROADCAST_DEDUPE_TTL_MS) broadcastDedupe.delete(key);
  }
}, 60 * 60 * 1000);
broadcastDedupeCleanup.unref();

// Broadcast rate limit: hard cap 30 broadcasts / hour.
const BROADCAST_RATE_LIMIT = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  maxRequests: 30,
});

// Track the last text Alfred broadcast so we can reject accidental duplicates.
let lastBroadcastText: string | null = null;
let lastBroadcastDedupeKey: string | null = null;

const MAX_BROADCAST_LEN = 3500;
const MIN_BROADCAST_LEN = 1;

/**
 * Strip null bytes and control chars (except newline + tab) from broadcast
 * text. WhatsApp rejects some control chars and they can also be an injection
 * vector. Also collapses trailing whitespace.
 */
function sanitizeBroadcastText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim();
}

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    logger.error({ name }, "Missing required env var");
    process.exit(1);
  }
  return val;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8080);
  const authPath = process.env.BRIDGE_AUTH_PATH || "./auth-state";
  // Multi-group support. ALFRED_GROUP_JIDS is a comma-separated list. For
  // backwards compat we also accept the older single ALFRED_GROUP_JID.
  // Additionally we recognise two distinct roles per group:
  //   ALFRED_KINGS_GROUP_JID - the founding kings council
  //   ALFRED_OPS_GROUP_JID   - the operations group with staff (Danlyn, Dhei)
  const groupJids = (
    process.env.ALFRED_GROUP_JIDS ||
    [process.env.ALFRED_KINGS_GROUP_JID, process.env.ALFRED_OPS_GROUP_JID, process.env.ALFRED_GROUP_JID]
      .filter(Boolean)
      .join(",")
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const groupJid = groupJids[0] || "";  // legacy single-group callers keep working
  const kingsGroupJid = process.env.ALFRED_KINGS_GROUP_JID || groupJid;
  const opsGroupJid = process.env.ALFRED_OPS_GROUP_JID || "";

  requiredEnv("ALFRED_API_URL");
  requiredEnv("ALFRED_BRIDGE_SECRET");
  const bridgeSecret = process.env.ALFRED_BRIDGE_SECRET!;

  if (!groupJid) {
    logger.warn(
      "ALFRED_GROUP_JID is not set. Bridge will connect and log all groups but will not route messages until it is set."
    );
  }

  // ─── Startup one-liner ──────────────────────────────────────────────
  // Anyone tailing Railway/Fly logs should see Alfred's operating mode at
  // a glance without hunting through pino JSON.
  const alfredPhoneRaw = (process.env.ALFRED_PHONE || "").replace(/\D/g, "");
  const maskedPhone = alfredPhoneRaw
    ? `${alfredPhoneRaw.slice(0, 2)}${"*".repeat(Math.max(0, alfredPhoneRaw.length - 4))}${alfredPhoneRaw.slice(-2)}`
    : "unset";
  const bootAvailability = getAlfredAvailabilityState();
  logger.info(
    `Alfred bridge online. Tag-only mode: ENABLED. Alfred phone: ${maskedPhone}. Group: ${groupJid || "unset"}. Availability: ${bootAvailability}.`
  );

  // Holder pattern lets handlers reference the client that is being built.
  let wa: WAClient | null = null;

  const messageHandler = (input: Parameters<Parameters<typeof startWhatsappClient>[0]["onGroupMessage"]>[0]) => {
    if (!wa) return Promise.resolve();
    return makeMessageHandler({ wa, logger })(input);
  };

  const buttonHandler = (input: Parameters<Parameters<typeof startWhatsappClient>[0]["onButtonReply"]>[0]) => {
    if (!wa) return Promise.resolve();
    return makeButtonHandler({ wa, logger })(input);
  };

  wa = await startWhatsappClient({
    authPath,
    groupJid,
    allowedGroupJids: groupJids.length > 0 ? groupJids : undefined,
    onGroupMessage: messageHandler,
    onButtonReply: buttonHandler,
    logger,
  });

  // OMNIPRESENCE (hard rule): Alfred is always available. No sleep-hour gate,
  // no overnight offline. Only exception is the occasional 2% micro-AFK during
  // the day so his presence isn't a suspicious flat line - real humans put
  // their phone down for a minute here and there.
  const presenceCycler = setInterval(() => {
    try {
      if (!wa?.sock) return;
      const microAfk = Math.random() < 0.02;
      if (microAfk) {
        void setPresenceUnavailable(wa.sock);
        // Come back online within 30-90 sec.
        setTimeout(() => {
          if (wa?.sock) void setPresenceAvailable(wa.sock);
        }, 30_000 + Math.floor(Math.random() * 60_000));
      } else {
        void setPresenceAvailable(wa.sock);
      }
    } catch {
      // Non-fatal
    }
  }, 5 * 60 * 1000 + Math.floor(Math.random() * 60 * 1000));

  // Boot: come online immediately. No sleep-gate check.
  setTimeout(() => {
    if (!wa?.sock) return;
    void setPresenceAvailable(wa.sock);
    logger.info("Alfred set to available at boot (omnipresence mode - no sleep gate)");
  }, 5000);

  // Catch-up sweep on boot: query FK for king messages that were addressed to
  // Alfred in the last 6 hours but never got a reply. Post responses to each,
  // one at a time, with human pacing (30-90 sec between messages) so it feels
  // like a person catching up on missed threads. Fire after WhatsApp is
  // stable (30 sec after boot).
  setTimeout(async () => {
    if (!wa?.sock || !wa.isConnected()) {
      logger.warn("Skipping boot catch-up: WhatsApp not connected");
      return;
    }
    try {
      const { postAlfredCatchUp, postAlfredChat } = await import("./alfred-client.js");
      const unanswered = await postAlfredCatchUp({ hours: 6, maxMessages: 8 });
      if (unanswered.length === 0) {
        logger.info("Boot catch-up: no unanswered messages found");
        return;
      }
      logger.info({ count: unanswered.length }, "Boot catch-up: replying to unanswered messages");

      for (let i = 0; i < unanswered.length; i++) {
        const msg = unanswered[i];
        try {
          const reply = await postAlfredChat({
            senderPhone: msg.senderPhone,
            senderName: msg.senderName,
            groupJid: groupJid,
            text: `[CATCH-UP - I was briefly offline, replying now to thy earlier message] ${msg.text}`,
            messageId: msg.messageId || `catchup-${Date.now()}-${i}`,
          });
          const text = reply.text || reply.errorMessage || "";
          if (text && wa?.sock && groupJid) {
            await wa.sendGroupMessage(groupJid, text);
          }
        } catch (err) {
          logger.warn({ err, messageId: msg.messageId }, "Catch-up reply failed for one message");
        }
        // Human pacing between catch-up replies: 30-90 sec.
        if (i < unanswered.length - 1) {
          const pauseMs = 30_000 + Math.floor(Math.random() * 60_000);
          await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }
      }

      logger.info({ replied: unanswered.length }, "Boot catch-up complete");
    } catch (err) {
      logger.warn({ err }, "Boot catch-up sweep failed - non-fatal");
    }
  }, 30_000);

  const app = express();
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      connected: wa?.isConnected() ?? false,
      groupJid: groupJid || null,
    });
  });

  app.post("/broadcast", async (req: Request, res: Response) => {
    const auth = req.header("authorization") || "";
    if (auth !== `Bearer ${bridgeSecret}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body as
      | { text?: string; groupJid?: string; dedupeKey?: string }
      | undefined;

    // ─── Broadcast rate limit (30/hour) ─────────────────────────────────
    const rateCheck = BROADCAST_RATE_LIMIT.check("__broadcast__");
    if (!rateCheck.allowed) {
      logger.error(
        { retryAfterMs: rateCheck.retryAfterMs },
        "Broadcast rate limit exceeded (30/hour) - returning 429"
      );
      const retryAfterSec = Math.ceil((rateCheck.retryAfterMs || 0) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: "too many broadcasts",
        retryAfterMs: rateCheck.retryAfterMs,
      });
      return;
    }

    const rawText = body?.text;
    if (typeof rawText !== "string") {
      res.status(400).json({ error: "missing text" });
      return;
    }
    const text = sanitizeBroadcastText(rawText);

    // ─── Content sanity checks ──────────────────────────────────────────
    if (text.length < MIN_BROADCAST_LEN) {
      res.status(400).json({ error: "text is empty after sanitization" });
      return;
    }
    if (text.length > MAX_BROADCAST_LEN) {
      res.status(400).json({
        error: "text too long",
        max: MAX_BROADCAST_LEN,
        got: text.length,
      });
      return;
    }

    const dedupeKey = typeof body?.dedupeKey === "string" ? body.dedupeKey : null;

    // Reject exact duplicate of the last broadcast, unless a different (or no)
    // dedupeKey is provided. This blocks accidental double-fires without
    // breaking legitimate identical messages that are explicitly keyed
    // differently.
    if (
      lastBroadcastText === text &&
      (dedupeKey === null || dedupeKey === lastBroadcastDedupeKey)
    ) {
      logger.warn(
        { textPreview: text.slice(0, 60), dedupeKey },
        "Broadcast rejected: identical to last message Alfred sent"
      );
      res.status(400).json({ error: "duplicate of last broadcast" });
      return;
    }

    // ─── Dedupe by key (24h window) ─────────────────────────────────────
    if (dedupeKey) {
      const priorTs = broadcastDedupe.get(dedupeKey);
      if (priorTs && Date.now() - priorTs < BROADCAST_DEDUPE_TTL_MS) {
        logger.info(
          { dedupeKey },
          "Broadcast deduped by key within 24h window"
        );
        res.json({ ok: true, deduped: true });
        return;
      }
    }

    const target = body?.groupJid || groupJid;
    if (!target) {
      res.status(400).json({ error: "no group configured" });
      return;
    }
    if (!target.endsWith("@g.us")) {
      logger.error(
        { target },
        "Broadcast rejected: target is not a group JID"
      );
      res.status(400).json({ error: "target must be a group JID" });
      return;
    }
    if (!wa?.isConnected()) {
      res.status(503).json({ error: "whatsapp not connected" });
      return;
    }
    try {
      await wa.sendGroupMessage(target, text);
      if (dedupeKey) broadcastDedupe.set(dedupeKey, Date.now());
      lastBroadcastText = text;
      lastBroadcastDedupeKey = dedupeKey;
      logger.info(
        { target, textLen: text.length, dedupeKey },
        "Broadcast sent"
      );
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "Broadcast failed");
      res.status(500).json({ error: "send failed" });
    }
  });

  // ─── Scribe (Claude Code on Oracle) ─────────────────────────────────────
  // POST /scribe: FK server dispatches a code-change task from Tyler here.
  // Body: {taskId, prompt, requesterEmail, requesterName}. Returns immediately;
  // work runs async. Poll /scribe/status?taskId=... for result.
  //
  // Auth: bridge secret via Authorization: Bearer <secret>.
  // Tyler check happens BOTH here (defence in depth) and at FK server.
  app.post("/scribe", async (req: Request, res: Response) => {
    const provided = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeSecretMatch(provided, bridgeSecret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const body = req.body as
      | {
          taskId?: string;
          prompt?: string;
          requesterEmail?: string;
          requesterName?: string;
        }
      | undefined;
    if (!body?.taskId || !body?.prompt || !body?.requesterEmail) {
      res.status(400).json({ error: "missing taskId, prompt, or requesterEmail" });
      return;
    }
    try {
      const result = await startScribeJob({
        taskId: String(body.taskId),
        prompt: String(body.prompt),
        requesterEmail: String(body.requesterEmail),
        requesterName: String(body.requesterName || ""),
      });
      res.status(result.ok ? 202 : 403).json(result);
    } catch (err) {
      logger.error({ err }, "Scribe start failed");
      res.status(500).json({ error: "scribe start failed" });
    }
  });

  app.get("/scribe/status", (req: Request, res: Response) => {
    const provided = (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!timingSafeSecretMatch(provided, bridgeSecret)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const taskId = String(req.query.taskId || "");
    if (!taskId) {
      res.status(400).json({ error: "missing taskId" });
      return;
    }
    const job = getScribeStatus(taskId);
    if (!job) {
      res.status(404).json({ error: "task not found or already flushed" });
      return;
    }
    res.json(job);
  });

  const server = app.listen(port, () => {
    logger.info({ port }, "Alfred bridge HTTP server listening");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down");
    clearInterval(presenceCycler);
    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn("Force exiting after timeout");
      process.exit(1);
    }, 8000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "Fatal error starting bridge");
  process.exit(1);
});
