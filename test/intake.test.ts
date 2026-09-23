import { readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consents, homeowners, photos, requests, waitlistEntries } from "../src/db/schema.js";
import { CONSENT } from "../src/domain/consent.js";
import { FORM_HEADERS, JPEG, createTestApp, form, multipart, resetDb } from "./helpers.js";

const t = await createTestApp();
afterAll(() => t.app.close());
beforeEach(async () => {
  await resetDb();
  t.mailer.sent = [];
  t.mailer.fail = false;
});

const valid = {
  service: "snow",
  location: "10th Line, Erin",
  postalCode: "",
  description: "Laneway is about 300 m, needs clearing before 7 am.",
  name: "Sam Rivers",
  mobile: "(519) 555-0142",
  email: "sam@example.com",
  preferredContact: "sms",
  consent: "yes",
};

const post = (data: Record<string, string>) =>
  t.app.inject({ method: "POST", url: "/request", headers: FORM_HEADERS, payload: form(data) });

describe("homeowner request form", () => {
  it("renders the landing page with the hero form wired to /request", async () => {
    const res = await t.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('action="/request"');
    expect(res.body).toContain("Reliable trades for rural properties.");
    expect(res.body).not.toContain("[PHONE NUMBER]");
    expect(res.body).toContain("(519) 555-0000");
  });

  it("prefills the full form from the hero form", async () => {
    const res = await t.app.inject({ method: "GET", url: "/request?service=Septic&location=4th+Line%2C+Erin" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="septic" selected');
    expect(res.body).toContain('value="4th Line, Erin"');
    expect(res.body).toContain(CONSENT.homeowner.text.slice(0, 40));
  });

  it("stores a valid request as NEW with the homeowner, consent wording and timestamp", async () => {
    const res = await post(valid);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/thanks/request");

    const [req] = await t.db.select().from(requests);
    expect(req).toMatchObject({
      status: "NEW",
      source: "web",
      service: "snow",
      coverage: "in",
      town: "Erin",
      locationText: "10th Line, Erin",
    });
    const [owner] = await t.db.select().from(homeowners);
    expect(owner).toMatchObject({ name: "Sam Rivers", mobile: "+15195550142", email: "sam@example.com", preferredContact: "sms" });

    const [c] = await t.db.select().from(consents);
    expect(c).toMatchObject({
      subjectType: "homeowner",
      subjectId: owner!.id,
      wording: CONSENT.homeowner.text,
      wordingVersion: CONSENT.homeowner.version,
      channels: ["sms", "email"],
      source: "web:request-form",
    });
    expect(c!.givenAt).toBeInstanceOf(Date);
    expect(c!.ip).toBeTruthy();
  });

  it("emails the admin about a new request", async () => {
    await post(valid);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.to).toBe("founders@sideroad.test");
    expect(t.mailer.sent[0]!.subject).toContain("New request #1");
    expect(t.mailer.sent[0]!.text).toContain("Laneway is about 300 m");
    expect(t.mailer.sent[0]!.text).toContain("https://sideroad.test/admin/requests/1");
  });

  it("still saves the request when the notification email fails", async () => {
    t.mailer.fail = true;
    const res = await post(valid);
    expect(res.statusCode).toBe(303);
    expect(await t.db.select().from(requests)).toHaveLength(1);
  });

  it("rejects a submission without consent and stores nothing", async () => {
    const res = await post({ ...valid, consent: "" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Please tick the box");
    expect(res.body).toContain('value="Sam Rivers"'); // values are kept
    expect(await t.db.select().from(requests)).toHaveLength(0);
    expect(await t.db.select().from(consents)).toHaveLength(0);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("rejects an invalid mobile number", async () => {
    const res = await post({ ...valid, mobile: "12345" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("valid mobile number");
  });

  it("requires an email when email is the preferred contact", async () => {
    const res = await post({ ...valid, email: "", preferredContact: "email" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Please enter your email");
  });

  it("escapes what people type when re-rendering the form", async () => {
    const res = await post({ ...valid, name: '<script>alert(1)</script>', consent: "" });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("puts an out-of-area postal code on the waitlist with a friendly message", async () => {
    const res = await post({ ...valid, location: "Main St, Orangeville", postalCode: "l9w 2z1" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/thanks/waitlist");
    expect(await t.db.select().from(requests)).toHaveLength(0);
    const [entry] = await t.db.select().from(waitlistEntries);
    expect(entry).toMatchObject({ postalCode: "L9W 2Z1", service: "snow", mobile: "+15195550142" });
    const [c] = await t.db.select().from(consents);
    expect(c).toMatchObject({ subjectType: "waitlist", subjectId: entry!.id, wording: CONSENT.homeowner.text });

    const thanks = await t.app.inject({ method: "GET", url: "/thanks/waitlist" });
    expect(thanks.body).toContain("let you know");
  });

  it("accepts an in-area postal code", async () => {
    await post({ ...valid, location: "Trafalgar Rd", postalCode: "N0B 1T0" });
    const [req] = await t.db.select().from(requests);
    expect(req).toMatchObject({ coverage: "in", postalCode: "N0B 1T0" });
  });

  it("keeps a request whose road can't be placed and marks it for checking", async () => {
    await post({ ...valid, location: "Sideroad 17" });
    const [req] = await t.db.select().from(requests);
    expect(req).toMatchObject({ coverage: "unknown", status: "NEW" });
  });

  it("reuses the homeowner record for a repeat customer", async () => {
    await post(valid);
    await post({ ...valid, service: "septic", email: "" });
    expect(await t.db.select().from(homeowners)).toHaveLength(1);
    expect(await t.db.select().from(requests)).toHaveLength(2);
    const [owner] = await t.db.select().from(homeowners);
    expect(owner!.email).toBe("sam@example.com"); // a blank email doesn't wipe the old one
  });

  it("silently drops honeypot submissions", async () => {
    const res = await post({ ...valid, website: "http://spam.example" });
    expect(res.statusCode).toBe(303);
    expect(await t.db.select().from(requests)).toHaveLength(0);
  });

  it("stores an uploaded photo", async () => {
    const { payload, headers } = multipart(valid, { name: "photo", filename: "lane.jpg", type: "image/jpeg", data: JPEG });
    const res = await t.app.inject({ method: "POST", url: "/request", headers, payload });
    expect(res.statusCode).toBe(303);
    const [p] = await t.db.select().from(photos);
    expect(p).toMatchObject({ mimeType: "image/jpeg", sizeBytes: JPEG.length, messageId: null });
    expect(readdirSync(t.deps.config.UPLOAD_DIR)).toContain(p!.storedName);
  });

  it("accepts the form with an empty file input", async () => {
    const { payload, headers } = multipart(valid, { name: "photo", filename: "", type: "application/octet-stream", data: Buffer.alloc(0) });
    const res = await t.app.inject({ method: "POST", url: "/request", headers, payload });
    expect(res.statusCode).toBe(303);
    expect(await t.db.select().from(photos)).toHaveLength(0);
  });

  it("rejects a file that isn't an image, whatever it claims to be", async () => {
    const { payload, headers } = multipart(valid, {
      name: "photo",
      filename: "lane.jpg",
      type: "image/jpeg",
      data: Buffer.from("<html><script>alert(1)</script></html>".repeat(5)),
    });
    const res = await t.app.inject({ method: "POST", url: "/request", headers, payload });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("look like a photo");
    expect(await t.db.select().from(requests)).toHaveLength(0);
  });

  it("rejects a photo over 10 MB", async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const { payload, headers } = multipart(valid, { name: "photo", filename: "big.jpg", type: "image/jpeg", data: big });
    const res = await t.app.inject({ method: "POST", url: "/request", headers, payload });
    expect(res.statusCode).toBe(413);
    expect(await t.db.select().from(requests)).toHaveLength(0);
  });

  it("does not store anything under another homeowner's id", async () => {
    await post(valid);
    await post({ ...valid, mobile: "519-555-0199", name: "Alex" });
    const rows = await t.db.select().from(requests).innerJoin(homeowners, eq(requests.homeownerId, homeowners.id));
    expect(rows.map((r) => r.homeowners.name).sort()).toEqual(["Alex", "Sam Rivers"]);
  });
});
