import { readFileSync } from "node:fs";
import { z } from "zod";

const coverageSchema = z.object({
  towns: z.array(z.string().min(1)),
  // Postal code prefixes we serve, e.g. "N0B 1T" or "N0B". Matched against the code with spaces removed.
  postalPrefixes: z.array(z.string()),
});

export type CoverageConfig = z.infer<typeof coverageSchema>;

export function loadCoverage(path: string): CoverageConfig {
  return coverageSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export interface CoverageResult {
  coverage: "in" | "out" | "unknown";
  postalCode: string | null;
  town: string | null;
}

const POSTAL_RE = /\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;

/** Returns "A1A 1A1" or null. */
export function extractPostalCode(text: string | null | undefined): string | null {
  const m = text?.match(POSTAL_RE);
  return m ? `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide whether a location is in the service area.
 * - A postal code is checked against the prefix list. "out" is only returned when a list is configured,
 *   so an empty list never turns real customers away.
 * - Otherwise a covered town name anywhere in the text counts as "in".
 * - Anything else (a bare road name) is "unknown" and left for a human to check.
 */
export function classifyLocation(
  cfg: CoverageConfig,
  locationText: string | null | undefined,
  postalInput?: string | null,
): CoverageResult {
  const postalCode = extractPostalCode(postalInput) ?? extractPostalCode(locationText);
  const town =
    cfg.towns.find((t) => new RegExp(`\\b${escapeRe(t)}\\b`, "i").test(locationText ?? "")) ?? null;

  if (postalCode) {
    const compact = postalCode.replace(/\s/g, "");
    const prefixes = cfg.postalPrefixes.map((p) => p.replace(/\s/g, "").toUpperCase()).filter(Boolean);
    if (prefixes.length === 0) return { coverage: town ? "in" : "unknown", postalCode, town };
    return { coverage: prefixes.some((p) => compact.startsWith(p)) ? "in" : "out", postalCode, town };
  }
  return { coverage: town ? "in" : "unknown", postalCode: null, town };
}
