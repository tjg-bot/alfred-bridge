/**
 * WhatsApp voice-note helpers for the Baileys bridge.
 *
 * Inbound: Baileys ships incoming audio as encrypted references; we decrypt
 * + fetch the audio bytes via downloadMediaMessage, then base64 the buffer
 * so the FK backend can POST it to Whisper.
 *
 * Outbound: FK returns a base64 opus buffer from OpenAI TTS. We decode +
 * hand it to sock.sendMessage with ptt: true so WhatsApp renders it as a
 * proper "voice note" bubble (waveform + play button), not a document.
 */

import {
  downloadMediaMessage,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import type { Logger } from "./logger.js";

const DEFAULT_MIME = "audio/ogg; codecs=opus";

export interface IncomingAudio {
  base64: string;
  mimeType: string;
}

/**
 * Download an incoming WhatsApp audio message and return it as base64. Returns
 * null when the message is not an audio message or the download fails.
 */
export async function downloadIncomingAudio(
  msg: WAMessage,
  _sock: WASocket,
  logger?: Logger,
): Promise<IncomingAudio | null> {
  try {
    const audioMsg = msg.message?.audioMessage;
    if (!audioMsg) return null;

    const buffer = (await downloadMediaMessage(
      msg,
      "buffer",
      {},
    )) as Buffer;

    if (!buffer || buffer.length === 0) {
      logger?.warn({ messageId: msg.key?.id }, "downloadIncomingAudio: empty buffer");
      return null;
    }

    return {
      base64: buffer.toString("base64"),
      mimeType: audioMsg.mimetype || DEFAULT_MIME,
    };
  } catch (err) {
    logger?.error({ err, messageId: msg.key?.id }, "downloadIncomingAudio failed");
    return null;
  }
}

/**
 * Send a voice note (push-to-talk / ptt) into a WhatsApp chat. The audio must
 * be opus in an ogg container for WhatsApp to render the waveform bubble
 * correctly; ptt: true is what makes it look like a real voice note versus a
 * generic audio attachment.
 */
export async function sendVoiceNote(
  sock: WASocket,
  jid: string,
  audioBase64: string,
  mimeType?: string,
): Promise<void> {
  const buffer = Buffer.from(audioBase64, "base64");
  await sock.sendMessage(jid, {
    audio: buffer,
    mimetype: mimeType || DEFAULT_MIME,
    ptt: true,
  });
}
