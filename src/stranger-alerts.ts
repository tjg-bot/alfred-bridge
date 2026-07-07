/**
 * Stranger-alert path.
 *
 * When someone Maximus doesn't recognise reaches out (a DM to his number, or
 * a message in a group that isn't allow-listed), Maximus stays silent to
 * THEM (never reveals his presence) but sends Tyler a direct WhatsApp
 * message with context so Tyler can decide whether to engage. Includes
 * per-sender dedup and a global cap so a spammer can't flood Tyler.
 *
 * This module lives in the bridge because only the bridge can send raw
 * WhatsApp messages via Baileys.
 *
 * Env vars consumed:
 *   ALFRED_ALERT_TARGET_PHONE - E.164 without leading + (e.g. 16478535829).
 *                               When unset, alerts are logged only.
 *   ALFRED_ALERT_PER_SENDER_TTL_MS  - default 6h. Dedup window per sender.
 *   ALFRED_ALERT_GLOBAL_MAX_PER_HOUR - default 10. Cap total alerts to Tyler.
 *   ALFRED_ALERT_SPAM_THRESHOLD - default 3. Msgs in 10 min from same sender
 *                                 that flip alert into "spam" flavour.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "./logger.js";

const PER_SENDER_TTL_MS = Number((process.env.MAXIMUS_ALERT_PER_SENDER_TTL_MS || process.env.ALFRED_ALERT_PER_SENDER_TTL_MS) || 6 * 60 * 60 * 1000);
const GLOBAL_MAX_PER_HOUR = Number((process.env.MAXIMUS_ALERT_GLOBAL_MAX_PER_HOUR || process.env.ALFRED_ALERT_GLOBAL_MAX_PER_HOUR) || 10);
const SPAM_THRESHOLD = Number((process.env.MAXIMUS_ALERT_SPAM_THRESHOLD || process.env.ALFRED_ALERT_SPAM_THRESHOLD) || 3);
const SPAM_WINDOW_MS = 10 * 60 * 1000;

// Per-sender last-alerted timestamp so a repeat msg from the same person
// doesn't page Tyler more than once per PER_SENDER_TTL_MS.
const lastAlertBySender = new Map<string, number>();

// Sliding window of Tyler alerts in the last hour. Enforces GLOBAL_MAX_PER_HOUR.
const alertsThisHour: number[] = [];

// Track raw message timestamps per sender so we can classify a burst as spam.
const messagesBySender = new Map<string, number[]>();

function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/^\+/, "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

function tylerAlertJid(): string | null {
  const phone = normalizePhone((process.env.MAXIMUS_ALERT_TARGET_PHONE || process.env.ALFRED_ALERT_TARGET_PHONE));
  if (!phone) return null;
  return `${phone}@s.whatsapp.net`;
}

function checkGlobalRate(): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  while (alertsThisHour.length > 0 && alertsThisHour[0] < cutoff) alertsThisHour.shift();
  if (alertsThisHour.length >= GLOBAL_MAX_PER_HOUR) return false;
  return true;
}

function markAlertSent(): void {
  alertsThisHour.push(Date.now());
}

function classifyBurst(senderKey: string): { count: number; isSpam: boolean } {
  const now = Date.now();
  const arr = messagesBySender.get(senderKey) ?? [];
  const trimmed = arr.filter((t) => now - t < SPAM_WINDOW_MS);
  trimmed.push(now);
  messagesBySender.set(senderKey, trimmed);
  return { count: trimmed.length, isSpam: trimmed.length >= SPAM_THRESHOLD };
}

/**
 * Whether we should send an alert about this sender right now. Handles per-
 * sender TTL + global hourly cap.
 */
function shouldAlertNow(senderKey: string): boolean {
  const now = Date.now();
  const prior = lastAlertBySender.get(senderKey);
  if (prior && now - prior < PER_SENDER_TTL_MS) return false;
  if (!checkGlobalRate()) return false;
  return true;
}

function buildAlertText(input: {
  kind: "dm_to_maximus" | "wrong_group";
  fromName?: string | null;
  fromPhone?: string | null;
  fromJid: string;
  preview: string;
  burstCount: number;
  isSpam: boolean;
}): string {
  const identity = input.fromName
    ? `${input.fromName}${input.fromPhone ? ` (+${input.fromPhone})` : ""}`
    : input.fromPhone
    ? `+${input.fromPhone}`
    : input.fromJid;

  const preview = input.preview
    ? `"${input.preview.slice(0, 240)}${input.preview.length > 240 ? "..." : ""}"`
    : "(no text content)";

  if (input.isSpam) {
    return [
      `Milord, a persistent stranger continueth to knock at mine door.`,
      ``,
      `Sender: ${identity}`,
      `Count: ${input.burstCount} messages within the last ${Math.round(SPAM_WINDOW_MS / 60_000)} minutes`,
      `Latest: ${preview}`,
      ``,
      `I remain silent to them. Their conduct hath the aroma of spam. Shall I continue to ignore, or wouldst thou engage?`,
    ].join("\n");
  }

  if (input.kind === "dm_to_maximus") {
    return [
      `Milord, a stranger hath sent me a private message.`,
      ``,
      `Sender: ${identity}`,
      `Their words: ${preview}`,
      ``,
      `I did not respond. Say the word if thou wouldst have me engage, or ignore and I shall stay silent.`,
    ].join("\n");
  }

  return [
    `Milord, a message arrived from a group I do not serve.`,
    ``,
    `Group / sender: ${identity}`,
    `Preview: ${preview}`,
    ``,
    `I stayed silent. Escalate if this is a group I should be added to.`,
  ].join("\n");
}

export interface StrangerAlertInput {
  sock: WASocket;
  kind: "dm_to_maximus" | "wrong_group";
  fromJid: string;
  fromName?: string | null;
  preview: string;
  logger: Logger;
}

/**
 * Fire-and-forget. Logs a warning if silently dropped (env unset, deduped,
 * or global cap hit). Never throws.
 */
export async function maybeAlertTylerAboutStranger(input: StrangerAlertInput): Promise<void> {
  const senderKey = String(input.fromJid || "").trim();
  if (!senderKey) return;

  const burst = classifyBurst(senderKey);

  const targetJid = tylerAlertJid();
  if (!targetJid) {
    input.logger.warn(
      { fromJid: input.fromJid, kind: input.kind },
      "Stranger alert wanted to fire but ALFRED_ALERT_TARGET_PHONE is unset",
    );
    return;
  }

  if (!shouldAlertNow(senderKey)) {
    input.logger.info(
      { fromJid: input.fromJid, kind: input.kind, burstCount: burst.count },
      "Stranger alert suppressed by dedup or global cap",
    );
    return;
  }

  const fromPhone = normalizePhone(senderKey.split("@")[0]);
  const text = buildAlertText({
    kind: input.kind,
    fromName: input.fromName ?? null,
    fromPhone,
    fromJid: input.fromJid,
    preview: input.preview || "",
    burstCount: burst.count,
    isSpam: burst.isSpam,
  });

  try {
    await input.sock.sendMessage(targetJid, { text });
    lastAlertBySender.set(senderKey, Date.now());
    markAlertSent();
    input.logger.info(
      { fromJid: input.fromJid, kind: input.kind, burstCount: burst.count, isSpam: burst.isSpam },
      "Sent stranger alert DM to Tyler",
    );
  } catch (err) {
    input.logger.error({ err, fromJid: input.fromJid }, "Failed to send stranger alert DM");
  }
}
