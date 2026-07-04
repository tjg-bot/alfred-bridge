/**
 * Humanizer - makes Alfred's WhatsApp behaviour look more like a real person
 * and less like an automated bot. This is the "Alfred Never Dies" plan Layer 1.
 *
 * WhatsApp's bot detection looks for:
 *   - Instant replies (real humans take seconds to compose)
 *   - No typing indicators (real humans see the "typing..." bubble)
 *   - No read receipts (real humans open the app and read)
 *   - 24/7 online presence (real humans sleep)
 *   - Uniform message length (real humans vary)
 *   - Cron-precise timing (real humans send at irregular intervals)
 *
 * All the functions here inject natural randomness into Alfred's behaviour.
 */

import type { WASocket } from "@whiskeysockets/baileys";

// ─── Timing ────────────────────────────────────────────────────────────────

/**
 * Sleep for a randomized "thinking + typing" duration, scaled by message length.
 * Short reply -> 4-15 sec. Medium reply -> 12-30 sec. Long reply -> 25-60 sec.
 * Adds natural variance so consecutive replies don't land at identical intervals.
 */
export async function humanReplyDelay(replyText: string): Promise<void> {
  const words = replyText.trim().split(/\s+/).length;
  // Base thinking time (how long before starting to type)
  const thinkMs = 1500 + Math.random() * 3500; // 1.5-5 sec
  // Typing time - scale with reply length. Real humans type ~40 wpm average.
  const typingSeconds = Math.max(3, Math.min(45, words * 0.6));
  const typingJitter = 0.7 + Math.random() * 0.6; // 0.7x - 1.3x jitter
  const typingMs = typingSeconds * 1000 * typingJitter;
  const totalMs = thinkMs + typingMs;
  await sleep(totalMs);
}

/**
 * Small delay before marking a message as read - real humans don't
 * instantly read every ping. 2-15 sec.
 */
export async function humanReadDelay(): Promise<void> {
  await sleep(2000 + Math.random() * 13000);
}

/**
 * Pause between multi-message bursts. Real humans send message 1, wait,
 * then send message 2 - not machine-gun style.
 */
export async function humanBurstDelay(): Promise<void> {
  await sleep(1500 + Math.random() * 4500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Presence + typing indicators ──────────────────────────────────────────

/**
 * Show "typing..." to the group. WhatsApp shows this in real-time so recipients
 * see Alfred composing before the message lands - major bot-detection signal
 * mitigator.
 */
export async function showTyping(sock: WASocket, jid: string): Promise<void> {
  try {
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    // Non-fatal
  }
}

/**
 * Stop showing "typing" - called right before sending the actual message
 * so the transition feels natural.
 */
export async function stopTyping(sock: WASocket, jid: string): Promise<void> {
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    // Non-fatal
  }
}

/**
 * Mark Alfred as offline. Called during "sleep hours" so Alfred isn't
 * always-online (a bot dead giveaway). Real people go offline overnight.
 */
export async function setPresenceUnavailable(sock: WASocket): Promise<void> {
  try {
    await sock.sendPresenceUpdate("unavailable");
  } catch {
    // Non-fatal
  }
}

/**
 * Mark Alfred as available. Called during business hours.
 */
export async function setPresenceAvailable(sock: WASocket): Promise<void> {
  try {
    await sock.sendPresenceUpdate("available");
  } catch {
    // Non-fatal
  }
}

// ─── Read receipts ─────────────────────────────────────────────────────────

/**
 * Mark a specific message as read (natural human behaviour after "opening"
 * the chat). Baileys sendReadReceipts requires the message keys.
 */
export async function markMessageRead(
  sock: WASocket,
  messageKey: { remoteJid: string | null | undefined; id: string | null | undefined; participant?: string | null }
): Promise<void> {
  try {
    if (!messageKey.remoteJid || !messageKey.id) return;
    await sock.readMessages([{
      remoteJid: messageKey.remoteJid,
      id: messageKey.id,
      participant: messageKey.participant || undefined,
    }]);
  } catch {
    // Non-fatal
  }
}

// ─── Sleep hours ───────────────────────────────────────────────────────────

/**
 * Alfred sleeps roughly 11pm-7am ET local time. During sleep hours he still
 * receives messages but delays outbound broadcasts and doesn't show typing.
 * Real humans sleep - so should Alfred (for the appearance of humanity).
 * Returns true if Alfred is currently "asleep".
 */
export function isAlfredAsleep(now: Date = new Date()): boolean {
  // Toronto (ET) hours. Simple offset - assumes system clock is UTC.
  // TODO: proper timezone handling via Intl.DateTimeFormat when needed.
  const etOffsetHours = isDaylightSavings(now) ? -4 : -5;
  const localHour = (now.getUTCHours() + etOffsetHours + 24) % 24;
  // Sleep: 11pm - 6:45am with a bit of jitter (some nights Alfred stays up)
  const random = Math.random();
  const isCoreSleep = localHour >= 23 || localHour < 6;
  const isEdge = localHour === 6 && random < 0.5;
  return isCoreSleep || isEdge;
}

function isDaylightSavings(d: Date): boolean {
  // Rough US/CA DST approximation - March second Sunday to November first Sunday.
  const month = d.getUTCMonth();
  return month >= 2 && month <= 10; // Mar-Nov, close enough for sleep hours
}

// ─── Message chunking + variance ───────────────────────────────────────────

/**
 * Split a long reply into 2-3 natural chunks that get sent with human bursts
 * between them, sometimes. Not always - about 25% of the time for messages
 * over 200 chars we split in two, and 10% of the time (of those) we go a
 * step further and split into 3 chunks. Real humans do this occasionally.
 */
export function maybeChunkReply(text: string): string[] {
  if (text.length < 200) return [text];
  if (Math.random() > 0.25) return [text];

  // Try to chunk at sentence boundaries
  const sentences = text.split(/(?<=[.?])\s+/);
  if (sentences.length < 2) return [text];

  // 10% of the time (of splits) go 3 chunks if we have enough sentences.
  const wantThree = sentences.length >= 3 && Math.random() < 0.1;
  if (wantThree) {
    const third = Math.floor(sentences.length / 3);
    const twoThirds = Math.floor((sentences.length * 2) / 3);
    const a = sentences.slice(0, third).join(" ");
    const b = sentences.slice(third, twoThirds).join(" ");
    const c = sentences.slice(twoThirds).join(" ");
    if (a && b && c) return [a, b, c];
  }

  // Split roughly in half by sentence count
  const mid = Math.floor(sentences.length / 2);
  const first = sentences.slice(0, mid).join(" ");
  const second = sentences.slice(mid).join(" ");
  if (!first || !second) return [text];
  return [first, second];
}

// ─── Behavioural filters (probabilistic humanity) ──────────────────────────

/**
 * Probabilistic "human ignore" filter. Real people in a group chat don't
 * respond to every message directed at them. Returns true when Alfred
 * should stay silent even if the message would otherwise qualify for a
 * reply.
 *
 * Rates:
 *   - very short casual (under 20 chars, "lol", "ok", "sure"): 8-12%
 *   - medium messages: 3%
 *   - long or tagged direct questions: 0% (never ignore)
 *
 * @param text - the incoming message text
 */
export function shouldAlfredIgnore(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  const len = trimmed.length;

  // Tagged direct questions or slash commands always get a reply - never ignore.
  if (trimmed.startsWith("/")) return false;
  if (/@alfred/i.test(trimmed)) return false;
  if (trimmed.endsWith("?")) return false;

  if (len < 20) {
    // 8-12% ignore rate - randomize inside the band each call so it isn't
    // a fixed rate that a detector could fingerprint.
    const p = 0.08 + Math.random() * 0.04;
    return Math.random() < p;
  }
  if (len < 200) {
    return Math.random() < 0.03;
  }
  return false;
}

/**
 * Occasionally return a WhatsApp REACTION emoji so Alfred can react to a
 * king's message like a real person would. This is the ONE place emojis
 * are allowed - WhatsApp reactions ARE emojis by API design, not text
 * output. Returns null most of the time (95%).
 */
export function randomEmoji(): string | null {
  if (Math.random() >= 0.05) return null;
  const pool = ["\u{1F44D}", "❤️", "\u{1F602}", "\u{1F64F}", "\u{1F4AF}", "\u{1F525}"];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * Send a WhatsApp reaction to a specific message. Uses Baileys' reaction
 * shape. Non-fatal on failure.
 */
export async function reactToMessage(
  sock: WASocket,
  msgKey: { remoteJid: string | null | undefined; id: string | null | undefined; participant?: string | null; fromMe?: boolean },
  emoji: string
): Promise<void> {
  try {
    if (!msgKey.remoteJid || !msgKey.id) return;
    await sock.sendMessage(msgKey.remoteJid, {
      react: {
        text: emoji,
        key: {
          remoteJid: msgKey.remoteJid,
          id: msgKey.id,
          participant: msgKey.participant || undefined,
          fromMe: msgKey.fromMe || false,
        },
      },
    });
  } catch {
    // Non-fatal
  }
}

/**
 * 15% chance of prepending a small natural filler like "Hmm. ", "One moment. ",
 * "Aye. ", "Well then. " - mimics human hesitation. Only applied to
 * medium-plus replies (over 100 chars). Filler is intentionally understated
 * and never uses em dashes, exclamation marks, or emojis.
 */
export function humanIntroInsertion(text: string): string {
  if (!text || text.length <= 100) return text;
  if (Math.random() >= 0.15) return text;
  const openers = ["Hmm. ", "One moment. ", "Aye. ", "Well then. ", "Right. ", "Okay. "];
  const opener = openers[Math.floor(Math.random() * openers.length)];
  return `${opener}${text}`;
}

// ─── Availability state ────────────────────────────────────────────────────

/**
 * Alfred's high-level availability. Real people cycle through activity
 * states across the day - "always online" is a bot tell.
 *
 *   active:  9am-6pm ET  -> full response
 *   busy:    6pm-11pm ET -> replies, but slower and more terse
 *   afk:     6:45am-8am ET -> rare responses, briefer
 *   asleep:  11pm-6:45am ET -> silent unless emergency slash command
 */
export type AlfredAvailability = "active" | "busy" | "afk" | "asleep";

export function getAlfredAvailabilityState(now: Date = new Date()): AlfredAvailability {
  const etOffsetHours = isDaylightSavings(now) ? -4 : -5;
  const localHour = (now.getUTCHours() + etOffsetHours + 24) % 24;
  const localMinute = now.getUTCMinutes();
  // Fractional hour for finer boundary checks (e.g. 6:45)
  const localFractional = localHour + localMinute / 60;

  // 11pm - 6:45am -> asleep
  if (localFractional >= 23 || localFractional < 6.75) return "asleep";
  // 6:45am - 8am -> afk (waking up)
  if (localFractional < 8) return "afk";
  // 8am - 9am -> also afk-ish edge (rare responses)
  if (localFractional < 9) return "afk";
  // 9am - 6pm -> active
  if (localFractional < 18) return "active";
  // 6pm - 11pm -> busy
  return "busy";
}
