/**
 * Response filter - decides whether Alfred should reply to a given message.
 *
 * Alfred lives in a group chat with the founding kings. He should behave like
 * a real human colleague: only speaking up when explicitly addressed. Every
 * other message is still logged to the FK knowledge base for context, but
 * Alfred stays silent.
 *
 * A message qualifies for a response only if it:
 *   1. Contains "@alfred" (case-insensitive)
 *   2. Starts with "Alfred," / "Alfred:" / "Alfred " (case-insensitive)
 *   3. Starts with "hey alfred" / "yo alfred" / "hi alfred" (case-insensitive)
 *   4. Ends with a direct question TO Alfred (", alfred?" or ", alfred.")
 *   5. Is a slash command starting with "/"
 *   6. Is a reply to one of Alfred's own messages (handled separately since
 *      that check needs the WA message's quoted-message context, not text).
 */

/**
 * Returns true if the given group message text is addressed to Alfred and
 * should trigger a reply. False means Alfred stays silent.
 *
 * @param text - the incoming message text (already trimmed by caller)
 * @param _myPhoneE164 - Alfred's own phone in E.164 digits-only form.
 *                      Reserved for future self-mention matching by phone.
 */
export function shouldAlfredRespond(text: string, _myPhoneE164: string): boolean {
  if (!text) return false;
  const raw = text.trim();
  if (!raw) return false;

  // Rule 5: slash commands
  if (raw.startsWith("/")) return true;

  const lower = raw.toLowerCase();

  // Rule 1: @alfred mention anywhere in the message
  if (lower.includes("@alfred")) return true;

  // Rule 2: starts with "Alfred," or "Alfred:" or "Alfred "
  //         (followed by a space, comma, colon, or end-of-string)
  if (/^alfred[\s,:.]/i.test(raw)) return true;
  if (/^alfred$/i.test(raw)) return true;

  // Rule 3: greeting-style opener with Alfred
  if (/^(hey|yo|hi|hello|yes)\s+alfred\b/i.test(raw)) return true;

  // Rule 4: message ends with "..., alfred?" or "..., alfred."
  //         Covers "what do you think, alfred?" style direct address.
  if (/,\s*alfred\s*[?.!]?\s*$/i.test(raw)) return true;

  return false;
}

/**
 * Manual test cases. Kept inline so we can eyeball the filter's behaviour
 * without wiring up a full test framework. Run manually via `ts-node` or
 * copy into a scratch file to check.
 *
 * Each entry: [input, expectedResult, note]
 */
export const shouldAlfredRespondTestCases: Array<[string, boolean, string]> = [
  ["hey guys check this out", false, "casual chat, no mention"],
  ["Alfred, what's the pipeline?", true, "starts with Alfred,"],
  ["alfred can you check the deploy", true, "starts with alfred (space)"],
  ["Alfred: run the report", true, "starts with Alfred:"],
  ["@alfred spend report", true, "@alfred mention"],
  ["@Alfred what's up", true, "@Alfred case variant"],
  ["hey @alfred are you there", true, "@alfred mid-sentence"],
  ["/status", true, "slash command"],
  ["/spend today", true, "slash command with args"],
  ["what do you think, alfred?", true, "trailing direct address"],
  ["that's fine, Alfred.", true, "trailing direct address period"],
  ["hey alfred come here", true, "hey alfred opener"],
  ["yo alfred", true, "yo alfred"],
  ["hi alfred, quick q", true, "hi alfred opener"],
  ["Alfred", true, "just the name"],
  ["alfred was a butler", true, "starts with 'alfred ' - spec says respond"],
  ["I told alfred yesterday", false, "alfred mid-sentence, no @, not opener"],
  ["lol", false, "short reaction"],
  ["can someone check on this", false, "general question, no address"],
  ["", false, "empty string"],
  ["   ", false, "whitespace only"],
];
