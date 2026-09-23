export const TIME_ZONE = "America/Toronto";

const dateTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "";
  return dateTime.format(typeof d === "string" ? new Date(d) : d);
}

/** Today's date in Ontario as YYYY-MM-DD, for comparing against insurance expiry dates. */
export function todayInToronto(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}
