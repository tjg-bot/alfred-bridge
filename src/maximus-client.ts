import { logger } from "./logger.js";

const TIMEOUT_MS = 30_000;
// Voice endpoint needs a much larger window: Whisper transcription (~5s for
// short notes, up to 30s for 5 min audio) + Maximus chat (~10-30s) + optional
// TTS synthesis (~5-20s). 90 sec buffer keeps most cases safe without letting
// a hung upstream stall the bridge forever.
const VOICE_TIMEOUT_MS = 90_000;

function baseUrl(): string {
  const url = (process.env.MAXIMUS_API_URL || process.env.ALFRED_API_URL);
  if (!url) throw new Error("ALFRED_API_URL is not set");
  return url.replace(/\/$/, "");
}

function bearer(): string {
  const secret = (process.env.MAXIMUS_BRIDGE_SECRET || process.env.ALFRED_BRIDGE_SECRET);
  if (!secret) throw new Error("ALFRED_BRIDGE_SECRET is not set");
  return `Bearer ${secret}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export interface AlfredChatResponse {
  text: string;
  pendingAction?: { id: string; displayText: string } | null;
  errorMessage?: string;
}

export interface AlfredExecuteResponse {
  text: string;
  status?: string;
}

export async function postAlfredChat(opts: {
  senderPhone: string;
  senderName: string;
  groupJid: string;
  text: string;
  messageId: string;
}): Promise<AlfredChatResponse> {
  const url = `${baseUrl()}/api/alfred/bridge/chat`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body }, "Maximus chat endpoint returned non-2xx");
    throw new Error(`Maximus chat failed: ${res.status}`);
  }

  return (await res.json()) as AlfredChatResponse;
}

export interface AlfredVoiceResponse {
  ok: boolean;
  text: string;
  transcript?: string;
  audioBase64?: string | null;
  mimeType?: string | null;
  pendingAction?: { id: string; displayText: string } | null;
  errorMessage?: string | null;
}

/**
 * POST a voice note to FK's voice endpoint. FK transcribes via Whisper, runs
 * Maximus's chat, and returns the reply text + (usually) an opus audio blob
 * for the bridge to send back as a WhatsApp voice note.
 */
export async function postAlfredVoice(opts: {
  senderPhone: string;
  senderName: string;
  groupJid: string;
  audioBase64: string;
  mimeType: string;
  messageId: string;
}): Promise<AlfredVoiceResponse> {
  const url = `${baseUrl()}/api/alfred/bridge/voice`;
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: bearer(),
      },
      body: JSON.stringify(opts),
    },
    VOICE_TIMEOUT_MS,
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body }, "Maximus voice endpoint returned non-2xx");
    throw new Error(`Maximus voice failed: ${res.status}`);
  }

  return (await res.json()) as AlfredVoiceResponse;
}

export async function postAlfredExecute(opts: {
  actionId: string;
  confirmed: boolean;
  senderPhone: string;
}): Promise<AlfredExecuteResponse> {
  const url = `${baseUrl()}/api/alfred/bridge/execute`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: bearer(),
    },
    body: JSON.stringify(opts),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.error({ status: res.status, body }, "Maximus execute endpoint returned non-2xx");
    throw new Error(`Maximus execute failed: ${res.status}`);
  }

  return (await res.json()) as AlfredExecuteResponse;
}

/**
 * Best-effort silent log of a group message to FK's knowledge base. Used for
 * messages that Maximus is NOT going to respond to (tag-only mode). Never
 * throws - if the endpoint is missing or unreachable, we log locally and
 * move on. Maximus's silence is the whole point of this path.
 */
export async function postToKnowledgeBase(opts: {
  senderPhone: string;
  senderName: string;
  senderKingEmail?: string | null;
  groupJid: string;
  text: string;
  messageId: string;
}): Promise<void> {
  let url: string;
  let auth: string;
  try {
    url = `${baseUrl()}/api/alfred/bridge/log-only`;
    auth = bearer();
  } catch (err) {
    logger.warn({ err }, "postToKnowledgeBase skipped: missing config");
    return;
  }

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify(opts),
    });
    if (!res.ok) {
      // Silent failure - the endpoint may not exist yet.
      logger.debug(
        { status: res.status, messageId: opts.messageId },
        "log-only endpoint returned non-2xx, ignoring"
      );
    }
  } catch (err) {
    logger.debug({ err, messageId: opts.messageId }, "log-only endpoint unreachable, ignoring");
  }
}

export async function postAlfredHealth(): Promise<{ ok: boolean }> {
  const url = `${baseUrl()}/api/alfred/bridge/health`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { Authorization: bearer() },
  });
  if (!res.ok) return { ok: false };
  try {
    return (await res.json()) as { ok: boolean };
  } catch {
    return { ok: false };
  }
}

export interface UnansweredMessage {
  text: string;
  senderPhone: string;
  senderName: string;
  senderKingEmail: string | null;
  messageId: string | null;
  createdAt: string;
}

/**
 * Ask FK which king messages went unanswered while Maximus was offline. Used
 * on bridge boot so Maximus can catch up like a person returning to their
 * phone. Bridge then replies to each with human pacing.
 */
export async function postAlfredCatchUp(opts: {
  hours?: number;
  maxMessages?: number;
}): Promise<UnansweredMessage[]> {
  const url = `${baseUrl()}/api/alfred/bridge/catch-up`;
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: bearer(), "Content-Type": "application/json" },
      body: JSON.stringify({
        hours: opts.hours ?? 6,
        maxMessages: opts.maxMessages ?? 10,
      }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { unanswered?: UnansweredMessage[] };
    return Array.isArray(data.unanswered) ? data.unanswered : [];
  } catch (err) {
    logger.warn({ err }, "postAlfredCatchUp failed - continuing without catch-up");
    return [];
  }
}
