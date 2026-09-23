import { afterAll, describe, expect, it } from "vitest";
import { localProxyTrust } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { requests } from "../src/db/schema.js";
import { FORM_HEADERS, createTestApp, form, inboundSms, loginAdmin, resetDb, twilioPost } from "./helpers.js";

const base = {
  PUBLIC_BASE_URL: "https://sideroad.test",
  DATABASE_URL: "postgres://x@/x",
  UPLOAD_DIR: "/tmp/x",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_PASSWORD_HASH: "scrypt$abc$def",
};

describe("config", () => {
  it("starts without Twilio or SMTP, and treats blank values as unset", () => {
    const c = loadConfig({ ...base, TWILIO_AUTH_TOKEN: "", SMTP_URL: "  " });
    expect(c.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(c.SMTP_URL).toBeUndefined();
  });

  it("refuses a half-configured Twilio or email setup", () => {
    expect(() => loadConfig({ ...base, TWILIO_ACCOUNT_SID: "ACx" })).toThrow(/TWILIO_AUTH_TOKEN: Twilio is half set up/);
    expect(() => loadConfig({ ...base, SMTP_URL: "smtp://x" })).toThrow(/ADMIN_NOTIFY_EMAIL: Email alerts is half set up/);
  });

  it("reads TRUST_PROXY as a hop count", () => {
    expect(loadConfig(base).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(0);
    expect(loadConfig({ ...base, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
  });
});

describe("client IP behind the reverse proxy", () => {
  it("trusts only a local peer, one hop deep", () => {
    const trust = localProxyTrust(1);
    expect(trust("127.0.0.1", 0)).toBe(true);
    expect(trust(undefined, 0)).toBe(true); // Unix socket
    expect(trust("198.51.100.7", 0)).toBe(false);
    expect(trust("203.0.113.9", 1)).toBe(false);
  });

  it("ignores addresses a client adds to X-Forwarded-For itself", async () => {
    const t = await createTestApp({ config: { TRUST_PROXY: 1 } });
    t.app.get("/__ip", async (request) => ({ ip: request.ip }));
    // nginx appending to a spoofed header: "<spoofed>, <real client>"
    const viaProxy = await t.app.inject({ url: "/__ip", headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    expect(viaProxy.json().ip).toBe("203.0.113.9");
    // Someone connecting directly can't claim any address at all
    const direct = await t.app.inject({ url: "/__ip", remoteAddress: "198.51.100.7", headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(direct.json().ip).toBe("198.51.100.7");
    await t.app.close();
  });

  it("keeps the admin login limit when the attacker rotates X-Forwarded-For", async () => {
    const t = await createTestApp({ config: { TRUST_PROXY: 1 }, rateLimits: true });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await t.app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { ...FORM_HEADERS, "x-forwarded-for": `10.0.0.${i}, 203.0.113.9` },
        payload: form({ password: "wrong" }),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    await t.app.close();
  });
});

describe("running before Twilio and email are set up", () => {
  const off = {
    TWILIO_ACCOUNT_SID: undefined,
    TWILIO_AUTH_TOKEN: undefined,
    TWILIO_PHONE_NUMBER: undefined,
  };
  const tPromise = createTestApp({ config: off });
  afterAll(async () => (await tPromise).app.close());

  it("hides the 'text us' lines", async () => {
    const t = await tPromise;
    for (const url of ["/", "/request", "/thanks/request", "/privacy"]) {
      const res = await t.app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("sms:");
    }
  });

  it("rejects Twilio webhooks, since there's no token to check them against", async () => {
    const t = await tPromise;
    const res = await t.app.inject(twilioPost("/webhooks/twilio/sms", inboundSms("+15195550142", "hi")));
    expect(res.statusCode).toBe(403);
  });

  it("still takes web requests, and the dashboard explains why it can't text", async () => {
    const t = await tPromise;
    await resetDb();
    t.sms.enabled = false;
    t.mailer.enabled = false;
    const res = await t.app.inject({
      method: "POST",
      url: "/request",
      headers: FORM_HEADERS,
      payload: form({
        service: "snow", location: "10th Line, Erin", description: "Laneway needs clearing",
        name: "Sam", mobile: "519-555-0142", preferredContact: "sms", consent: "yes",
      }),
    });
    expect(res.statusCode).toBe(303);
    expect(t.mailer.sent).toHaveLength(0);
    const [req] = await t.db.select().from(requests);
    const { cookie, csrf } = await loginAdmin(t.app);
    const reply = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req!.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "Hello" }),
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.body).toContain("Texting isn&#39;t set up yet");
    expect(t.sms.sent).toHaveLength(0);
  });
});
