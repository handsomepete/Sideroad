import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import twilio from "twilio";
import { buildApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import type { Deps, Mailer, MediaFetcher, SmsSender } from "../src/deps.js";
import { hashPassword } from "../src/services/auth.js";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://sideroad:sideroad@localhost:5432/sideroad_test";

export const ADMIN_PASSWORD = "correct horse battery staple";
const adminHash = hashPassword(ADMIN_PASSWORD);

export const TWILIO_NUMBER = "+15195550000";
export const AUTH_TOKEN = "test-auth-token";
export const BASE_URL = "https://sideroad.test";

export async function testConfig(overrides: Partial<Config> = {}): Promise<Config> {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: 0,
    PUBLIC_BASE_URL: BASE_URL,
    TRUST_PROXY: 0,
    DATABASE_URL: TEST_DATABASE_URL,
    UPLOAD_DIR: mkdtempSync(join(tmpdir(), "sideroad-uploads-")),
    SESSION_SECRET: "x".repeat(40),
    ADMIN_PASSWORD_HASH: await adminHash,
    TWILIO_ACCOUNT_SID: "ACtest",
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: TWILIO_NUMBER,
    SMTP_URL: "smtp://unused",
    MAIL_FROM: "test@sideroad.test",
    ADMIN_NOTIFY_EMAIL: "founders@sideroad.test",
    ...overrides,
  };
}

export class FakeSms implements SmsSender {
  enabled = true;
  sent: { to: string; body: string }[] = [];
  fail = false;
  async send(to: string, body: string) {
    if (this.fail) throw Object.assign(new Error("Twilio down"), { code: 30008 });
    this.sent.push({ to, body });
    return { sid: `SMout${this.sent.length}`, status: "queued" };
  }
}

export class FakeMailer implements Mailer {
  enabled = true;
  sent: { to: string; subject: string; text: string }[] = [];
  fail = false;
  async send(msg: { to: string; subject: string; text: string }) {
    if (this.fail) throw new Error("SMTP down");
    this.sent.push(msg);
  }
}

// Smallest valid JPEG header we accept; enough for detectImageType.
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);

const shared = createDb(TEST_DATABASE_URL);

export async function resetDb() {
  await shared.db.execute(sql`truncate homeowners, requests, trades, waitlist_entries, messages, photos,
    consents, sms_opt_outs, audit_log restart identity cascade`);
}

export async function createTestApp(
  opts: { config?: Partial<Config>; fetchMedia?: MediaFetcher; now?: () => Date; rateLimits?: boolean } = {},
) {
  const sms = new FakeSms();
  const mailer = new FakeMailer();
  const deps: Deps = {
    config: await testConfig(opts.config),
    db: shared.db,
    coverage: { towns: ["Erin", "Hillsburgh", "Ballinafad"], postalPrefixes: ["N0B 1T", "N0B 1Z"] },
    sms,
    mailer,
    fetchMedia: opts.fetchMedia ?? (async () => ({ buffer: JPEG, contentType: "image/jpeg" })),
    now: opts.now,
  };
  const app = await buildApp(deps, { rateLimits: opts.rateLimits ?? false });
  return { app, deps, sms, mailer, db: shared.db };
}

export function form(data: Record<string, string | string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) for (const item of [v].flat()) p.append(k, item);
  return p.toString();
}

export const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

/** Build a multipart body by hand so tests can attach a photo. */
export function multipart(fields: Record<string, string>, file?: { name: string; filename: string; type: string; data: Buffer }) {
  const boundary = "----sideroadtest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`,
      ),
      file.data,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

/** A signed Twilio webhook call. */
export function twilioPost(path: string, params: Record<string, string>, token = AUTH_TOKEN) {
  const signature = twilio.getExpectedTwilioSignature(token, `${BASE_URL}${path}`, params);
  return {
    method: "POST" as const,
    url: path,
    headers: { ...FORM_HEADERS, "x-twilio-signature": signature },
    payload: form(params),
  };
}

let sidCounter = 0;
export function inboundSms(from: string, body: string, extra: Record<string, string> = {}) {
  sidCounter += 1;
  return {
    MessageSid: `SMin${Date.now()}${sidCounter}`,
    AccountSid: "ACtest",
    From: from,
    To: TWILIO_NUMBER,
    Body: body,
    NumMedia: "0",
    ...extra,
  };
}

/** Log in and return the cookie header and CSRF token for admin POSTs. */
export async function loginAdmin(app: Awaited<ReturnType<typeof createTestApp>>["app"], name = "Pete") {
  const res = await app.inject({
    method: "POST",
    url: "/admin/login",
    headers: FORM_HEADERS,
    payload: form({ name, password: ADMIN_PASSWORD }),
  });
  if (res.statusCode !== 303) throw new Error(`login failed: ${res.statusCode}`);
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const page = await app.inject({ method: "GET", url: "/admin/requests", headers: { cookie } });
  const csrf = page.body.match(/name="_csrf" value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error("no csrf token on admin page");
  return { cookie, csrf };
}
