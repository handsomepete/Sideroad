import {
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const contactPreference = pgEnum("contact_preference", ["sms", "email"]);
export const requestStatus = pgEnum("request_status", ["NEW", "CONTACTED", "MATCHED", "DONE", "CLOSED", "SPAM"]);
export const requestSource = pgEnum("request_source", ["web", "sms"]);
export const coverageStatus = pgEnum("coverage_status", ["in", "out", "unknown"]);
export const tradeStatus = pgEnum("trade_status", ["PENDING_REVIEW", "APPROVED", "REJECTED", "INACTIVE"]);
export const waitlistStatus = pgEnum("waitlist_status", ["WAITING", "NOTIFIED", "REMOVED"]);
export const messageDirection = pgEnum("message_direction", ["in", "out"]);
export const messageChannel = pgEnum("message_channel", ["sms", "email"]);
export const messageStatus = pgEnum("message_status", [
  "received",
  "queued",
  "sent",
  "delivered",
  "undelivered",
  "failed",
]);
export const consentSubject = pgEnum("consent_subject", ["homeowner", "trade", "waitlist"]);

export const homeowners = pgTable("homeowners", {
  id: serial("id").primaryKey(),
  name: text("name"),
  mobile: text("mobile").unique(), // E.164
  email: text("email"),
  preferredContact: contactPreference("preferred_contact"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const requests = pgTable(
  "requests",
  {
    id: serial("id").primaryKey(),
    homeownerId: integer("homeowner_id")
      .notNull()
      .references(() => homeowners.id),
    service: text("service"), // slug from domain/services.ts; null when unknown (e.g. first SMS)
    locationText: text("location_text"),
    postalCode: text("postal_code"),
    town: text("town"),
    coverage: coverageStatus("coverage").notNull().default("unknown"),
    description: text("description"),
    source: requestSource("source").notNull(),
    status: requestStatus("status").notNull().default("NEW"),
    createdAt: createdAt(),
    // Bumped on every inbound or outbound message, used to decide whether a new text appends or starts a request.
    updatedAt: updatedAt(),
  },
  (t) => [index("requests_status_idx").on(t.status), index("requests_homeowner_idx").on(t.homeownerId)],
);

export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    businessName: text("business_name").notNull(),
    contactName: text("contact_name").notNull(),
    mobile: text("mobile").notNull(), // E.164
    email: text("email").notNull(),
    services: text("services").array().notNull(),
    towns: text("towns").array().notNull(),
    insuranceProvider: text("insurance_provider").notNull(),
    insuranceExpiry: date("insurance_expiry", { mode: "string" }).notNull(),
    notes: text("notes"),
    status: tradeStatus("status").notNull().default("PENDING_REVIEW"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("trades_mobile_idx").on(t.mobile)],
);

export const waitlistEntries = pgTable("waitlist_entries", {
  id: serial("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  mobile: text("mobile"),
  postalCode: text("postal_code"),
  locationText: text("location_text"),
  service: text("service"),
  status: waitlistStatus("status").notNull().default("WAITING"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    requestId: integer("request_id").references(() => requests.id),
    tradeId: integer("trade_id").references(() => trades.id),
    counterpartyPhone: text("counterparty_phone").notNull(),
    direction: messageDirection("direction").notNull(),
    channel: messageChannel("channel").notNull().default("sms"),
    body: text("body").notNull(),
    // Unique so a webhook Twilio retries is only stored once.
    twilioSid: text("twilio_sid").unique(),
    status: messageStatus("status").notNull(),
    mediaCount: integer("media_count").notNull().default(0),
    sentBy: text("sent_by"),
    errorCode: text("error_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_request_idx").on(t.requestId),
    index("messages_trade_idx").on(t.tradeId),
    index("messages_phone_idx").on(t.counterpartyPhone),
  ],
);

export const photos = pgTable("photos", {
  id: serial("id").primaryKey(),
  requestId: integer("request_id")
    .notNull()
    .references(() => requests.id),
  messageId: integer("message_id").references(() => messages.id),
  storedName: text("stored_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: createdAt(),
});

/** CASL: what the person agreed to, the exact words they saw, and when. */
export const consents = pgTable(
  "consents",
  {
    id: serial("id").primaryKey(),
    subjectType: consentSubject("subject_type").notNull(),
    subjectId: integer("subject_id").notNull(),
    channels: text("channels").array().notNull(),
    wording: text("wording").notNull(),
    wordingVersion: text("wording_version").notNull(),
    source: text("source").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    givenAt: timestamp("given_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [index("consents_subject_idx").on(t.subjectType, t.subjectId)],
);

/** Numbers that replied STOP. Checked before every outbound text, whoever the number belongs to. */
export const smsOptOuts = pgTable("sms_opt_outs", {
  phone: text("phone").primaryKey(),
  optedOutAt: timestamp("opted_out_at", { withTimezone: true }).notNull().defaultNow(),
  keyword: text("keyword").notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_entity_idx").on(t.entityType, t.entityId)],
);
