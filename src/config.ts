import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  // If set, listen on this Unix socket instead of HOST:PORT (used on the shared server, see deploy/DEPLOY.md).
  SOCKET_PATH: z.string().optional(),
  // Public origin as seen by browsers and Twilio, e.g. https://sideroad.ca.
  // Twilio signs the full public URL, so this must match exactly.
  PUBLIC_BASE_URL: z.url().transform((u) => u.replace(/\/+$/, "")),
  TRUST_PROXY: bool.default(true),
  DATABASE_URL: z.string().min(1),
  UPLOAD_DIR: z.string().min(1),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  ADMIN_PASSWORD_HASH: z.string().startsWith("scrypt$", "run `npm run hash-password` to generate"),

  TWILIO_ACCOUNT_SID: z.string().startsWith("AC"),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().regex(/^\+1\d{10}$/, "E.164 Canadian number, e.g. +15195550100"),

  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(1),
  ADMIN_NOTIFY_EMAIL: z.string().min(3),
});

export type Config = z.infer<typeof schema>;

/** Parse and validate the environment. Throws (and the app refuses to start) if anything is missing. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
