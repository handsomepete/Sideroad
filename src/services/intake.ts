import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps, Logger } from "../deps.js";
import { consents, homeowners, photos, requests, trades, waitlistEntries } from "../db/schema.js";
import { CONSENT } from "../domain/consent.js";
import { classifyLocation, extractPostalCode } from "../domain/coverage.js";
import { formatPhone, normalizePhone } from "../domain/phone.js";
import { SERVICE_SLUGS, TRADE_SERVICES, serviceLabel, toServiceSlug } from "../domain/services.js";
import { audit } from "./audit.js";
import { notifyAdmin } from "./notify.js";
import { savePhoto } from "./photos.js";

// ---------- form parsing ----------

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const requiredText = (label: string, max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v : ""),
    z.string().trim().min(1, `Please enter ${label}.`).max(max, `Please keep ${label} under ${max} characters.`),
  );
const mobile = z.preprocess(
  (v) => normalizePhone(typeof v === "string" ? v : "") ?? "",
  z.string().min(1, "Please enter a valid mobile number, e.g. 519-555-0100."),
);
const optionalEmail = z.preprocess(blankToUndefined, z.email("Please enter a valid email address.").optional());
const consent = z.preprocess(
  (v) => v === "yes",
  z.literal(true, { error: "Please tick the box so we can contact you." }),
);
const asArray = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export const requestFormSchema = z
  .object({
    service: z.preprocess(
      (v) => toServiceSlug(typeof v === "string" ? v : undefined),
      z.enum(SERVICE_SLUGS, "Please choose a service."),
    ),
    location: requiredText("your road or town", 200),
    postalCode: optionalText(10),
    description: requiredText("a short description of the job", 2000),
    name: requiredText("your name", 100),
    mobile,
    email: optionalEmail,
    preferredContact: z.enum(["sms", "email"], "Please choose how we should contact you."),
    consent,
  })
  .refine((d) => d.preferredContact !== "email" || d.email, {
    path: ["email"],
    message: "Please enter your email, or choose text as your preferred contact.",
  })
  .refine((d) => !d.postalCode || extractPostalCode(d.postalCode), {
    path: ["postalCode"],
    message: "That doesn't look like a Canadian postal code.",
  });
export type RequestInput = z.infer<typeof requestFormSchema>;

export const tradeFormSchema = z.object({
  businessName: requiredText("your business name", 150),
  contactName: requiredText("a contact name", 100),
  mobile,
  email: z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : v),
    z.email("Please enter a valid email address."),
  ),
  services: z.preprocess(
    asArray,
    z
      .array(z.enum(TRADE_SERVICES.map((s) => s.slug) as [string, ...string[]]))
      .min(1, "Please choose at least one service."),
  ),
  towns: z.preprocess(asArray, z.array(z.string().trim().max(100))),
  otherTowns: optionalText(300),
  insuranceProvider: requiredText("your insurance provider", 150),
  insuranceExpiry: z
    .string("Please enter your insurance expiry date.")
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Please enter your insurance expiry date.")
    .refine((s) => !Number.isNaN(Date.parse(s)), "Please enter a real date."),
  notes: optionalText(2000),
  consent,
});
export type TradeInput = z.infer<typeof tradeFormSchema>;

export const waitlistFormSchema = z
  .object({
    name: optionalText(100),
    postalCode: z.preprocess(
      (v) => extractPostalCode(typeof v === "string" ? v : "") ?? "",
      z.string().min(1, "Please enter your postal code, e.g. N0B 1T0."),
    ),
    service: z.preprocess((v) => toServiceSlug(typeof v === "string" ? v : undefined), z.string().optional()),
    email: optionalEmail,
    mobile: z.preprocess((v) => {
      if (blankToUndefined(v) === undefined) return undefined;
      return normalizePhone(String(v)) ?? "invalid";
    }, z.string().regex(/^\+1\d{10}$/, "Please enter a valid mobile number.").optional()),
    consent,
  })
  .refine((d) => d.email || d.mobile, {
    path: ["email"],
    message: "Please leave an email or a mobile number so we can reach you.",
  });
export type WaitlistInput = z.infer<typeof waitlistFormSchema>;

export type FieldErrors = Record<string, string>;

export function parseForm<T>(
  schema: z.ZodType<T>,
  body: unknown,
): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true, data: result.data };
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "_form");
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}

// ---------- persistence ----------

export interface SubmissionMeta {
  ip: string;
  userAgent: string | undefined;
}

type SubmitDeps = Pick<Deps, "db" | "config" | "coverage" | "mailer">;

export async function submitRequest(
  deps: SubmitDeps,
  log: Logger,
  input: RequestInput,
  meta: SubmissionMeta,
  photo?: Buffer,
): Promise<{ kind: "request"; id: number } | { kind: "waitlist"; id: number }> {
  const loc = classifyLocation(deps.coverage, input.location, input.postalCode);

  if (loc.coverage === "out") {
    const id = await deps.db.transaction(async (tx) => {
      const [entry] = await tx
        .insert(waitlistEntries)
        .values({
          name: input.name,
          email: input.email ?? null,
          mobile: input.mobile,
          postalCode: loc.postalCode,
          locationText: input.location,
          service: input.service,
        })
        .returning({ id: waitlistEntries.id });
      await tx.insert(consents).values(consentRow("waitlist", entry!.id, "homeowner", "web:request-form", meta));
      await audit(tx, { actor: "public", action: "waitlist.create", entityType: "waitlist", entityId: entry!.id });
      return entry!.id;
    });
    await notifyAdmin(
      deps,
      log,
      `Waitlist: ${loc.postalCode}`,
      [
        `${input.name} (${formatPhone(input.mobile)}) asked for ${serviceLabel(input.service)} outside the coverage area.`,
        `Location: ${input.location} ${loc.postalCode ?? ""}`,
      ],
      "/admin/waitlist",
    );
    return { kind: "waitlist", id };
  }

  // Validate and write the photo before touching the database, so a bad file is just a form error.
  const saved = photo && photo.length > 0 ? await savePhoto(deps.config.UPLOAD_DIR, photo) : null;

  const id = await deps.db.transaction(async (tx) => {
    const [owner] = await tx
      .insert(homeowners)
      .values({
        name: input.name,
        mobile: input.mobile,
        email: input.email ?? null,
        preferredContact: input.preferredContact,
      })
      .onConflictDoUpdate({
        target: homeowners.mobile,
        set: {
          name: input.name,
          email: sql`coalesce(excluded.email, ${homeowners.email})`,
          preferredContact: input.preferredContact,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: homeowners.id });

    const [req] = await tx
      .insert(requests)
      .values({
        homeownerId: owner!.id,
        service: input.service,
        locationText: input.location,
        postalCode: loc.postalCode,
        town: loc.town,
        coverage: loc.coverage,
        description: input.description,
        source: "web",
      })
      .returning({ id: requests.id });

    await tx.insert(consents).values(consentRow("homeowner", owner!.id, "homeowner", "web:request-form", meta));
    if (saved) await tx.insert(photos).values({ requestId: req!.id, ...saved });
    await audit(tx, { actor: "public", action: "request.create", entityType: "request", entityId: req!.id });
    return req!.id;
  });

  await notifyAdmin(
    deps,
    log,
    `New request #${id}: ${serviceLabel(input.service)}`,
    [
      `From: ${input.name}, ${formatPhone(input.mobile)}${input.email ? `, ${input.email}` : ""}`,
      `Prefers: ${input.preferredContact === "sms" ? "text" : "email"}`,
      `Location: ${input.location}${loc.postalCode ? ` (${loc.postalCode})` : ""} [coverage: ${loc.coverage}]`,
      `Photo: ${saved ? "yes" : "no"}`,
      "",
      input.description,
    ],
    `/admin/requests/${id}`,
  );
  return { kind: "request", id };
}

export async function submitTrade(
  deps: SubmitDeps,
  log: Logger,
  input: TradeInput,
  meta: SubmissionMeta,
): Promise<number> {
  const extra = (input.otherTowns ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const towns = [...new Set([...input.towns.filter(Boolean), ...extra])];

  const id = await deps.db.transaction(async (tx) => {
    const [trade] = await tx
      .insert(trades)
      .values({
        businessName: input.businessName,
        contactName: input.contactName,
        mobile: input.mobile,
        email: input.email,
        services: input.services,
        towns,
        insuranceProvider: input.insuranceProvider,
        insuranceExpiry: input.insuranceExpiry,
        notes: input.notes ?? null,
      })
      .returning({ id: trades.id });
    await tx.insert(consents).values(consentRow("trade", trade!.id, "trade", "web:trade-form", meta));
    await audit(tx, { actor: "public", action: "trade.create", entityType: "trade", entityId: trade!.id });
    return trade!.id;
  });

  await notifyAdmin(
    deps,
    log,
    `New trade signup: ${input.businessName}`,
    [
      `${input.contactName}, ${formatPhone(input.mobile)}, ${input.email}`,
      `Services: ${input.services.map(serviceLabel).join(", ")}`,
      `Towns: ${towns.join(", ") || "none given"}`,
      `Insurance: ${input.insuranceProvider}, expires ${input.insuranceExpiry}`,
      input.notes ? `Notes: ${input.notes}` : "",
    ],
    `/admin/trades/${id}`,
  );
  return id;
}

export async function submitWaitlist(
  deps: SubmitDeps,
  log: Logger,
  input: WaitlistInput,
  meta: SubmissionMeta,
): Promise<number> {
  const id = await deps.db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(waitlistEntries)
      .values({
        name: input.name ?? null,
        email: input.email ?? null,
        mobile: input.mobile ?? null,
        postalCode: input.postalCode,
        service: input.service ?? null,
      })
      .returning({ id: waitlistEntries.id });
    await tx.insert(consents).values(consentRow("waitlist", entry!.id, "waitlist", "web:waitlist-form", meta));
    await audit(tx, { actor: "public", action: "waitlist.create", entityType: "waitlist", entityId: entry!.id });
    return entry!.id;
  });
  await notifyAdmin(
    deps,
    log,
    `Waitlist: ${input.postalCode}`,
    [`${input.name ?? "Someone"} joined the waitlist for ${input.postalCode}.`],
    "/admin/waitlist",
  );
  return id;
}

function consentRow(
  subjectType: "homeowner" | "trade" | "waitlist",
  subjectId: number,
  wording: keyof typeof CONSENT,
  source: string,
  meta: SubmissionMeta | null,
) {
  const c = CONSENT[wording];
  return {
    subjectType,
    subjectId,
    channels: [...c.channels],
    wording: c.text,
    wordingVersion: c.version,
    source,
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent?.slice(0, 500) ?? null,
  };
}
export { consentRow };
