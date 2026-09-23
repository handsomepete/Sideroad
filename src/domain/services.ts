export const SERVICES = [
  { slug: "snow", label: "Snow clearing" },
  { slug: "septic", label: "Septic" },
  { slug: "tree", label: "Tree work" },
  { slug: "hvac", label: "Heating and HVAC" },
  { slug: "pond", label: "Pond care" },
  { slug: "well", label: "Wells and water" },
  { slug: "other", label: "Something else" },
] as const;

export type ServiceSlug = (typeof SERVICES)[number]["slug"];

export const SERVICE_SLUGS = SERVICES.map((s) => s.slug) as [ServiceSlug, ...ServiceSlug[]];

/** Services a trade can offer ("Something else" is homeowner-only). */
export const TRADE_SERVICES = SERVICES.filter((s) => s.slug !== "other");

export function serviceLabel(slug: string | null | undefined): string {
  if (!slug) return "Unknown";
  return SERVICES.find((s) => s.slug === slug)?.label ?? slug;
}

/** Accept either a slug or the visible label (the landing page select may send either). */
export function toServiceSlug(value: string | undefined): ServiceSlug | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return SERVICES.find((s) => s.slug === v || s.label.toLowerCase() === v)?.slug;
}
