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
export type ResponseDecision = "explicit" | "relevant" | "silent";

/**
 * Decides Alfred's response mode for an incoming message.
 *
 * "explicit"  - Alfred is directly named or given a slash command. He MUST
 *               respond promptly and helpfully.
 * "relevant"  - Message mentions an org topic Alfred owns (ads, bookings,
 *               prospects, spend, sentinel, security, deploys, kings, etc).
 *               Alfred is invited to consider whether to add value. The FK
 *               server-side prompt tells Alfred he may STAY SILENT if he
 *               has nothing to add; otherwise he weighs in with judgment.
 * "silent"    - Neither of the above. Alfred still logs to knowledge base
 *               but does not respond.
 */
export function decideResponseMode(text: string): ResponseDecision {
  if (!text) return "silent";
  const raw = text.trim();
  if (!raw) return "silent";

  if (raw.startsWith("/")) return "explicit";

  const lower = raw.toLowerCase();
  if (lower.includes("@alfred")) return "explicit";
  if (/^alfred[\s,:.]/i.test(raw)) return "explicit";
  if (/^alfred$/i.test(raw)) return "explicit";
  if (/^(hey|yo|hi|hello|yes|ok|okay)\s+alfred\b/i.test(raw)) return "explicit";
  if (/,\s*alfred\s*[?.!]?\s*$/i.test(raw)) return "explicit";
  if (/\balfred\b/i.test(lower)) return "explicit"; // any mention of alfred by name

  // Relevance keywords: org-topics Alfred owns. Case-insensitive whole-word.
  const relevanceRegex = new RegExp(
    "\\b(" +
      [
        // Ads / marketing
        "ad", "ads", "advert", "campaign", "campaigns", "meta", "facebook", "instagram",
        "cpa", "cpm", "ctr", "roas", "spend", "budget", "creative", "targeting",
        // Bookings / calendar
        "booking", "bookings", "call", "calls", "meeting", "meetings", "calendar",
        "fit-call", "fit call", "reschedule", "cancel",
        // Prospects / sales
        "prospect", "prospects", "lead", "leads", "deal", "deals", "pipeline",
        "outreach", "edgar", "issuer", "issuers",
        // Metrics / revenue
        "revenue", "mrr", "arr", "conversion", "conversions", "profit", "margin",
        // Product / crowdfunding
        "reg d", "reg cf", "506c", "506\\(c\\)", "crowdfunding", "fractionalize",
        "wefunder", "republic", "startengine", "raise", "raises",
        // Ops / security
        "deploy", "deployed", "deployment", "sentinel", "site doctor", "error",
        "errors", "vercel", "sentry",
        // FK-specific
        "fraction kings", "freeman filing", "council",
      ].join("|") +
      ")\\b",
    "i",
  );
  if (relevanceRegex.test(raw)) return "relevant";

  return "silent";
}

/**
 * Legacy boolean wrapper. Returns true if the message triggers ANY response
 * (explicit or relevant). Preserved for existing callers.
 */
export function shouldAlfredRespond(text: string, _myPhoneE164: string): boolean {
  return decideResponseMode(text) !== "silent";
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
