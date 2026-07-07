/**
 * Abuse + cost-bomb protection.
 *
 * Every inbound message costs money (Claude API for chat, Whisper for voice
 * STT, TTS for spoken replies, Scribe for code changes). If nothing gates
 * those calls, a single malicious actor with a WhatsApp handle in one of
 * Maximus's groups could burn hundreds of dollars a day.
 *
 * This module runs BEFORE the FK call so blocked messages cost nothing.
 *
 * Layers (all in one place, in the order they run):
 *
 *   1. Persistent blocklist. Phones on the blocklist are dropped immediately,
 *      no FK call, no Tyler alert (they already got their one).
 *
 *   2. Global throughput cap. Total messages Maximus processes per hour is
 *      capped at ALFRED_ABUSE_GLOBAL_MSGS_PER_HOUR (default 200). If tripped,
 *      Maximus goes into "cool-down" and drops silently. Tyler gets one alert.
 *
 *   3. Per-sender text rate limit. Any single sender phone is capped at
 *      ALFRED_ABUSE_SENDER_MSGS_PER_HOUR (default 20). Trip = drop + one
 *      warning to Tyler + violation counter++.
 *
 *   4. Per-sender voice rate limit. Voice notes are the most expensive
 *      surface (Whisper + Claude + TTS). Cap ALFRED_ABUSE_VOICE_PER_HOUR
 *      (default 5) per sender.
 *
 *   5. Global daily cost budget (soft). Every message increments a
 *      day-counter with a rough token cost estimate. If we cross
 *      ALFRED_ABUSE_DAILY_USD_CAP (default 20), Maximus silences until
 *      midnight UTC and pings Tyler.
 *
 *   6. Auto-block after N violations. Any sender that trips a rate-limit
 *      ALFRED_ABUSE_AUTO_BLOCK_STRIKES (default 3) times in a week gets
 *      added to the persistent blocklist automatically.
 *
 * All caps are env-tunable so Tyler can loosen or tighten without a rebuild.
 * The persistent blocklist lives at /data/blocklist.txt (one E.164-digits-only
 * phone per line) so it survives container restart.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import type { Logger } from "./logger.js";
import { maybeAlertTylerAboutStranger } from "./stranger-alerts.js";

// ─── Tunables (env-overridable) ────────────────────────────────────────────

const GLOBAL_MSGS_PER_HOUR = Number((process.env.MAXIMUS_ABUSE_GLOBAL_MSGS_PER_HOUR || process.env.ALFRED_ABUSE_GLOBAL_MSGS_PER_HOUR) || 200);
const SENDER_MSGS_PER_HOUR = Number((process.env.MAXIMUS_ABUSE_SENDER_MSGS_PER_HOUR || process.env.ALFRED_ABUSE_SENDER_MSGS_PER_HOUR) || 20);
const VOICE_PER_HOUR = Number((process.env.MAXIMUS_ABUSE_VOICE_PER_HOUR || process.env.ALFRED_ABUSE_VOICE_PER_HOUR) || 5);
const DAILY_USD_CAP = Number((process.env.MAXIMUS_ABUSE_DAILY_USD_CAP || process.env.ALFRED_ABUSE_DAILY_USD_CAP) || 20);
const AUTO_BLOCK_STRIKES = Number((process.env.MAXIMUS_ABUSE_AUTO_BLOCK_STRIKES || process.env.ALFRED_ABUSE_AUTO_BLOCK_STRIKES) || 3);
const VIOLATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Rough per-request cost estimates (USD). Order-of-magnitude; better than nothing.
const COST_ESTIMATE_TEXT_USD = 0.06;   // one Claude chat round-trip
const COST_ESTIMATE_VOICE_USD = 0.15;  // Whisper + Claude + TTS

// ─── In-process state ──────────────────────────────────────────────────────

const BLOCKLIST_PATH = (process.env.MAXIMUS_BLOCKLIST_PATH || process.env.ALFRED_BLOCKLIST_PATH) || "/data/blocklist.txt";
const VIOLATIONS_LOG = (process.env.MAXIMUS_VIOLATIONS_LOG || process.env.ALFRED_VIOLATIONS_LOG) || "/data/violations.jsonl";
const blocklist = new Set<string>();
let blocklistLoaded = false;

// Per-sender text timestamps (sliding hour window).
const senderText: Map<string, number[]> = new Map();
// Per-sender voice timestamps.
const senderVoice: Map<string, number[]> = new Map();
// Per-sender violation timestamps (sliding week window).
const senderViolations: Map<string, number[]> = new Map();
// Global throughput window.
const globalMessages: number[] = [];
// Daily cost tracking (resets at UTC midnight).
let dailySpendUsd = 0;
let dailySpendDate = new Date().toISOString().slice(0, 10);

// Flags so we only DM Tyler ONCE per event class per day.
let alertedGlobalCap = false;
let alertedCostCap = false;

// ─── Public API ────────────────────────────────────────────────────────────

export type AbuseVerdict =
  | { allow: true }
  | { allow: false; reason: string; sendTylerAlert: boolean; senderPhone: string };

export interface AbuseCheckInput {
  senderPhone: string;   // E.164 digits only, no leading + or @suffix
  senderName?: string | null;
  kind: "text" | "voice";
  groupJid: string;
  textPreview?: string;
  logger: Logger;
}

/**
 * Main entry point. Call this BEFORE any FK dispatch. Returns {allow: true}
 * if the message may be processed, or {allow:false, ...} if it must be dropped.
 * When allow=false, the caller SHOULD:
 *   - not forward the message anywhere
 *   - fire alertTylerAboutAbuse(...) if sendTylerAlert === true
 */
export async function checkAbuse(input: AbuseCheckInput): Promise<AbuseVerdict> {
  const now = Date.now();
  const key = normalizePhone(input.senderPhone) || "unknown";

  // Reset daily counters at UTC midnight.
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailySpendDate) {
    dailySpendUsd = 0;
    dailySpendDate = today;
    alertedGlobalCap = false;
    alertedCostCap = false;
  }

  // Layer 1: persistent blocklist.
  await ensureBlocklistLoaded(input.logger);
  if (blocklist.has(key)) {
    return { allow: false, reason: "sender on persistent blocklist", sendTylerAlert: false, senderPhone: key };
  }

  // Layer 2: global throughput cap (all senders combined).
  pruneOlderThan(globalMessages, now - HOUR_MS);
  if (globalMessages.length >= GLOBAL_MSGS_PER_HOUR) {
    if (!alertedGlobalCap) {
      alertedGlobalCap = true;
      await recordViolation({ senderPhone: key, reason: "global-throughput-cap", logger: input.logger });
      return { allow: false, reason: `global cap ${GLOBAL_MSGS_PER_HOUR}/hr hit - Maximus cooling down`, sendTylerAlert: true, senderPhone: key };
    }
    return { allow: false, reason: "global cap - cooldown", sendTylerAlert: false, senderPhone: key };
  }

  // Layer 3: per-sender text rate limit.
  const textTimes = senderText.get(key) ?? [];
  pruneOlderThan(textTimes, now - HOUR_MS);
  if (input.kind === "text") {
    if (textTimes.length >= SENDER_MSGS_PER_HOUR) {
      await recordViolation({ senderPhone: key, reason: "per-sender-text-cap", logger: input.logger });
      if (await maybeAutoBlock(key, input.logger)) {
        return { allow: false, reason: "auto-blocked after repeat violations", sendTylerAlert: true, senderPhone: key };
      }
      return { allow: false, reason: `sender exceeded ${SENDER_MSGS_PER_HOUR} msgs/hr`, sendTylerAlert: true, senderPhone: key };
    }
    textTimes.push(now);
    senderText.set(key, textTimes);
  }

  // Layer 4: per-sender voice rate limit.
  const voiceTimes = senderVoice.get(key) ?? [];
  pruneOlderThan(voiceTimes, now - HOUR_MS);
  if (input.kind === "voice") {
    if (voiceTimes.length >= VOICE_PER_HOUR) {
      await recordViolation({ senderPhone: key, reason: "per-sender-voice-cap", logger: input.logger });
      if (await maybeAutoBlock(key, input.logger)) {
        return { allow: false, reason: "auto-blocked after repeat voice-cap violations", sendTylerAlert: true, senderPhone: key };
      }
      return { allow: false, reason: `sender exceeded ${VOICE_PER_HOUR} voice notes/hr`, sendTylerAlert: true, senderPhone: key };
    }
    voiceTimes.push(now);
    senderVoice.set(key, voiceTimes);
  }

  // Layer 5: daily cost budget (soft cap based on rough estimate).
  const cost = input.kind === "voice" ? COST_ESTIMATE_VOICE_USD : COST_ESTIMATE_TEXT_USD;
  if (dailySpendUsd + cost > DAILY_USD_CAP) {
    if (!alertedCostCap) {
      alertedCostCap = true;
      return { allow: false, reason: `daily cost cap $${DAILY_USD_CAP} projected to be exceeded`, sendTylerAlert: true, senderPhone: key };
    }
    return { allow: false, reason: "daily cost cap - silent until midnight UTC", sendTylerAlert: false, senderPhone: key };
  }

  // All gates passed - reserve the cost + record throughput.
  dailySpendUsd += cost;
  globalMessages.push(now);
  return { allow: true };
}

/**
 * Send Tyler a DM when abuse protection tripped and this specific event
 * warrants notification. Uses the same rate-limited stranger-alert path so
 * Tyler still isn't spammed.
 */
export async function alertTylerAboutAbuse(input: {
  sock: WASocket;
  senderPhone: string;
  senderName?: string | null;
  reason: string;
  preview?: string;
  logger: Logger;
}): Promise<void> {
  const fromJid = `${input.senderPhone}@s.whatsapp.net`;
  await maybeAlertTylerAboutStranger({
    sock: input.sock,
    kind: "dm_to_maximus",
    fromJid,
    fromName: input.senderName ?? null,
    preview: `[ABUSE-GATE] ${input.reason}. ${input.preview ? `Last msg: "${input.preview}"` : ""}`,
    logger: input.logger,
  });
}

// ─── Blocklist helpers ─────────────────────────────────────────────────────

export async function loadBlocklist(): Promise<void> {
  if (!existsSync(BLOCKLIST_PATH)) return;
  try {
    const raw = await readFile(BLOCKLIST_PATH, "utf8");
    for (const line of raw.split("\n")) {
      const p = normalizePhone(line);
      if (p) blocklist.add(p);
    }
    blocklistLoaded = true;
  } catch {
    // ignore
  }
}

async function ensureBlocklistLoaded(logger: Logger): Promise<void> {
  if (blocklistLoaded) return;
  try {
    await loadBlocklist();
  } catch (err) {
    logger.warn({ err }, "Failed loading blocklist - starting empty");
  }
  blocklistLoaded = true;
}

export async function addToBlocklist(phone: string, logger: Logger): Promise<void> {
  const p = normalizePhone(phone);
  if (!p || blocklist.has(p)) return;
  blocklist.add(p);
  try {
    await mkdir(path.dirname(BLOCKLIST_PATH), { recursive: true });
    await appendFile(BLOCKLIST_PATH, `${p}\n`, "utf8");
    logger.info({ phone: p }, "Added phone to persistent blocklist");
  } catch (err) {
    logger.error({ err, phone: p }, "Failed to persist blocklist entry");
  }
}

export async function removeFromBlocklist(phone: string, logger: Logger): Promise<void> {
  const p = normalizePhone(phone);
  if (!p) return;
  blocklist.delete(p);
  try {
    if (!existsSync(BLOCKLIST_PATH)) return;
    const raw = await readFile(BLOCKLIST_PATH, "utf8");
    const filtered = raw.split("\n").filter((line) => normalizePhone(line) !== p);
    await writeFile(BLOCKLIST_PATH, filtered.join("\n"), "utf8");
    logger.info({ phone: p }, "Removed phone from persistent blocklist");
  } catch (err) {
    logger.error({ err, phone: p }, "Failed to rewrite blocklist");
  }
}

// ─── Violation counter + auto-block ────────────────────────────────────────

async function recordViolation(input: { senderPhone: string; reason: string; logger: Logger }): Promise<void> {
  const p = normalizePhone(input.senderPhone) || "unknown";
  const times = senderViolations.get(p) ?? [];
  pruneOlderThan(times, Date.now() - VIOLATION_WINDOW_MS);
  times.push(Date.now());
  senderViolations.set(p, times);
  try {
    await mkdir(path.dirname(VIOLATIONS_LOG), { recursive: true });
    await appendFile(
      VIOLATIONS_LOG,
      JSON.stringify({ at: new Date().toISOString(), phone: p, reason: input.reason }) + "\n",
      "utf8",
    );
  } catch (err) {
    input.logger.warn({ err }, "Failed to write violation log line");
  }
}

async function maybeAutoBlock(phone: string, logger: Logger): Promise<boolean> {
  const p = normalizePhone(phone) || "unknown";
  const times = senderViolations.get(p) ?? [];
  pruneOlderThan(times, Date.now() - VIOLATION_WINDOW_MS);
  if (times.length < AUTO_BLOCK_STRIKES) return false;
  await addToBlocklist(p, logger);
  logger.warn({ phone: p, strikes: times.length }, "Auto-blocked sender after repeat violations");
  return true;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/^\+/, "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

function pruneOlderThan(arr: number[], cutoff: number): void {
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

// ─── Introspection (for /health or admin ops) ──────────────────────────────

export function getAbuseSnapshot(): {
  blocklistSize: number;
  globalMsgsLastHour: number;
  activeSenders: number;
  dailySpendUsd: number;
  dailySpendDate: string;
  dailyCapUsd: number;
} {
  pruneOlderThan(globalMessages, Date.now() - HOUR_MS);
  return {
    blocklistSize: blocklist.size,
    globalMsgsLastHour: globalMessages.length,
    activeSenders: senderText.size,
    dailySpendUsd: Number(dailySpendUsd.toFixed(4)),
    dailySpendDate,
    dailyCapUsd: DAILY_USD_CAP,
  };
}
