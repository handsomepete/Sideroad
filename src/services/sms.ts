import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import twilio from "twilio";
import type { Config } from "../config.js";
import type { Deps, Logger, MediaFetcher, SmsSender } from "../deps.js";
import { consents, homeowners, messages, photos, requests, smsOptOuts, trades } from "../db/schema.js";
import { smsKeyword } from "../domain/consent.js";
import { formatPhone, normalizePhone } from "../domain/phone.js";
import { audit } from "./audit.js";
import { consentRow } from "./intake.js";
import { notifyAdmin } from "./notify.js";
import { detectImageType, savePhoto } from "./photos.js";

/** A text on an open request updated within this window is appended to it; otherwise a new request starts. */
export const THREAD_WINDOW_DAYS = 14;
const OPEN_STATUSES = ["NEW", "CONTACTED", "MATCHED"] as const;
const MAX_MEDIA = 5;

export function createTwilioSender(config: Config): SmsSender {
  const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
  return {
    async send(to, body) {
      const msg = await client.messages.create({
        to,
        from: config.TWILIO_PHONE_NUMBER,
        body,
        statusCallback: `${config.PUBLIC_BASE_URL}/webhooks/twilio/status`,
      });
      return { sid: msg.sid, status: msg.status };
    },
  };
}

export function createTwilioMediaFetcher(config: Config): MediaFetcher {
  const auth = Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString("base64");
  return async (url) => {
    // Only ever fetch from Twilio: the URL comes from a signed webhook, but be strict anyway.
    if (!/^https:\/\/api\.twilio\.com\//.test(url)) throw new Error(`refusing to fetch media from ${url}`);
    const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`media fetch failed: ${res.status}`);
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") };
  };
}

export function isValidTwilioSignature(
  config: Config,
  signature: string | undefined,
  path: string,
  params: Record<string, unknown>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(config.TWILIO_AUTH_TOKEN, signature, `${config.PUBLIC_BASE_URL}${path}`, params);
}

export type InboundParams = Record<string, string | undefined>;

export type InboundResult =
  | { outcome: "duplicate" }
  | { outcome: "opt-out" | "opt-in"; messageId: number; requestId: number | null; tradeId: number | null }
  | { outcome: "trade"; messageId: number; tradeId: number }
  | { outcome: "new-request" | "appended"; messageId: number; requestId: number };

/**
 * Handle a text sent to our Twilio number. Every message is stored.
 * - STOP/START keywords update the opt-out list and never create a request.
 * - Texts from a known trade's number are filed under that trade.
 * - Otherwise the text joins the sender's open request, or starts a new one.
 */
export async function handleInboundSms(
  deps: Pick<Deps, "db" | "config" | "mailer" | "fetchMedia" | "now">,
  log: Logger,
  params: InboundParams,
): Promise<InboundResult> {
  const sid = params.MessageSid ?? params.SmsSid;
  const rawFrom = params.From ?? "";
  if (!sid || !rawFrom) throw new Error("inbound SMS is missing MessageSid or From");
  const phone = normalizePhone(rawFrom) ?? rawFrom;
  const body = (params.Body ?? "").slice(0, 5000);
  const numMedia = Math.min(Number.parseInt(params.NumMedia ?? "0", 10) || 0, MAX_MEDIA);
  const keyword = smsKeyword(body);
  const now = deps.now?.() ?? new Date();

  const result = await deps.db.transaction(async (tx): Promise<InboundResult> => {
    // One sender at a time, so two quick texts from a new number can't both start a request.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${phone}))`);

    const [dupe] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.twilioSid, sid));
    if (dupe) return { outcome: "duplicate" };

    const insertMessage = async (link: { requestId?: number | null; tradeId?: number | null }) => {
      const [m] = await tx
        .insert(messages)
        .values({
          requestId: link.requestId ?? null,
          tradeId: link.tradeId ?? null,
          counterpartyPhone: phone,
          direction: "in",
          channel: "sms",
          body,
          twilioSid: sid,
          status: "received",
          mediaCount: numMedia,
          createdAt: now,
        })
        .returning({ id: messages.id });
      return m!.id;
    };

    const [trade] = await tx
      .select({ id: trades.id })
      .from(trades)
      .where(eq(trades.mobile, phone))
      .orderBy(desc(trades.id))
      .limit(1);
    const [owner] = await tx.select({ id: homeowners.id }).from(homeowners).where(eq(homeowners.mobile, phone));
    const openRequest = owner
      ? (
          await tx
            .select({ id: requests.id })
            .from(requests)
            .where(
              and(
                eq(requests.homeownerId, owner.id),
                inArray(requests.status, [...OPEN_STATUSES]),
                gt(requests.updatedAt, new Date(now.getTime() - THREAD_WINDOW_DAYS * 86_400_000)),
              ),
            )
            .orderBy(desc(requests.updatedAt))
            .limit(1)
        )[0]
      : undefined;

    if (keyword) {
      const link = { requestId: trade ? null : (openRequest?.id ?? null), tradeId: trade?.id ?? null };
      const messageId = await insertMessage(link);
      if (keyword === "stop") {
        await tx
          .insert(smsOptOuts)
          .values({ phone, keyword: body.trim().toUpperCase(), optedOutAt: now })
          .onConflictDoNothing();
        await tx
          .update(consents)
          .set({ withdrawnAt: now })
          .where(
            and(
              sql`${consents.withdrawnAt} is null`,
              sql`'sms' = any(${consents.channels})`,
              owner || trade
                ? sql`((${consents.subjectType} = 'homeowner' and ${consents.subjectId} = ${owner?.id ?? -1})
                   or (${consents.subjectType} = 'trade' and ${consents.subjectId} = ${trade?.id ?? -1}))`
                : sql`false`,
            ),
          );
      } else {
        await tx.delete(smsOptOuts).where(eq(smsOptOuts.phone, phone));
      }
      await audit(tx, { actor: "sms", action: `sms.${keyword}`, entityType: "phone", entityId: phone });
      return { outcome: keyword === "stop" ? "opt-out" : "opt-in", messageId, ...link };
    }

    if (trade) {
      const messageId = await insertMessage({ tradeId: trade.id });
      return { outcome: "trade", messageId, tradeId: trade.id };
    }

    if (openRequest) {
      await tx.update(requests).set({ updatedAt: now }).where(eq(requests.id, openRequest.id));
      const messageId = await insertMessage({ requestId: openRequest.id });
      return { outcome: "appended", messageId, requestId: openRequest.id };
    }

    let homeownerId = owner?.id;
    if (!homeownerId) {
      const [created] = await tx
        .insert(homeowners)
        .values({ mobile: phone, preferredContact: "sms" })
        .returning({ id: homeowners.id });
      homeownerId = created!.id;
      await tx.insert(consents).values(consentRow("homeowner", homeownerId, "inboundSms", "sms:inbound", null));
    }
    const [req] = await tx
      .insert(requests)
      .values({ homeownerId, description: body, source: "sms", coverage: "unknown", createdAt: now, updatedAt: now })
      .returning({ id: requests.id });
    await audit(tx, { actor: "sms", action: "request.create", entityType: "request", entityId: req!.id });
    const messageId = await insertMessage({ requestId: req!.id });
    return { outcome: "new-request", messageId, requestId: req!.id };
  });

  if (result.outcome === "duplicate") return result;

  // Photos are downloaded after the commit: a slow or failed download must not lose the text itself.
  const requestId = "requestId" in result ? result.requestId : null;
  if (numMedia > 0 && requestId) {
    for (let i = 0; i < numMedia; i++) {
      const url = params[`MediaUrl${i}`];
      if (!url) continue;
      try {
        const media = await deps.fetchMedia(url);
        if (!detectImageType(media.buffer)) {
          log.warn({ requestId, contentType: media.contentType }, "skipping non-image MMS attachment");
          continue;
        }
        const saved = await savePhoto(deps.config.UPLOAD_DIR, media.buffer);
        await deps.db.insert(photos).values({ requestId, messageId: result.messageId, ...saved });
      } catch (err) {
        log.error({ err, requestId, index: i }, "failed to store MMS photo");
      }
    }
  }

  const who = formatPhone(phone);
  const preview = body || (numMedia ? "(photo)" : "(empty)");
  switch (result.outcome) {
    case "new-request":
      await notifyAdmin(deps, log, `New text request #${result.requestId}`, [`From ${who}:`, "", preview], `/admin/requests/${result.requestId}`);
      break;
    case "appended":
      await notifyAdmin(deps, log, `Reply on request #${result.requestId}`, [`From ${who}:`, "", preview], `/admin/requests/${result.requestId}`);
      break;
    case "trade":
      await notifyAdmin(deps, log, `Text from trade #${result.tradeId}`, [`From ${who}:`, "", preview], `/admin/trades/${result.tradeId}`);
      break;
    case "opt-out":
    case "opt-in":
      await notifyAdmin(
        deps,
        log,
        `${who} ${result.outcome === "opt-out" ? "opted out of texts (STOP)" : "opted back in to texts (START)"}`,
        [`Message: ${body}`],
        result.requestId ? `/admin/requests/${result.requestId}` : result.tradeId ? `/admin/trades/${result.tradeId}` : "/admin/messages",
      );
      break;
  }
  return result;
}

export class SendBlockedError extends Error {}

/** Send a text typed by the admin. Refuses numbers that have opted out. Stores the message either way it goes. */
export async function sendAdminSms(
  deps: Pick<Deps, "db" | "sms">,
  log: Logger,
  target: { requestId: number } | { tradeId: number },
  body: string,
  admin: string,
): Promise<{ messageId: number }> {
  const text = body.trim();
  if (!text) throw new SendBlockedError("Message is empty.");
  if (text.length > 1600) throw new SendBlockedError("Message is too long (1600 characters maximum).");

  let to: string | null = null;
  if ("requestId" in target) {
    const [row] = await deps.db
      .select({ mobile: homeowners.mobile })
      .from(requests)
      .innerJoin(homeowners, eq(requests.homeownerId, homeowners.id))
      .where(eq(requests.id, target.requestId));
    if (!row) throw new SendBlockedError("Request not found.");
    to = row.mobile;
  } else {
    const [row] = await deps.db.select({ mobile: trades.mobile }).from(trades).where(eq(trades.id, target.tradeId));
    if (!row) throw new SendBlockedError("Trade not found.");
    to = row.mobile;
  }
  if (!to) throw new SendBlockedError("No mobile number on file.");

  const [optOut] = await deps.db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, to));
  if (optOut) throw new SendBlockedError(`${formatPhone(to)} replied STOP and can't be texted until they reply START.`);

  const link = "requestId" in target ? { requestId: target.requestId } : { tradeId: target.tradeId };
  let sid: string | null = null;
  let status: "queued" | "sent" | "failed" = "failed";
  let errorCode: string | null = null;
  try {
    const res = await deps.sms.send(to, text);
    sid = res.sid;
    status = res.status === "sent" ? "sent" : "queued";
  } catch (err) {
    errorCode = String((err as { code?: unknown }).code ?? "send_error");
    log.error({ err, ...link }, "outbound SMS failed");
  }

  const messageId = await deps.db.transaction(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({ ...link, counterpartyPhone: to, direction: "out", channel: "sms", body: text, twilioSid: sid, status, sentBy: admin, errorCode })
      .returning({ id: messages.id });
    if ("requestId" in target) {
      await tx.update(requests).set({ updatedAt: sql`now()` }).where(eq(requests.id, target.requestId));
    }
    await audit(tx, {
      actor: admin,
      action: status === "failed" ? "sms.send_failed" : "sms.send",
      entityType: "message",
      entityId: m!.id,
      after: { ...link, to, status },
    });
    return m!.id;
  });

  if (status === "failed") throw new SendBlockedError("Twilio rejected the message. It was saved as failed; check the logs.");
  return { messageId };
}

const STATUS_MAP: Record<string, "queued" | "sent" | "delivered" | "undelivered" | "failed"> = {
  accepted: "queued",
  queued: "queued",
  sending: "queued",
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

/** Twilio delivery receipts for messages we sent. */
export async function handleStatusCallback(deps: Pick<Deps, "db">, params: InboundParams): Promise<boolean> {
  const sid = params.MessageSid;
  const status = STATUS_MAP[params.MessageStatus ?? ""];
  if (!sid || !status) return false;
  const updated = await deps.db
    .update(messages)
    .set({ status, errorCode: params.ErrorCode ?? null })
    .where(and(eq(messages.twilioSid, sid), eq(messages.direction, "out")))
    .returning({ id: messages.id });
  return updated.length > 0;
}
