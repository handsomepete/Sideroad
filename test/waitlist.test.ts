import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { consents, waitlistEntries } from "../src/db/schema.js";
import { CONSENT } from "../src/domain/consent.js";
import { classifyLocation, loadCoverage } from "../src/domain/coverage.js";
import { FORM_HEADERS, createTestApp, form, resetDb } from "./helpers.js";

const t = await createTestApp();
afterAll(() => t.app.close());
beforeEach(resetDb);

describe("waitlist form", () => {
  it("stores an entry with consent", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/waitlist",
      headers: FORM_HEADERS,
      payload: form({ postalCode: "l9w2z1", email: "pat@example.com", service: "pond", consent: "yes" }),
    });
    expect(res.statusCode).toBe(303);
    const [entry] = await t.db.select().from(waitlistEntries);
    expect(entry).toMatchObject({ postalCode: "L9W 2Z1", email: "pat@example.com", service: "pond", status: "WAITING" });
    const [c] = await t.db.select().from(consents);
    expect(c).toMatchObject({ subjectType: "waitlist", wording: CONSENT.waitlist.text });
  });

  it("needs a way to reach the person", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/waitlist",
      headers: FORM_HEADERS,
      payload: form({ postalCode: "L9W 2Z1", consent: "yes" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("email or a mobile number");
  });
});

describe("coverage rules", () => {
  const cfg = { towns: ["Erin", "Hillsburgh"], postalPrefixes: ["N0B 1T"] };
  it("matches postal prefixes with or without spaces", () => {
    expect(classifyLocation(cfg, "n0b1t0").coverage).toBe("in");
    expect(classifyLocation(cfg, "x", "N0B 1T0").coverage).toBe("in");
    expect(classifyLocation(cfg, "x", "L9W 2Z1").coverage).toBe("out");
  });
  it("matches whole town names only", () => {
    expect(classifyLocation(cfg, "5th Line, erin").town).toBe("Erin");
    expect(classifyLocation(cfg, "Erindale Dr").coverage).toBe("unknown");
  });
  it("sends a covered town with an unlisted postal code to a human, not the waitlist", () => {
    expect(classifyLocation(cfg, "10th Line, Erin", "L7J 1E0").coverage).toBe("unknown");
  });
  it("covers the towns in the shipped service area and turns away the city", () => {
    const shipped = loadCoverage(fileURLToPath(new URL("../config/coverage.json", import.meta.url)));
    for (const code of ["N0B 1T0", "N0B 1Z0", "N0B 1H0", "L0N 1N0", "N1M 2W3", "N0G 1A0", "N0G 2L0"])
      expect(classifyLocation(shipped, "x", code).coverage, code).toBe("in");
    expect(classifyLocation(shipped, "x", "M5V 2T6").coverage).toBe("out");
    expect(classifyLocation(shipped, "x", "N0B 2V0").coverage).toBe("out"); // West Montrose, Waterloo Region
  });
  it("never sends people to the waitlist when no postal prefixes are configured", () => {
    expect(classifyLocation({ towns: [], postalPrefixes: [] }, "L9W 2Z1").coverage).toBe("unknown");
  });
});
