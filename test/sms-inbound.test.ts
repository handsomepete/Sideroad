import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consents, homeowners, messages, photos, requests, smsOptOuts, trades } from "../src/db/schema.js";
import { CONSENT } from "../src/domain/consent.js";
import { createTestApp, inboundSms, resetDb, twilioPost } from "./helpers.js";

let now = new Date("2026-01-10T12:00:00Z");
const t = await createTestApp({ now: () => now });
afterAll(() => t.app.close());
beforeEach(async () => {
  await resetDb();
  t.mailer.sent = [];
  now = new Date("2026-01-10T12:00:00Z");
});

const FROM = "+15195550142";
const send = (params: Record<string, string>) => t.app.inject(twilioPost("/webhooks/twilio/sms", params));

describe("inbound SMS webhook", () => {
  it("rejects requests without a valid Twilio signature", async () => {
    const params = inboundSms(FROM, "hello");
    const forged = twilioPost("/webhooks/twilio/sms", params, "wrong-token");
    const res = await t.app.inject(forged);
    expect(res.statusCode).toBe(403);
    const unsigned = await t.app.inject({ ...forged, headers: { "content-type": forged.headers["content-type"] } });
    expect(unsigned.statusCode).toBe(403);
    expect(await t.db.select().from(messages)).toHaveLength(0);
  });

  it("rejects a signed request whose body was tampered with", async () => {
    const call = twilioPost("/webhooks/twilio/sms", inboundSms(FROM, "hello"));
    const res = await t.app.inject({ ...call, payload: call.payload.replace("hello", "goodbye") });
    expect(res.statusCode).toBe(403);
  });

  it("creates a NEW request from a first text, stores the message, and emails the admin", async () => {
    const res = await send(inboundSms(FROM, "Laneway's buried again. Need it cleared before 7 tomorrow."));
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/xml");
    expect(res.body).toContain("<Response></Response>");

    const [req] = await t.db.select().from(requests);
    expect(req).toMatchObject({ status: "NEW", source: "sms", coverage: "unknown" });
    expect(req!.description).toContain("Laneway's buried");
    const [owner] = await t.db.select().from(homeowners);
    expect(owner).toMatchObject({ mobile: FROM, preferredContact: "sms" });
    const [msg] = await t.db.select().from(messages);
    expect(msg).toMatchObject({ requestId: req!.id, direction: "in", status: "received", counterpartyPhone: FROM });
    const [c] = await t.db.select().from(consents);
    expect(c).toMatchObject({ subjectType: "homeowner", wordingVersion: CONSENT.inboundSms.version, source: "sms:inbound" });
    expect(t.mailer.sent[0]!.subject).toContain("New text request");
  });

  it("appends follow-up texts to the open request", async () => {
    await send(inboundSms(FROM, "Need a plow"));
    now = new Date(now.getTime() + 3 * 86_400_000);
    await send(inboundSms(FROM, "Still need it, about 300 m"));
    expect(await t.db.select().from(requests)).toHaveLength(1);
    const msgs = await t.db.select().from(messages);
    expect(msgs).toHaveLength(2);
    expect(new Set(msgs.map((m) => m.requestId)).size).toBe(1);
    expect(t.mailer.sent[1]!.subject).toContain("Reply on request #1");
  });

  it("appends a text to a web request from the same number", async () => {
    const [owner] = await t.db.insert(homeowners).values({ name: "Sam", mobile: FROM }).returning();
    const [req] = await t.db
      .insert(requests)
      .values({ homeownerId: owner!.id, source: "web", service: "septic", updatedAt: now })
      .returning();
    await send(inboundSms(FROM, "Here's a photo of the tank lid"));
    const [msg] = await t.db.select().from(messages);
    expect(msg!.requestId).toBe(req!.id);
    expect(await t.db.select().from(requests)).toHaveLength(1);
  });

  it("starts a new request once the previous one is closed", async () => {
    await send(inboundSms(FROM, "Need a plow"));
    await t.db.update(requests).set({ status: "DONE" });
    await send(inboundSms(FROM, "Septic alarm going off"));
    const rows = await t.db.select().from(requests);
    expect(rows).toHaveLength(2);
    expect(await t.db.select().from(homeowners)).toHaveLength(1);
  });

  it("starts a new request after the thread window has passed", async () => {
    await send(inboundSms(FROM, "Need a plow"));
    now = new Date(now.getTime() + 15 * 86_400_000);
    await send(inboundSms(FROM, "Pond needs opening"));
    expect(await t.db.select().from(requests)).toHaveLength(2);
  });

  it("stores a message only once when Twilio retries the webhook", async () => {
    const params = inboundSms(FROM, "Need a plow");
    await send(params);
    const again = await send(params);
    expect(again.statusCode).toBe(200);
    expect(await t.db.select().from(messages)).toHaveLength(1);
    expect(await t.db.select().from(requests)).toHaveLength(1);
  });

  it("does not create two requests when two first texts arrive at once", async () => {
    await Promise.all([send(inboundSms(FROM, "Need a plow")), send(inboundSms(FROM, "before 7am please"))]);
    expect(await t.db.select().from(requests)).toHaveLength(1);
    expect(await t.db.select().from(messages)).toHaveLength(2);
  });

  it("files texts from a known trade under the trade, not as a request", async () => {
    const [trade] = await t.db
      .insert(trades)
      .values({
        businessName: "Ridge Plowing",
        contactName: "Jo",
        mobile: FROM,
        email: "jo@example.com",
        services: ["snow"],
        towns: ["Erin"],
        insuranceProvider: "X",
        insuranceExpiry: "2027-01-01",
      })
      .returning();
    await send(inboundSms(FROM, "Can take jobs this weekend"));
    expect(await t.db.select().from(requests)).toHaveLength(0);
    const [msg] = await t.db.select().from(messages);
    expect(msg).toMatchObject({ tradeId: trade!.id, requestId: null });
    expect(t.mailer.sent[0]!.subject).toContain("Text from trade");
  });

  it("downloads MMS photos and attaches them to the request", async () => {
    const fetched: string[] = [];
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const local = await createTestApp({
      fetchMedia: async (url) => {
        fetched.push(url);
        return { buffer: JPEG, contentType: "image/jpeg" };
      },
    });
    const res = await local.app.inject(
      twilioPost(
        "/webhooks/twilio/sms",
        inboundSms(FROM, "", {
          NumMedia: "1",
          MediaUrl0: "https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages/MM1/Media/ME1",
          MediaContentType0: "image/jpeg",
        }),
      ),
    );
    await local.app.close();
    expect(res.statusCode).toBe(200);
    expect(fetched).toHaveLength(1);
    const [p] = await t.db.select().from(photos);
    const [msg] = await t.db.select().from(messages);
    expect(p).toMatchObject({ mimeType: "image/jpeg", messageId: msg!.id });
    expect(msg!.mediaCount).toBe(1);
  });

  it("keeps the text even if the photo download fails", async () => {
    const local = await createTestApp({
      fetchMedia: async () => {
        throw new Error("timeout");
      },
    });
    const res = await local.app.inject(
      twilioPost("/webhooks/twilio/sms", inboundSms(FROM, "photo attached", { NumMedia: "1", MediaUrl0: "https://api.twilio.com/x" })),
    );
    await local.app.close();
    expect(res.statusCode).toBe(200);
    expect(await t.db.select().from(messages)).toHaveLength(1);
    expect(await t.db.select().from(photos)).toHaveLength(0);
  });
});

describe("STOP and START", () => {
  it("records STOP, withdraws SMS consent and does not open a request", async () => {
    await send(inboundSms(FROM, "Need a plow"));
    await t.db.update(requests).set({ status: "CLOSED" });
    const res = await send(inboundSms(FROM, "stop"));
    expect(res.statusCode).toBe(200);

    const [opt] = await t.db.select().from(smsOptOuts);
    expect(opt).toMatchObject({ phone: FROM, keyword: "STOP" });
    expect(await t.db.select().from(requests)).toHaveLength(1);
    const [c] = await t.db.select().from(consents);
    expect(c!.withdrawnAt).toBeInstanceOf(Date);
    expect(await t.db.select().from(messages)).toHaveLength(2); // STOP itself is stored
    expect(t.mailer.sent.at(-1)!.subject).toContain("opted out");
  });

  it("treats STOP from an unknown number as an opt-out only", async () => {
    await send(inboundSms("+15195550999", "UNSUBSCRIBE"));
    expect(await t.db.select().from(requests)).toHaveLength(0);
    expect(await t.db.select().from(homeowners)).toHaveLength(0);
    expect(await t.db.select().from(smsOptOuts)).toHaveLength(1);
    const [msg] = await t.db.select().from(messages);
    expect(msg).toMatchObject({ requestId: null, tradeId: null, body: "UNSUBSCRIBE" });
  });

  it("does not treat a sentence containing 'stop' as an opt-out", async () => {
    await send(inboundSms(FROM, "Please stop by before 7"));
    expect(await t.db.select().from(smsOptOuts)).toHaveLength(0);
    expect(await t.db.select().from(requests)).toHaveLength(1);
  });

  it("START removes the opt-out", async () => {
    await send(inboundSms(FROM, "STOP"));
    await send(inboundSms(FROM, "Start"));
    expect(await t.db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, FROM))).toHaveLength(0);
  });
});
