import { z } from "zod";

// Blank values in .env (e.g. "TWILIO_AUTH_TOKEN=") count as not set.
const optional = <T extends z.ZodType>(inner: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), inner.optional());

// Whether a reverse proxy on this machine sits in front of the app (1) or not (0). Only the single
// X-Forwarded-For entry that proxy adds is trusted. Deeper entries can't be verified, so a client
// could plant any address there; that's why values above 1 are refused rather than supported.
const proxyHops = z
  .enum(["true", "false", "0", "1"], "0 or 1 (true/false also accepted)")
  .transform((v) => (v === "true" || v === "1" ? 1 : 0));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  // If set, listen on this Unix socket instead of HOST:PORT (used on the shared server, see deploy/DEPLOY.md).
  SOCKET_PATH: z.string().optional(),
  // Public origin as seen by browsers and Twilio, e.g. https://sideroad.ca.
  // Twilio signs the full public URL, so this must match exactly.
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  TRUST_PROXY: proxyHops.default(1),
  DATABASE_URL: z.string().min(1),
  UPLOAD_DIR: z.string().min(1),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ADMIN_PASSWORD_HASH: z.string().startsWith("scrypt$", "run `npm run hash-password` to generate"),

  // Texting and email alerts are optional so the site can go live before they're set up.
  // Each group must be complete or left blank entirely.
  TWILIO_ACCOUNT_SID: optional(z.string().startsWith("AC")),
  TWILIO_AUTH_TOKEN: optional(z.string()),
  TWILIO_PHONE_NUMBER: optional(z.string().regex(/^\+1\d{10}$/, "E.164 Canadian number, e.g. +15195550100")),

  SMTP_URL: optional(z.string()),
  MAIL_FROM: optional(z.string()),
  ADMIN_NOTIFY_EMAIL: optional(z.string().min(3)),
});

const GROUPS = {
  Twilio: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
  "Email alerts": ["SMTP_URL", "MAIL_FROM", "ADMIN_NOTIFY_EMAIL"],
} as const;

const checked = schema.superRefine((c, ctx) => {
  for (const [name, keys] of Object.entries(GROUPS)) {
    const set = keys.filter((k) => c[k] !== undefined);
    if (set.length > 0 && set.length < keys.length) {
      for (const k of keys.filter((k) => c[k] === undefined)) {
        ctx.addIssue({ code: "custom", path: [k], message: `${name} is half set up: fill this in or blank all of ${keys.join(", ")}` });
      }
    }
  }
});

export type Config = z.infer<typeof schema>;

/** Twilio settings when texting is configured, otherwise null. */
export function twilioSettings(c: Config) {
  return c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_PHONE_NUMBER
    ? { accountSid: c.TWILIO_ACCOUNT_SID, authToken: c.TWILIO_AUTH_TOKEN, phoneNumber: c.TWILIO_PHONE_NUMBER }
    : null;
}

/** SMTP settings when email alerts are configured, otherwise null. */
export function mailSettings(c: Config) {
  return c.SMTP_URL && c.MAIL_FROM && c.ADMIN_NOTIFY_EMAIL
    ? { smtpUrl: c.SMTP_URL, from: c.MAIL_FROM, to: c.ADMIN_NOTIFY_EMAIL }
    : null;
}

/** Parse and validate the environment. Throws (and the app refuses to start) if anything is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = checked.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
