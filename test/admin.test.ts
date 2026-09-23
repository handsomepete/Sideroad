import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, homeowners, messages, requests, smsOptOuts, trades, waitlistEntries } from "../src/db/schema.js";
import { FORM_HEADERS, JPEG, createTestApp, form, inboundSms, loginAdmin, multipart, resetDb, twilioPost } from "./helpers.js";

const t = await createTestApp();
afterAll(() => t.app.close());
beforeEach(async () => {
  await resetDb();
  t.sms.sent = [];
  t.sms.fail = false;
});

const FROM = "+15195550142";

async function seedRequest() {
  await t.app.inject(twilioPost("/webhooks/twilio/sms", inboundSms(FROM, "Laneway needs plowing")));
  const [req] = await t.db.select().from(requests);
  return req!;
}

describe("admin auth", () => {
  it("redirects to login when not logged in", async () => {
    const res = await t.app.inject({ method: "GET", url: "/admin/requests" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/admin/login");
  });

  it("rejects a wrong password", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/admin/login",
      headers: FORM_HEADERS,
      payload: form({ password: "nope" }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.cookies).toHaveLength(0);
  });

  it("rejects a forged session cookie", async () => {
    const res = await t.app.inject({ method: "GET", url: "/admin/requests", headers: { cookie: `sr_admin=${Date.now()}.abc` } });
    expect(res.statusCode).toBe(303);
  });

  it("sets a secure-by-default cookie and blocks POSTs without the CSRF token", async () => {
    const { cookie } = await loginAdmin(t.app);
    const req = await seedRequest();
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ body: "hi" }),
    });
    expect(res.statusCode).toBe(403);
    expect(t.sms.sent).toHaveLength(0);
  });

  it("never lets a public route read admin photos", async () => {
    const { payload, headers } = multipart(
      { service: "snow", location: "Erin", description: "Photo test", name: "Sam", mobile: FROM, preferredContact: "sms", consent: "yes" },
      { name: "photo", filename: "a.jpg", type: "image/jpeg", data: JPEG },
    );
    await t.app.inject({ method: "POST", url: "/request", headers, payload });
    const res = await t.app.inject({ method: "GET", url: "/admin/photos/1" });
    expect(res.statusCode).toBe(303);
    const { cookie } = await loginAdmin(t.app);
    const ok = await t.app.inject({ method: "GET", url: "/admin/photos/1", headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("admin dashboard", () => {
  it("lists and filters requests", async () => {
    await seedRequest();
    const { cookie } = await loginAdmin(t.app);
    const all = await t.app.inject({ method: "GET", url: "/admin/requests", headers: { cookie } });
    expect(all.body).toContain("#1");
    const filtered = await t.app.inject({ method: "GET", url: "/admin/requests?status=DONE", headers: { cookie } });
    expect(filtered.body).toContain("No requests match");
    const search = await t.app.inject({ method: "GET", url: "/admin/requests?q=plowing", headers: { cookie } });
    expect(search.body).toContain("/admin/requests/1");
  });

  it("shows the message thread for a request", async () => {
    const req = await seedRequest();
    const { cookie } = await loginAdmin(t.app);
    const res = await t.app.inject({ method: "GET", url: `/admin/requests/${req.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Laneway needs plowing");
    expect(res.body).toContain("Implied consent");
  });

  it("changes a request status and records it in the audit log", async () => {
    const req = await seedRequest();
    const { cookie, csrf } = await loginAdmin(t.app, "Pete");
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/status`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, status: "CONTACTED" }),
    });
    expect(res.statusCode).toBe(303);
    const [updated] = await t.db.select().from(requests);
    expect(updated!.status).toBe("CONTACTED");
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, "request.status"));
    expect(entry).toMatchObject({ actor: "Pete", before: { status: "NEW" }, after: { status: "CONTACTED" } });
  });

  it("rejects an unknown status", async () => {
    const req = await seedRequest();
    const { cookie, csrf } = await loginAdmin(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/status`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, status: "PAID" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("approves a trade and updates waitlist entries", async () => {
    const [trade] = await t.db
      .insert(trades)
      .values({ businessName: "Ridge", contactName: "Jo", mobile: "+15195550177", email: "jo@x.ca", services: ["snow"], towns: ["Erin"], insuranceProvider: "X", insuranceExpiry: "2020-01-01" })
      .returning();
    const [entry] = await t.db.insert(waitlistEntries).values({ postalCode: "L9W 2Z1", email: "a@b.ca" }).returning();
    const { cookie, csrf } = await loginAdmin(t.app);

    const list = await t.app.inject({ method: "GET", url: "/admin/trades", headers: { cookie } });
    expect(list.body).toContain("EXPIRED");

    await t.app.inject({
      method: "POST",
      url: `/admin/trades/${trade!.id}/status`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, status: "APPROVED" }),
    });
    await t.app.inject({
      method: "POST",
      url: `/admin/waitlist/${entry!.id}/status`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, status: "NOTIFIED" }),
    });
    expect((await t.db.select().from(trades))[0]!.status).toBe("APPROVED");
    expect((await t.db.select().from(waitlistEntries))[0]!.status).toBe("NOTIFIED");
  });
});

describe("sending SMS from the dashboard", () => {
  it("sends a reply, stores it in the thread and audits it", async () => {
    const req = await seedRequest();
    const { cookie, csrf } = await loginAdmin(t.app, "Pete");
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "Got it. Ridge Plowing can come at 5:30 am." }),
    });
    expect(res.statusCode).toBe(303);
    expect(t.sms.sent).toEqual([{ to: FROM, body: "Got it. Ridge Plowing can come at 5:30 am." }]);
    const out = await t.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out[0]).toMatchObject({ requestId: req.id, sentBy: "Pete", status: "queued", twilioSid: "SMout1" });
    const [entry] = await t.db.select().from(auditLog).where(eq(auditLog.action, "sms.send"));
    expect(entry!.actor).toBe("Pete");
  });

  it("updates delivery status from Twilio's callback", async () => {
    const req = await seedRequest();
    const { cookie, csrf } = await loginAdmin(t.app);
    await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "On our way" }),
    });
    const res = await t.app.inject(
      twilioPost("/webhooks/twilio/status", { MessageSid: "SMout1", MessageStatus: "delivered", AccountSid: "ACtest" }),
    );
    expect(res.statusCode).toBe(204);
    const [out] = await t.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out!.status).toBe("delivered");
  });

  it("refuses to text a number that replied STOP", async () => {
    const req = await seedRequest();
    await t.app.inject(twilioPost("/webhooks/twilio/sms", inboundSms(FROM, "STOP")));
    expect(await t.db.select().from(smsOptOuts)).toHaveLength(1);
    const { cookie, csrf } = await loginAdmin(t.app);

    const page = await t.app.inject({ method: "GET", url: `/admin/requests/${req.id}`, headers: { cookie } });
    expect(page.body).toContain("replied STOP");

    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "Are you still there?" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("replied STOP");
    expect(t.sms.sent).toHaveLength(0);
    expect(await t.db.select().from(messages).where(eq(messages.direction, "out"))).toHaveLength(0);
  });

  it("saves a failed send and tells the admin", async () => {
    const req = await seedRequest();
    t.sms.fail = true;
    const { cookie, csrf } = await loginAdmin(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "Hello" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Twilio rejected the message");
    const [out] = await t.db.select().from(messages).where(eq(messages.direction, "out"));
    expect(out).toMatchObject({ status: "failed", errorCode: "30008" });
  });

  it("can text a trade from its page", async () => {
    const [trade] = await t.db
      .insert(trades)
      .values({ businessName: "Ridge", contactName: "Jo", mobile: "+15195550177", email: "jo@x.ca", services: ["snow"], towns: ["Erin"], insuranceProvider: "X", insuranceExpiry: "2027-01-01" })
      .returning();
    const { cookie, csrf } = await loginAdmin(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/trades/${trade!.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "Welcome aboard" }),
    });
    expect(res.statusCode).toBe(303);
    expect(t.sms.sent[0]!.to).toBe("+15195550177");
  });

  it("does not send an empty message", async () => {
    const req = await seedRequest();
    const { cookie, csrf } = await loginAdmin(t.app);
    const res = await t.app.inject({
      method: "POST",
      url: `/admin/requests/${req.id}/reply`,
      headers: { ...FORM_HEADERS, cookie },
      payload: form({ _csrf: csrf, body: "   " }),
    });
    expect(res.statusCode).toBe(400);
    expect(t.sms.sent).toHaveLength(0);
    void homeowners;
  });
});
