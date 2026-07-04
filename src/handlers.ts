import type { Logger } from "./logger.js";
import type {
  GroupMessagePayload,
  ButtonReplyPayload,
  WAClient,
} from "./wa-client.js";
import {
  postAlfredChat,
  postAlfredExecute,
  postToKnowledgeBase,
  type AlfredChatResponse,
} from "./alfred-client.js";
import {
  humanReplyDelay,
  humanReadDelay,
  humanBurstDelay,
  showTyping,
  stopTyping,
  markMessageRead,
  maybeChunkReply,
  isAlfredAsleep,
  shouldAlfredIgnore,
  randomEmoji,
  reactToMessage,
  humanIntroInsertion,
  getAlfredAvailabilityState,
} from "./humanizer.js";
import { shouldAlfredRespond } from "./response-filter.js";
import { createRateLimiter } from "./rate-limit.js";

const ALFRED_PHONE = (process.env.ALFRED_PHONE || "").replace(/\D/g, "");

const KING_ENV_VARS = ["KING_TYLER", "KING_ANTONIOS", "KING_MORGAN", "KING_ANDREW"] as const;

interface KingLookup {
  phone: string;
  name: string;
}

function loadKings(): Map<string, KingLookup> {
  const map = new Map<string, KingLookup>();
  for (const key of KING_ENV_VARS) {
    const val = process.env[key];
    if (!val) continue;
    const normalized = val.replace(/\D/g, "");
    if (!normalized) continue;
    const name = key.replace(/^KING_/, "");
    const prettyName = name.charAt(0) + name.slice(1).toLowerCase();
    map.set(normalized, { phone: normalized, name: prettyName });
  }
  return map;
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, "");
}

const ERR_TRY_AGAIN =
  "Alfred is having a moment. Try again in 30 seconds.";

const RATE_LIMIT_REPLY =
  "Alfred needs a moment. Too many rapid messages from thy hand.";

// notAuthorizedMessage removed - HARD RULE that Alfred never tells anyone
// they are "not on the founding kings list". Anyone reaching the bridge from
// the founding-kings group IS a king by definition.

// Per-sender phone: 20 messages / 5 minutes.
const PER_SENDER_LIMIT = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  maxRequests: 20,
});

// Global cap: 60 messages / 1 minute across ALL senders.
const GLOBAL_LIMIT = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
});

// Track whether the "you have been rate limited" warning has been sent to a
// sender in the current window, so we only send it once (silently drop the
// rest until the window resets).
const rateLimitWarningSent = new Map<string, number>();

// Global pause: when the global limit trips, pause all Alfred outbound
// responses for 30 sec to protect the account.
let globalPauseUntil = 0;

// Message-id dedup: keep the last 500 processed messageIds for 5 min so we
// ignore WhatsApp re-deliveries of the same event.
const MESSAGE_ID_TTL_MS = 5 * 60 * 1000;
const MESSAGE_ID_MAX = 500;
const processedMessageIds = new Map<string, number>();

// Text-content dedup: same king + same trimmed text within 2 min only gets
// answered once.
const TEXT_DEDUPE_TTL_MS = 2 * 60 * 1000;
const recentTextByKing = new Map<string, number>();

const dedupeCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds) {
    if (now - ts > MESSAGE_ID_TTL_MS) processedMessageIds.delete(id);
  }
  for (const [key, ts] of recentTextByKing) {
    if (now - ts > TEXT_DEDUPE_TTL_MS) recentTextByKing.delete(key);
  }
  for (const [key, ts] of rateLimitWarningSent) {
    if (now - ts > 5 * 60 * 1000) rateLimitWarningSent.delete(key);
  }
}, 60_000);
dedupeCleanup.unref();

function rememberMessageId(id: string): void {
  processedMessageIds.set(id, Date.now());
  if (processedMessageIds.size > MESSAGE_ID_MAX) {
    // Drop the oldest entries. Map preserves insertion order, so peel the
    // front until we're back under the cap.
    const overflow = processedMessageIds.size - MESSAGE_ID_MAX;
    let dropped = 0;
    for (const key of processedMessageIds.keys()) {
      if (dropped >= overflow) break;
      processedMessageIds.delete(key);
      dropped += 1;
    }
  }
}

export function makeMessageHandler(deps: {
  wa: WAClient;
  logger: Logger;
}): (msg: GroupMessagePayload) => Promise<void> {
  const { wa, logger } = deps;
  const kings = loadKings();
  logger.info({ kings: Array.from(kings.keys()) }, "Loaded authorized king phones");

  return async (msg: GroupMessagePayload) => {
    const phone = normalizePhone(msg.from);
    const king = kings.get(phone);

    // ─── Global rate limit (account-wide) ──────────────────────────────
    const now = Date.now();
    if (now < globalPauseUntil) {
      logger.warn(
        { phone, messageId: msg.messageId, resumeInMs: globalPauseUntil - now },
        "Global rate-limit pause active, dropping incoming message"
      );
      return;
    }
    const globalCheck = GLOBAL_LIMIT.check("__global__");
    if (!globalCheck.allowed) {
      globalPauseUntil = now + 30_000;
      logger.error(
        { messageId: msg.messageId, pausedForMs: 30_000 },
        "GLOBAL rate limit tripped - pausing all Alfred responses for 30 sec to protect account"
      );
      return;
    }

    // ─── Message-id dedup (WhatsApp re-delivery) ───────────────────────
    if (msg.messageId && processedMessageIds.has(msg.messageId)) {
      logger.info(
        { messageId: msg.messageId, phone },
        "Duplicate messageId within TTL, ignoring re-delivery"
      );
      return;
    }
    if (msg.messageId) rememberMessageId(msg.messageId);

    // HARD RULE: anyone in the founding kings group is a king by definition.
    // The group is closed - only the 4 kings + Alfred are members. We do NOT
    // gate on phone-number match. If the sender's phone isn't in the env
    // registry, we still treat them as a king and use their WhatsApp display
    // name as the identity we forward to FK.
    const effectiveKing: KingLookup =
      king || {
        phone,
        name: (msg.fromName && msg.fromName.trim()) || "King",
      };

    // ─── Per-sender rate limit ─────────────────────────────────────────
    const senderCheck = PER_SENDER_LIMIT.check(phone);
    if (!senderCheck.allowed) {
      const alreadyWarned = rateLimitWarningSent.has(phone);
      logger.warn(
        {
          king: effectiveKing.name,
          phone,
          messageId: msg.messageId,
          retryAfterMs: senderCheck.retryAfterMs,
          alreadyWarned,
        },
        "Per-sender rate limit exceeded, not invoking Alfred"
      );
      if (!alreadyWarned) {
        rateLimitWarningSent.set(phone, Date.now());
        try {
          await wa.sendGroupMessage(msg.groupJid, RATE_LIMIT_REPLY);
        } catch (err) {
          logger.error({ err }, "Failed to send rate-limit warning");
        }
      }
      return;
    }

    // Clear a stale warning marker once the sender is back under the cap.
    if (rateLimitWarningSent.has(phone)) rateLimitWarningSent.delete(phone);

    // ─── Text-content dedup (same king + same text within 2 min) ───────
    const textKey = `${phone}::${msg.text.trim().toLowerCase()}`;
    const priorTs = recentTextByKing.get(textKey);
    if (priorTs && Date.now() - priorTs < TEXT_DEDUPE_TTL_MS) {
      logger.info(
        { king: effectiveKing.name, messageId: msg.messageId },
        "Duplicate text content from same king within window, ignoring"
      );
      return;
    }
    recentTextByKing.set(textKey, Date.now());

    // ─── Tag-only response filter ──────────────────────────────────────
    // Alfred only replies when explicitly addressed. Everything else goes
    // silently to the FK knowledge base for context. This is the biggest
    // "feels like a real colleague" lever - real people don't chime in on
    // every message. Alfred uses judgment: explicit tags always respond,
    // relevant-topic messages get forwarded so Alfred can decide, everything
    // else is silent (still logged to knowledge base).
    const { decideResponseMode } = await import("./response-filter.js");
    const mode = decideResponseMode(msg.text);
    const repliedToAlfred = msg.quotedFromMe === true;
    if (mode === "silent" && !repliedToAlfred) {
      logger.info(
        { king: effectiveKing.name, messageId: msg.messageId, textLen: msg.text.length, mode },
        "Message not relevant to Alfred, logging to knowledge base and staying silent"
      );
      await postToKnowledgeBase({
        senderPhone: effectiveKing.phone,
        senderName: effectiveKing.name,
        groupJid: msg.groupJid,
        text: msg.text,
        messageId: msg.messageId,
      });
      return;
    }

    // ─── Availability state (informational only) ────────────────────────
    // Alfred is OMNIPRESENT. He never sleeps. Availability state is used
    // purely to shape the response tempo (a bit slower at night to feel
    // human), never to silence him.
    const availability = getAlfredAvailabilityState();

    // ─── Probabilistic human ignore ────────────────────────────────────
    // Real humans don't respond to EVERY message directed at them.
    if (shouldAlfredIgnore(msg.text)) {
      logger.info(
        { king: effectiveKing.name, messageId: msg.messageId, availability },
        "Alfred chose not to respond (probabilistic human ignore)"
      );
      // Still log the message so the knowledge base sees it.
      await postToKnowledgeBase({
        senderPhone: effectiveKing.phone,
        senderName: effectiveKing.name,
        groupJid: msg.groupJid,
        text: msg.text,
        messageId: msg.messageId,
      });
      return;
    }

    logger.info(
      { king: effectiveKing.name, textLen: msg.text.length, messageId: msg.messageId, availability },
      "Forwarding message to Alfred"
    );

    // Humanizer step 1: natural read delay before marking as read.
    await humanReadDelay();
    try {
      await markMessageRead(wa.sock, {
        remoteJid: msg.groupJid,
        id: msg.messageId,
      });
    } catch {
      // Non-fatal
    }

    // Alfred is omnipresent. The old "sleep hours" concept is retained only
    // as a soft tempo hint (slightly slower typing during late-night ET).

    let reply: AlfredChatResponse;
    try {
      reply = await postAlfredChat({
        senderPhone: effectiveKing.phone,
        senderName: effectiveKing.name,
        groupJid: msg.groupJid,
        text: msg.text,
        messageId: msg.messageId,
      });
    } catch (err) {
      logger.error({ err }, "Alfred chat call failed");
      try {
        await wa.sendGroupMessage(msg.groupJid, ERR_TRY_AGAIN);
      } catch (sendErr) {
        logger.error({ sendErr }, "Failed to send fallback error message");
      }
      return;
    }

    let outText = reply.text || reply.errorMessage || "";

    // Sprinkle a tiny natural filler ~15% of the time on longer replies so
    // Alfred sounds like a person mid-thought, not a rehearsed bot.
    outText = humanIntroInsertion(outText);

    // Occasionally react to the source message with an emoji like a real
    // human. Reactions are the ONE place emojis are allowed - it's the
    // WhatsApp reaction API, not text output.
    const reactionEmoji = randomEmoji();
    if (reactionEmoji && msg.key) {
      void reactToMessage(wa.sock, msg.key, reactionEmoji);
    }

    // Humanizer step 2: show typing indicator + natural composition delay
    // before sending. Bot detectors look for instant replies as a giveaway.
    // In "busy" / "afk" states we compose slower on top of the base delay.
    try {
      await showTyping(wa.sock, msg.groupJid);
      await humanReplyDelay(outText || "typing");
      if (availability === "busy" || availability === "afk") {
        // Add a small extra pause so off-hours replies feel less prompt.
        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 6000));
      }
    } catch {
      // Non-fatal
    }

    try {
      if (reply.pendingAction && reply.pendingAction.id) {
        const composed = outText
          ? `${outText}\n\n${reply.pendingAction.displayText}`
          : reply.pendingAction.displayText;
        await stopTyping(wa.sock, msg.groupJid);
        await wa.sendGroupInteractive(msg.groupJid, composed, [
          { id: `confirm_${reply.pendingAction.id}`, title: "Confirm" },
          { id: `cancel_${reply.pendingAction.id}`, title: "Cancel" },
        ]);
      } else if (outText) {
        // Humanizer step 3: occasionally split long replies into 2 messages
        // with a natural burst delay between them, like a real person.
        const chunks = maybeChunkReply(outText);
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) {
            await showTyping(wa.sock, msg.groupJid);
            await humanBurstDelay();
          }
          await stopTyping(wa.sock, msg.groupJid);
          await wa.sendGroupMessage(msg.groupJid, chunks[i]);
        }
      } else {
        await stopTyping(wa.sock, msg.groupJid);
        logger.warn({ reply }, "Alfred returned no text and no action; nothing to send");
      }
    } catch (err) {
      logger.error({ err }, "Failed to send Alfred reply back to group");
    }
  };
}

export function makeButtonHandler(deps: {
  wa: WAClient;
  logger: Logger;
}): (payload: ButtonReplyPayload) => Promise<void> {
  const { wa, logger } = deps;
  const kings = loadKings();

  return async (payload: ButtonReplyPayload) => {
    const phone = normalizePhone(payload.from);
    const king = kings.get(phone);

    // HARD RULE: anyone in the founding kings group is a king. No gating.
    const effectiveKing: KingLookup =
      king || {
        phone,
        name: (payload.fromName && payload.fromName.trim()) || "King",
      };

    logger.info(
      { king: effectiveKing.name, actionId: payload.actionId, confirmed: payload.confirmed },
      "Executing Alfred action"
    );

    let result;
    try {
      result = await postAlfredExecute({
        actionId: payload.actionId,
        confirmed: payload.confirmed,
        senderPhone: effectiveKing.phone,
      });
    } catch (err) {
      logger.error({ err }, "Alfred execute call failed");
      try {
        await wa.sendGroupMessage(payload.groupJid, ERR_TRY_AGAIN);
      } catch (sendErr) {
        logger.error({ sendErr }, "Failed to send fallback error on execute");
      }
      return;
    }

    if (result?.text) {
      try {
        await wa.sendGroupMessage(payload.groupJid, result.text);
      } catch (err) {
        logger.error({ err }, "Failed to send execute result back to group");
      }
    }
  };
}
