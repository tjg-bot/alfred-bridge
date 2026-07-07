/**
 * Response filter - decides whether Maximus should reply to a given message.
 *
 * Maximus lives in a group chat with the founding kings. He should behave like
 * a real human colleague: only speaking up when explicitly addressed. Every
 * other message is still logged to the FK knowledge base for context, but
 * Maximus stays silent.
 *
 * A message qualifies for a response only if it:
 *   1. Contains "@maximus" (case-insensitive)
 *   2. Starts with "Maximus," / "Maximus:" / "Maximus " (case-insensitive)
 *   3. Starts with "hey maximus" / "yo maximus" / "hi maximus" (case-insensitive)
 *   4. Ends with a direct question TO Maximus (", maximus?" or ", maximus.")
 *   5. Is a slash command starting with "/"
 *   6. Is a reply to one of Maximus's own messages (handled separately since
 *      that check needs the WA message's quoted-message context, not text).
 *
 * POST-RENAME (2026-07-07): Maximus does NOT respond to "Alfred" in any form.
 * The old name is dead and gone. Kings who slip up and type "hey alfred" get
 * silence back, same as if they'd said any other unrelated name. Only the
 * name "Maximus" triggers a response.
 */

/**
 * Returns true if the given group message text is addressed to Maximus and
 * should trigger a reply. False means Maximus stays silent.
 *
 * @param text - the incoming message text (already trimmed by caller)
 * @param _myPhoneE164 - Maximus's own phone in E.164 digits-only form.
 *                      Reserved for future self-mention matching by phone.
 */
export type ResponseDecision = "explicit" | "relevant" | "silent";

/**
 * Decides Maximus's response mode for an incoming message.
 *
 * "explicit"  - Maximus is directly named or given a slash command. He MUST
 *               respond promptly and helpfully.
 * "relevant"  - Message mentions an org topic Maximus owns (ads, bookings,
 *               prospects, spend, sentinel, security, deploys, kings, etc).
 *               Maximus is invited to consider whether to add value. The FK
 *               server-side prompt tells Maximus he may STAY SILENT if he
 *               has nothing to add; otherwise he weighs in with judgment.
 * "silent"    - Neither of the above. Maximus still logs to knowledge base
 *               but does not respond.
 */
export function decideResponseMode(text: string): ResponseDecision {
  if (!text) return "silent";
  const raw = text.trim();
  if (!raw) return "silent";

  if (raw.startsWith("/")) return "explicit";

  const lower = raw.toLowerCase();
  if (lower.includes("@maximus")) return "explicit";
  if (/^maximus[\s,:.]/i.test(raw)) return "explicit";
  if (/^maximus$/i.test(raw)) return "explicit";
  if (/^(hey|yo|hi|hello|yes|ok|okay)\s+maximus\b/i.test(raw)) return "explicit";
  if (/,\s*maximus\s*[?.!]?\s*$/i.test(raw)) return "explicit";
  if (/\bmaximus\b/i.test(lower)) return "explicit"; // any mention of Maximus by name

  // Relevance keywords: org-topics Maximus owns. Case-insensitive whole-word.
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
export function shouldMaximusRespond(text: string, _myPhoneE164: string): boolean {
  return decideResponseMode(text) !== "silent";
}

/**
 * Manual test cases. Kept inline so we can eyeball the filter's behaviour
 * without wiring up a full test framework. Run manually via `ts-node` or
 * copy into a scratch file to check.
 *
 * Each entry: [input, expectedResult, note]
 *
 * Key post-rename cases: any Alfred variant must return FALSE (silent).
 */
export const shouldMaximusRespondTestCases: Array<[string, boolean, string]> = [
  ["hey guys check this out", false, "casual chat, no mention"],
  ["Maximus, what's the pipeline?", true, "starts with Maximus,"],
  ["Maximus: run the report", true, "starts with Maximus:"],
  ["@Maximus what's up", true, "@Maximus mention"],
  ["/status", true, "slash command"],
  ["/spend today", true, "slash command with args"],
  ["that's fine, Maximus.", true, "trailing direct address period"],
  ["hey maximus come here", true, "hey maximus opener"],
  ["yo maximus", true, "yo maximus"],
  ["hi maximus, quick q", true, "hi maximus opener"],
  ["Maximus", true, "just the name"],
  ["what do you think, maximus?", true, "trailing direct address"],
  ["can you check maximus is running", true, "any mention of maximus by name"],

  // POST-RENAME: Alfred variants MUST all be silent (no response)
  ["alfred can you check the deploy", false, "starts with alfred - MUST BE SILENT post-rename"],
  ["@alfred spend report", false, "@alfred mention - MUST BE SILENT post-rename"],
  ["hey @alfred are you there", false, "@alfred mid-sentence - MUST BE SILENT"],
  ["what do you think, alfred?", false, "trailing direct address to alfred - MUST BE SILENT"],
  ["hey alfred come here", false, "hey alfred opener - MUST BE SILENT"],
  ["yo alfred", false, "yo alfred - MUST BE SILENT"],
  ["hi alfred, quick q", false, "hi alfred opener - MUST BE SILENT"],
  ["alfred was a butler", false, "starts with alfred - MUST BE SILENT post-rename"],
  ["I told alfred yesterday", false, "alfred mid-sentence - MUST BE SILENT"],

  ["lol", false, "short reaction"],
  ["can someone check on this", false, "general question, no address"],
  ["", false, "empty string"],
  ["   ", false, "whitespace only"],
];
