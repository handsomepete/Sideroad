import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, consents, trades } from "../src/db/schema.js";
import { CONSENT } from "../src/domain/consent.js";
import { FORM_HEADERS, createTestApp, form, resetDb } from "./helpers.js";

const t = await createTestApp();
afterAll(() => t.app.close());
beforeEach(async () => {
  await resetDb();
  t.mailer.sent = [];
});

const valid = {
  businessName: "Ridge Plowing",
  contactName: "Jo Ridge",
  mobile: "519 555 0177",
  email: "jo@ridgeplowing.ca",
  services: ["snow", "tree"],
  towns: ["Erin", "Hillsburgh"],
  otherTowns: "Belfountain, Erin",
  insuranceProvider: "Co-operators",
  insuranceExpiry: "2027-03-31",
  notes: "Two trucks, one skid steer.",
  consent: "yes",
};
const post = (data: Record<string, string | string[]>) =>
  t.app.inject({ method: "POST", url: "/trades/join", headers: FORM_HEADERS, payload: form(data) });

describe("trade signup", () => {
  it("renders the form with services and coverage towns", async () => {
    const res = await t.app.inject({ method: "GET", url: "/trades/join" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('value="snow"');
    expect(res.body).toContain('value="Ballinafad"');
    expect(res.body).not.toContain('name="services" value="other"');
  });

  it("stores a trade as PENDING_REVIEW with consent, and emails the admin", async () => {
    const res = await post(valid);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/thanks/trade");
    const [trade] = await t.db.select().from(trades);
    expect(trade).toMatchObject({
      status: "PENDING_REVIEW",
      businessName: "Ridge Plowing",
      mobile: "+15195550177",
      services: ["snow", "tree"],
      towns: ["Erin", "Hillsburgh", "Belfountain"],
      insuranceProvider: "Co-operators",
      insuranceExpiry: "2027-03-31",
    });
    const [c] = await t.db.select().from(consents);
    expect(c).toMatchObject({ subjectType: "trade", subjectId: trade!.id, wording: CONSENT.trade.text });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
    expect(t.mailer.sent[0]!.subject).toContain("New trade signup: Ridge Plowing");
  });

  it("accepts a single service (one checkbox sends a string, not an array)", async () => {
    const res = await post({ ...valid, services: "septic" });
    expect(res.statusCode).toBe(303);
    const [trade] = await t.db.select().from(trades);
    expect(trade!.services).toEqual(["septic"]);
  });

  it("requires at least one service, an insurance expiry and consent", async () => {
    const { services, insuranceExpiry, consent, ...rest } = valid;
    const res = await post(rest);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("at least one service");
    expect(res.body).toContain("insurance expiry date");
    expect(res.body).toContain("Please tick the box");
    expect(await t.db.select().from(trades)).toHaveLength(0);
  });

  it("rejects a service that isn't on the list", async () => {
    const res = await post({ ...valid, services: ["snow", "roofing"] });
    expect(res.statusCode).toBe(400);
  });
});
