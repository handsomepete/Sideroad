CREATE TYPE "public"."consent_subject" AS ENUM('homeowner', 'trade', 'waitlist');--> statement-breakpoint
CREATE TYPE "public"."contact_preference" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."coverage_status" AS ENUM('in', 'out', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('received', 'queued', 'sent', 'delivered', 'undelivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."request_source" AS ENUM('web', 'sms');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('NEW', 'CONTACTED', 'MATCHED', 'DONE', 'CLOSED', 'SPAM');--> statement-breakpoint
CREATE TYPE "public"."trade_status" AS ENUM('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('WAITING', 'NOTIFIED', 'REMOVED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" "consent_subject" NOT NULL,
	"subject_id" integer NOT NULL,
	"channels" text[] NOT NULL,
	"wording" text NOT NULL,
	"wording_version" text NOT NULL,
	"source" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "homeowners" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"mobile" text,
	"email" text,
	"preferred_contact" "contact_preference",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homeowners_mobile_unique" UNIQUE("mobile")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer,
	"trade_id" integer,
	"counterparty_phone" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"channel" "message_channel" DEFAULT 'sms' NOT NULL,
	"body" text NOT NULL,
	"twilio_sid" text,
	"status" "message_status" NOT NULL,
	"media_count" integer DEFAULT 0 NOT NULL,
	"sent_by" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_twilio_sid_unique" UNIQUE("twilio_sid")
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"message_id" integer,
	"stored_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"homeowner_id" integer NOT NULL,
	"service" text,
	"location_text" text,
	"postal_code" text,
	"town" text,
	"coverage" "coverage_status" DEFAULT 'unknown' NOT NULL,
	"description" text,
	"source" "request_source" NOT NULL,
	"status" "request_status" DEFAULT 'NEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_opt_outs" (
	"phone" text PRIMARY KEY NOT NULL,
	"opted_out_at" timestamp with time zone DEFAULT now() NOT NULL,
	"keyword" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"business_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"mobile" text NOT NULL,
	"email" text NOT NULL,
	"services" text[] NOT NULL,
	"towns" text[] NOT NULL,
	"insurance_provider" text NOT NULL,
	"insurance_expiry" date NOT NULL,
	"notes" text,
	"status" "trade_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"mobile" text,
	"postal_code" text,
	"location_text" text,
	"service" text,
	"status" "waitlist_status" DEFAULT 'WAITING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_trade_id_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_homeowner_id_homeowners_id_fk" FOREIGN KEY ("homeowner_id") REFERENCES "public"."homeowners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "consents_subject_idx" ON "consents" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "messages_request_idx" ON "messages" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "messages_trade_idx" ON "messages" USING btree ("trade_id");--> statement-breakpoint
CREATE INDEX "messages_phone_idx" ON "messages" USING btree ("counterparty_phone");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requests_homeowner_idx" ON "requests" USING btree ("homeowner_id");--> statement-breakpoint
CREATE INDEX "trades_mobile_idx" ON "trades" USING btree ("mobile");