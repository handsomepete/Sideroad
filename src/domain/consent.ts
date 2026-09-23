/**
 * CASL consent wording. The forms render these exact strings next to the checkbox and the same string is
 * stored with each consent record, so we can always show what someone agreed to.
 * Never edit a published version in place: add a new version and point the form at it.
 */
export const CONSENT = {
  homeowner: {
    version: "homeowner-v1",
    channels: ["sms", "email"],
    text:
      "I agree to receive text messages and emails from Sideroad about this request and about Sideroad's " +
      "services. Message and data rates may apply. I can withdraw consent at any time by replying STOP to a " +
      "text or by emailing Sideroad.",
  },
  trade: {
    version: "trade-v1",
    channels: ["sms", "email"],
    text:
      "I agree to receive text messages and emails from Sideroad about job opportunities and my listing. " +
      "Message and data rates may apply. I can withdraw consent at any time by replying STOP to a text or " +
      "by emailing Sideroad.",
  },
  waitlist: {
    version: "waitlist-v1",
    channels: ["sms", "email"],
    text:
      "I agree to receive a text message or email from Sideroad when it starts serving my area. " +
      "I can withdraw consent at any time by replying STOP to a text or by emailing Sideroad.",
  },
  // Someone who texts us first has made an inquiry. CASL treats that as implied consent to reply about it.
  inboundSms: {
    version: "implied-inquiry-v1",
    channels: ["sms"],
    text: "Implied consent: the person texted Sideroad first with an inquiry.",
  },
} as const;

export type ConsentKind = keyof typeof CONSENT;

export const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "ARRET", "ARRÊT"]);
export const START_KEYWORDS = new Set(["START", "UNSTOP"]);

export function smsKeyword(body: string): "stop" | "start" | null {
  const word = body.trim().replace(/[.!]+$/, "").toUpperCase();
  if (STOP_KEYWORDS.has(word)) return "stop";
  if (START_KEYWORDS.has(word)) return "start";
  return null;
}
