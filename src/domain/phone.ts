import { parsePhoneNumberFromString } from "libphonenumber-js";

/** Normalize a North American number to E.164 (+15195550100), or null if it isn't a valid number. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), "CA");
  if (!parsed || !parsed.isValid() || parsed.countryCallingCode !== "1") return null;
  return parsed.number;
}

/** "(519) 555-0100" for display. Falls back to the raw value. */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  return parsePhoneNumberFromString(e164)?.formatNational() ?? e164;
}
