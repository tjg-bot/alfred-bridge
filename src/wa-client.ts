import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type ConnectionState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { Logger } from "./logger.js";
import { downloadIncomingAudio } from "./voice.js";
import { maybeAlertTylerAboutStranger } from "./stranger-alerts.js";

interface BoomLike {
  output?: { statusCode?: number };
}

export interface GroupMessagePayload {
  from: string;
  fromName: string;
  text: string;
  messageId: string;
  groupJid: string;
  /** JID (bare, no resource) of the participant whose message this one quotes,
   *  if any. Used to detect direct replies to Maximus's own messages. */
  quotedParticipant?: string | null;
  /** True if the quoted message was sent by Maximus himself. */
  quotedFromMe?: boolean;
  /** Raw Baileys message key (used for reactions). */
  key?: {
    remoteJid: string | null | undefined;
    id: string | null | undefined;
    participant?: string | null;
    fromMe?: boolean;
  };
  /** Populated when the incoming message is a WhatsApp voice note. When set,
   *  handlers route to FK's /api/alfred/bridge/voice endpoint instead of
   *  /chat, since transcription happens server-side. */
  audio?: {
    base64: string;
    mimeType: string;
  };
}

export interface ButtonReplyPayload {
  from: string;
  fromName: string;
  actionId: string;
  confirmed: boolean;
  groupJid: string;
}

export interface StartOpts {
  authPath: string;
  groupJid: string;                       // legacy: single-group callers
  allowedGroupJids?: string[];            // new: list of allowed groups. If unset, falls back to [groupJid].
  onGroupMessage: (msg: GroupMessagePayload) => Promise<void>;
  onButtonReply: (payload: ButtonReplyPayload) => Promise<void>;
  logger: Logger;
}

export interface WAClient {
  sock: WASocket;
  sendGroupMessage: (jid: string, text: string) => Promise<void>;
  sendGroupInteractive: (
    jid: string,
    text: string,
    buttons: Array<{ id: string; title: string }>
  ) => Promise<void>;
  isConnected: () => boolean;
}

function stripJid(jid: string | undefined | null): string {
  if (!jid) return "";
  return jid.split("@")[0].split(":")[0];
}

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return null;
}

/**
 * Pull the quoted-message context (if any) out of a Baileys message. Used to
 * detect direct replies to Maximus's own messages.
 * Returns null if the message is not a reply.
 */
function extractQuotedContext(msg: WAMessage): { participant: string | null; fromMe: boolean } | null {
  const m = msg.message;
  if (!m) return null;
  const ctx = m.extendedTextMessage?.contextInfo;
  if (!ctx) return null;
  if (!ctx.quotedMessage) return null;
  const participant = ctx.participant || null;
  // Baileys stores fromMe on the quoted key sometimes; fall back to the
  // participant JID compared to the socket's own JID (checked at handler time).
  const fromMe = Boolean(
    (ctx as unknown as { remoteJid?: string; fromMe?: boolean }).fromMe
  );
  return { participant, fromMe };
}

function extractButtonId(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m.interactiveResponseMessage) {
    // Newer button reply format
    const params = m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
    if (params) {
      try {
        const parsed = JSON.parse(params) as { id?: string };
        if (parsed.id) return parsed.id;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

interface SecurityEvent {
  type: "dm_to_alfred" | "wrong_group";
  from: string;
  fromName?: string;
  logger: Logger;
}

/**
 * Best-effort POST of a security event to the Fraction Kings backend. Silent
 * on failure (the FK-side endpoint may 404 until it is built). We still log
 * locally so the event shows up in Fly.io logs.
 */
async function reportSecurityEvent(evt: SecurityEvent): Promise<void> {
  const apiUrl = (process.env.MAXIMUS_API_URL || process.env.ALFRED_API_URL);
  const secret = (process.env.MAXIMUS_BRIDGE_SECRET || process.env.ALFRED_BRIDGE_SECRET);
  if (!apiUrl || !secret) return;
  const url = `${apiUrl.replace(/\/$/, "")}/api/alfred/bridge/security-event`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        type: evt.type,
        from: evt.from,
        fromName: evt.fromName,
        at: new Date().toISOString(),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    evt.logger.debug(
      { err, type: evt.type },
      "Security event POST failed (may be 404 until FK-side is built) - non-fatal"
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function startWhatsappClient(opts: StartOpts): Promise<WAClient> {
  const { authPath, groupJid, onGroupMessage, onButtonReply, logger } = opts;

  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  let connected = false;
  let backoffAttempt = 0;
  let sock: WASocket;

  const createSocket = (): WASocket => {
    const s = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: logger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
      browser: ["Maximus", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
    });

    s.ev.on("creds.update", saveCreds);

    s.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info("QR code received. Scan with WhatsApp -> Linked Devices.");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        connected = true;
        backoffAttempt = 0;
        logger.info({ groupJid }, "WhatsApp connection open");
      }

      if (connection === "close") {
        connected = false;
        const statusCode = (lastDisconnect?.error as BoomLike | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        logger.warn({ statusCode, loggedOut }, "WhatsApp connection closed");

        if (loggedOut) {
          logger.error(
            "WhatsApp session logged out. Delete auth-state dir and re-scan QR to re-pair."
          );
          return;
        }

        const delay = Math.min(2000 * Math.pow(2, backoffAttempt), 30_000);
        backoffAttempt += 1;
        logger.info({ delay, attempt: backoffAttempt }, "Reconnecting after backoff");
        setTimeout(() => {
          sock = createSocket();
        }, delay);
      }
    });

    s.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          // Anti-loop guard: never process messages we sent ourselves.
          if (msg.key.fromMe) continue;

          const remoteJid = msg.key.remoteJid || "";

          // Group-only enforcement: Maximus must never respond to a 1-1 DM.
          // If a message arrives from a non-group JID (no @g.us suffix), we
          // log it as a security event, DM Tyler about the stranger (rate-
          // limited so spam doesn't flood him), and drop the message.
          if (!remoteJid.endsWith("@g.us")) {
            logger.warn(
              {
                securityEvent: "dm_to_alfred",
                from: remoteJid,
                fromName: msg.pushName,
              },
              "Ignoring 1-1 DM to Maximus - group-only enforcement"
            );
            void reportSecurityEvent({
              type: "dm_to_alfred",
              from: remoteJid,
              fromName: msg.pushName || undefined,
              logger,
            });
            void maybeAlertTylerAboutStranger({
              sock: s,
              kind: "dm_to_alfred",
              fromJid: remoteJid,
              fromName: msg.pushName || null,
              preview: extractText(msg) || "",
              logger,
            });
            continue;
          }

          // Discovery mode: when ALFRED_GROUP_JID is unset, log every incoming
          // GROUP chat's JID so we can find the founding kings group JID.
          if (!groupJid) {
            const previewText =
              msg.message.conversation ||
              msg.message.extendedTextMessage?.text ||
              "[non-text]";
            logger.info(
              {
                DISCOVERY: true,
                remoteJid,
                isGroup: true,
                fromName: msg.pushName,
                preview: previewText.slice(0, 60),
              },
              "GROUP JID FOUND. Copy this into ALFRED_GROUP_JID in .env and restart."
            );
            continue;
          }

          const allowedGroupJids = opts.allowedGroupJids && opts.allowedGroupJids.length > 0
            ? opts.allowedGroupJids
            : [groupJid];
          if (!allowedGroupJids.includes(remoteJid)) {
            logger.warn(
              {
                securityEvent: "wrong_group",
                from: remoteJid,
                allowed: allowedGroupJids,
                fromName: msg.pushName,
              },
              "Ignoring message from a group that is not in the allow list"
            );
            void reportSecurityEvent({
              type: "wrong_group",
              from: remoteJid,
              fromName: msg.pushName || undefined,
              logger,
            });
            void maybeAlertTylerAboutStranger({
              sock: s,
              kind: "wrong_group",
              fromJid: remoteJid,
              fromName: msg.pushName || null,
              preview: extractText(msg) || "",
              logger,
            });
            continue;
          }

          const senderJid = msg.key.participant || msg.key.remoteJid || "";
          const from = stripJid(senderJid);
          const fromName = msg.pushName || from;
          const messageId = msg.key.id || "";

          const buttonId = extractButtonId(msg);
          if (buttonId) {
            let actionId = buttonId;
            let confirmed = true;
            if (buttonId.startsWith("confirm_")) {
              actionId = buttonId.slice("confirm_".length);
              confirmed = true;
            } else if (buttonId.startsWith("cancel_")) {
              actionId = buttonId.slice("cancel_".length);
              confirmed = false;
            } else {
              logger.warn({ buttonId }, "Unknown button id format; skipping");
              continue;
            }

            await onButtonReply({
              from,
              fromName,
              actionId,
              confirmed,
              groupJid,
            });
            continue;
          }

          // Voice-note branch: audio messages have no text. Download the
          // audio bytes and route to onGroupMessage with an audio payload
          // instead. The handler decides whether to hit /chat or /voice.
          const audioMsg = msg.message.audioMessage;
          if (audioMsg) {
            const audioPayload = await downloadIncomingAudio(msg, s, logger);
            if (!audioPayload) {
              logger.warn(
                { messageId: msg.key.id },
                "Failed to download voice-note audio, dropping message",
              );
              continue;
            }

            const senderJidV = msg.key.participant || msg.key.remoteJid || "";
            const fromV = stripJid(senderJidV);
            const fromNameV = msg.pushName || fromV;
            const messageIdV = msg.key.id || "";

            await onGroupMessage({
              from: fromV,
              fromName: fromNameV,
              text: "", // filled in server-side after Whisper transcribes
              messageId: messageIdV,
              groupJid,
              quotedParticipant: null,
              quotedFromMe: false,
              key: {
                remoteJid: msg.key.remoteJid,
                id: msg.key.id,
                participant: msg.key.participant,
                fromMe: msg.key.fromMe || false,
              },
              audio: audioPayload,
            });
            continue;
          }

          const text = extractText(msg);
          if (!text || !text.trim()) continue;

          const quoted = extractQuotedContext(msg);
          // Determine if the quoted message was authored by Maximus (this
          // socket's own user). Baileys exposes the socket's user JID on
          // `s.user.id` in the form "<phone>:device@s.whatsapp.net".
          let quotedFromMe = quoted?.fromMe ?? false;
          if (quoted && !quotedFromMe) {
            const myFullJid = s.user?.id;
            const myPhone = myFullJid ? stripJid(myFullJid) : "";
            const quotedPhone = quoted.participant ? stripJid(quoted.participant) : "";
            if (myPhone && quotedPhone && myPhone === quotedPhone) {
              quotedFromMe = true;
            }
          }

          await onGroupMessage({
            from,
            fromName,
            text: text.trim(),
            messageId,
            groupJid,
            quotedParticipant: quoted?.participant ?? null,
            quotedFromMe,
            key: {
              remoteJid: msg.key.remoteJid,
              id: msg.key.id,
              participant: msg.key.participant,
              fromMe: msg.key.fromMe || false,
            },
          });
        } catch (err) {
          logger.error({ err }, "Error handling incoming message");
        }
      }
    });

    return s;
  };

  sock = createSocket();

  const sendGroupMessage = async (jid: string, text: string): Promise<void> => {
    await sock.sendMessage(jid, { text });
  };

  const sendGroupInteractive = async (
    jid: string,
    text: string,
    buttons: Array<{ id: string; title: string }>
  ): Promise<void> => {
    // Baileys buttons message. WhatsApp has been flaky on some button formats,
    // so we fall back to plain text listing the options if buttons fail.
    try {
      await sock.sendMessage(jid, {
        text,
        buttons: buttons.map((b) => ({
          buttonId: b.id,
          buttonText: { displayText: b.title },
          type: 1,
        })),
        headerType: 1,
      } as Parameters<typeof sock.sendMessage>[1]);
    } catch (err) {
      opts.logger.warn({ err }, "Interactive buttons failed, falling back to text");
      const fallback = `${text}\n\nReply with one of:\n${buttons
        .map((b) => `- ${b.title} (${b.id})`)
        .join("\n")}`;
      await sock.sendMessage(jid, { text: fallback });
    }
  };

  return {
    get sock() {
      return sock;
    },
    sendGroupMessage,
    sendGroupInteractive,
    isConnected: () => connected,
  } as WAClient;
}
