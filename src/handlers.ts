import type { Logger } from "./logger.js";
import type {
  GroupMessagePayload,
  ButtonReplyPayload,
  WAClient,
} from "./wa-client.js";
import {
  postMaximusChat,
  postMaximusExecute,
  postMaximusVoice,
  postToKnowledgeBase,
  type MaximusChatResponse,
} from "./maximus-client.js";
import { sendVoiceNote } from "./voice.js";
import {
  humanReplyDelay,
  humanReadDelay,
  humanBurstDelay,
  showTyping,
  stopTyping,
  markMessageRead,
  maybeChunkReply,
  isMaximusAsleep,
  shouldMaximusIgnore,
  randomEmoji,
  reactToMessage,
  humanIntroInsertion,
  getMaximusAvailabilityState,
} from "./humanizer.js";
import { shouldMaximusRespond } from "./response-filter.js";
import { createRateLimiter } from "./rate-limit.js";
import { checkAbuse, alertTylerAboutAbuse } from "./abuse-protection.js";

const ALFRED_PHONE = ((process.env.MAXIMUS_PHONE || process.env.ALFRED_PHONE) || "").replace(/\D/g, "");

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
  "Maximus is having a moment. Try again in 30 seconds.";

const RATE_LIMIT_REPLY =
  "Maximus needs a moment. Too many rapid messages from thy hand.";

// notAuthorizedMessage removed - HARD RULE that Maximus never tells anyone
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

// Global pause: when the global limit trips, pause all Maximus outbound
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
        "GLOBAL rate limit tripped - pausing all Maximus responses for 30 sec to protect account"
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

    // ─── ABUSE PROTECTION (before any FK call) ─────────────────────────
    // Runs BEFORE the FK dispatch so blocked messages cost nothing. Layers:
    //   1. Persistent blocklist (auto-populated after repeat violations)
    //   2. Global msgs/hr cap (protects Anthropic + OpenAI bill)
    //   3. Per-sender msgs/hr cap (auto-blocks after N strikes/week)
    //   4. Per-sender voice-notes/hr cap (voice is most expensive)
    //   5. Daily USD budget cap (rough estimate; hard-silences past cap)
    // Known kings are exempt from per-sender text caps (they naturally have
    // busy days) but STILL count against global throughput + daily cost.
    const isKnownKing = kings.has(phone);
    const isVoice = Boolean(msg.audio);
    const verdict = await checkAbuse({
      senderPhone: phone,
      senderName: msg.fromName,
      kind: isVoice ? "voice" : "text",
      groupJid: msg.groupJid,
      textPreview: msg.text.slice(0, 200),
      logger,
    });
    // Kings bypass "sender-cap" verdicts but not the global/cost caps.
    const isSenderCapReason = !verdict.allow && /per-sender/.test(verdict.reason);
    if (!verdict.allow && !(isKnownKing && isSenderCapReason)) {
      logger.warn(
        { phone, kind: isVoice ? "voice" : "text", reason: verdict.reason, isKnownKing },
        "Abuse gate dropped message",
      );
      if (verdict.sendTylerAlert && wa?.sock) {
        void alertTylerAboutAbuse({
          sock: wa.sock,
          senderPhone: phone,
          senderName: msg.fromName,
          reason: verdict.reason,
          preview: msg.text,
          logger,
        });
      }
      return;
    }

    // HARD RULE: anyone in the founding kings group is a king by definition.
    // The group is closed - only the 4 kings + Maximus are members. We do NOT
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
        "Per-sender rate limit exceeded, not invoking Maximus"
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

    // ─── Voice-note branch ─────────────────────────────────────────────
    // If the message is a WhatsApp voice note, route to FK's /voice endpoint
    // (transcribe + chat + optional TTS reply) instead of the text path.
    // Voice-in defaults to voice-out when the reply is short enough.
    if (msg.audio) {
      logger.info(
        {
          king: effectiveKing.name,
          messageId: msg.messageId,
          audioBytes: Math.floor(msg.audio.base64.length * 0.75),
        },
        "Voice note received, forwarding to FK /voice",
      );

      // Best-effort read-receipt on the incoming voice note.
      await humanReadDelay();
      try {
        await markMessageRead(wa.sock, {
          remoteJid: msg.groupJid,
          id: msg.messageId,
        });
      } catch {
        // Non-fatal
      }

      let voiceResult;
      try {
        voiceResult = await postMaximusVoice({
          senderPhone: effectiveKing.phone,
          senderName: effectiveKing.name,
          groupJid: msg.groupJid,
          audioBase64: msg.audio.base64,
          mimeType: msg.audio.mimeType,
          messageId: msg.messageId,
        });
      } catch (err) {
        logger.error({ err }, "Maximus voice call failed");
        try {
          await wa.sendGroupMessage(msg.groupJid, ERR_TRY_AGAIN);
        } catch (sendErr) {
          logger.error({ sendErr }, "Failed to send fallback error on voice");
        }
        return;
      }

      const replyText = (voiceResult.text || "").trim();

      // Show typing while composing (matches text-path humanizer feel).
      try {
        await showTyping(wa.sock, msg.groupJid);
        await humanReplyDelay(replyText || "typing");
      } catch {
        // Non-fatal
      }

      try {
        await stopTyping(wa.sock, msg.groupJid);
      } catch {
        // Non-fatal
      }

      // If FK returned audio, send as voice note. Otherwise fall back to text.
      if (voiceResult.audioBase64 && voiceResult.mimeType) {
        try {
          await sendVoiceNote(
            wa.sock,
            msg.groupJid,
            voiceResult.audioBase64,
            voiceResult.mimeType,
          );
        } catch (err) {
          logger.error({ err }, "Failed to send voice-note reply, falling back to text");
          if (replyText) {
            try {
              await wa.sendGroupMessage(msg.groupJid, replyText);
            } catch (fallbackErr) {
              logger.error({ fallbackErr }, "Fallback text send also failed");
            }
          }
        }
      } else if (replyText) {
        try {
          await wa.sendGroupMessage(msg.groupJid, replyText);
        } catch (err) {
          logger.error({ err }, "Failed to send text reply after voice note");
        }
      } else {
        logger.warn({ voiceResult }, "Voice endpoint returned no text and no audio");
      }
      return;
    }

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

    // ─── Response filter (per-group policy) ─────────────────────────────
    // Two different policies depending on which group this came from:
    //
    //   KINGS group  -> tag-or-relevant mode. Maximus stays quiet for pure
    //                   background chat because the kings don't want their
    //                   council spammed. Explicit tag + relevant-topic
    //                   messages still get through.
    //
    //   OPS group    -> always respond. Staff (Danlyn, Dhei) need visible
    //                   engagement from Maximus so instructions land. If they
    //                   say "noted" or "done" Maximus replies with a crisp
    //                   professional ack. No butler voice here - staff tone.
    //
    // Any other group (unknown / new) falls back to the kings policy so we
    // fail closed rather than open.
    const opsGroupJid = (process.env.MAXIMUS_OPS_GROUP_JID || process.env.ALFRED_OPS_GROUP_JID) || "";
    const isOpsGroup = opsGroupJid !== "" && msg.groupJid === opsGroupJid;
    const kingsGroupJid = (process.env.MAXIMUS_KINGS_GROUP_JID || process.env.ALFRED_KINGS_GROUP_JID) || (process.env.MAXIMUS_GROUP_JID || process.env.ALFRED_GROUP_JID) || "";
    const isKingsGroup = kingsGroupJid !== "" && msg.groupJid === kingsGroupJid;

    const { decideResponseMode } = await import("./response-filter.js");
    const mode = decideResponseMode(msg.text);
    const repliedToMaximus = msg.quotedFromMe === true;

    // Ops group + Kings group: force explicit mode so Maximus always speaks up.
    // The kings want visible engagement; silent-drop of greetings felt broken.
    const effectiveMode = isOpsGroup || isKingsGroup ? "explicit" : mode;

    if (effectiveMode === "silent" && !repliedToMaximus) {
      logger.info(
        { king: effectiveKing.name, messageId: msg.messageId, textLen: msg.text.length, mode, isOpsGroup },
        "Message not relevant to Maximus, logging to knowledge base and staying silent"
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
    // Maximus is OMNIPRESENT. He never sleeps. Availability state is used
    // purely to shape the response tempo (a bit slower at night to feel
    // human), never to silence him.
    const availability = getMaximusAvailabilityState();

    // ─── Probabilistic human ignore ────────────────────────────────────
    // Real humans don't respond to EVERY message directed at them.
    if (shouldMaximusIgnore(msg.text)) {
      logger.info(
        { king: effectiveKing.name, messageId: msg.messageId, availability },
        "Maximus chose not to respond (probabilistic human ignore)"
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
      "Forwarding message to Maximus"
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

    // Maximus is omnipresent. The old "sleep hours" concept is retained only
    // as a soft tempo hint (slightly slower typing during late-night ET).

    let reply: MaximusChatResponse | null = null;
    let lastErr: unknown = null;
    // Self-healing retry: first attempt, then a 3s backoff, then a 6s backoff.
    // Real transient errors (Vercel cold start, upstream Claude blip, brief
    // network hiccup) resolve within one retry. Persistent errors (401 auth
    // drift, 500s from FK, malformed payload) surface a specific diagnostic
    // to the group instead of a canned "having a moment".
    for (let attempt = 1; attempt <= 3 && !reply; attempt++) {
      try {
        reply = await postMaximusChat({
          senderPhone: effectiveKing.phone,
          senderName: effectiveKing.name,
          groupJid: msg.groupJid,
          text: msg.text,
          messageId: msg.messageId,
        });
      } catch (err) {
        lastErr = err;
        logger.warn({ err, attempt }, "Maximus chat call failed - will retry if attempts remain");
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 3000));
        }
      }
    }
    if (!reply) {
      const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr || "unknown");
      logger.error({ lastErr }, "Maximus chat call failed after 3 attempts");
      const humanExplain = errMsg.includes("401") || errMsg.toLowerCase().includes("unauthorized")
        ? "Mine credentials are out of sync with the wire - Tyler must refresh ALFRED_BRIDGE_SECRET on Vercel."
        : errMsg.includes("500") || errMsg.includes("502") || errMsg.includes("503") || errMsg.includes("504")
        ? "The FK server is unwell - a five-hundred error stopped mine reply thrice in a row. I shall try again on thy next message."
        : errMsg.toLowerCase().includes("timeout") || errMsg.toLowerCase().includes("aborted")
        ? "The line timed out thrice. FK server may be under load, or mine call took too long. Try again in a minute, milord."
        : `A hiccup on the wire I could not clear in three tries. Diagnostic: ${errMsg.slice(0, 140)}. I have logged it for the record.`;
      try {
        await wa.sendGroupMessage(msg.groupJid, humanExplain);
      } catch (sendErr) {
        logger.error({ sendErr }, "Failed to send diagnostic error message");
      }
      return;
    }

    let outText = reply.text || reply.errorMessage || "";

    // Sprinkle a tiny natural filler ~15% of the time on longer replies so
    // Maximus sounds like a person mid-thought, not a rehearsed bot.
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
        logger.warn({ reply }, "Maximus returned no text and no action; nothing to send");
      }
    } catch (err) {
      logger.error({ err }, "Failed to send Maximus reply back to group");
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
      "Executing Maximus action"
    );

    let result;
    try {
      result = await postMaximusExecute({
        actionId: payload.actionId,
        confirmed: payload.confirmed,
        senderPhone: effectiveKing.phone,
      });
    } catch (err) {
      logger.error({ err }, "Maximus execute call failed");
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
