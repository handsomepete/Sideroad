import { and, asc, count, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  auditLog,
  consents,
  homeowners,
  messages,
  photos,
  requestStatus,
  requests,
  smsOptOuts,
} from "../../db/schema.js";
import { audit } from "../../services/audit.js";
import { SendBlockedError, sendAdminSms } from "../../services/sms.js";
import type { AdminView } from "./index.js";

export const REQUEST_STATUSES = requestStatus.enumValues;
type RequestStatus = (typeof REQUEST_STATUSES)[number];

interface ListQuery {
  status?: string;
  service?: string;
  source?: string;
  coverage?: string;
  q?: string;
}

export async function requestRoutes(app: FastifyInstance, opts: { view: AdminView }) {
  const { db } = app.deps;
  const { view } = opts;

  app.get<{ Querystring: ListQuery }>("/requests", async (request, reply) => {
    const f = request.query;
    const where: SQL[] = [];
    if (f.status && (REQUEST_STATUSES as readonly string[]).includes(f.status))
      where.push(eq(requests.status, f.status as RequestStatus));
    else if (!f.status) where.push(sql`${requests.status} not in ('DONE', 'CLOSED', 'SPAM')`);
    if (f.service) where.push(eq(requests.service, f.service));
    if (f.source === "web" || f.source === "sms") where.push(eq(requests.source, f.source));
    if (f.coverage === "in" || f.coverage === "unknown" || f.coverage === "out") where.push(eq(requests.coverage, f.coverage));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(homeowners.name, like),
          ilike(homeowners.mobile, like),
          ilike(homeowners.email, like),
          ilike(requests.locationText, like),
          ilike(requests.description, like),
        )!,
      );
    }
    const rows = await db
      .select({
        id: requests.id,
        status: requests.status,
        service: requests.service,
        source: requests.source,
        coverage: requests.coverage,
        locationText: requests.locationText,
        postalCode: requests.postalCode,
        createdAt: requests.createdAt,
        updatedAt: requests.updatedAt,
        name: homeowners.name,
        mobile: homeowners.mobile,
      })
      .from(requests)
      .innerJoin(homeowners, eq(requests.homeownerId, homeowners.id))
      .where(and(...where))
      .orderBy(desc(requests.updatedAt))
      .limit(300);
    const counts = await db.select({ status: requests.status, n: count() }).from(requests).groupBy(requests.status);
    return view(reply, "requests", {
      title: "Requests",
      nav: "requests",
      rows,
      filters: f,
      statuses: REQUEST_STATUSES,
      counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    });
  });

  const renderDetail = async (reply: FastifyReply, id: number, extra: Record<string, unknown> = {}) => {
    const [row] = await db
      .select({ request: requests, homeowner: homeowners })
      .from(requests)
      .innerJoin(homeowners, eq(requests.homeownerId, homeowners.id))
      .where(eq(requests.id, id));
    if (!row) return reply.callNotFound();
    const [thread, photoRows, consentRows, auditRows, optOut] = await Promise.all([
      db.select().from(messages).where(eq(messages.requestId, id)).orderBy(asc(messages.createdAt), asc(messages.id)),
      db.select().from(photos).where(eq(photos.requestId, id)).orderBy(asc(photos.id)),
      db
        .select()
        .from(consents)
        .where(and(eq(consents.subjectType, "homeowner"), eq(consents.subjectId, row.homeowner.id)))
        .orderBy(desc(consents.givenAt)),
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "request"), eq(auditLog.entityId, String(id))))
        .orderBy(desc(auditLog.createdAt))
        .limit(50),
      row.homeowner.mobile
        ? db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, row.homeowner.mobile)).then((r) => r[0] ?? null)
        : Promise.resolve(null),
    ]);
    const otherRequests = await db
      .select({ id: requests.id, status: requests.status, service: requests.service, createdAt: requests.createdAt })
      .from(requests)
      .where(and(eq(requests.homeownerId, row.homeowner.id), sql`${requests.id} <> ${id}`))
      .orderBy(desc(requests.createdAt));
    return view(reply, "request", {
      title: `Request #${id}`,
      nav: "requests",
      r: row.request,
      h: row.homeowner,
      thread,
      photos: photoRows,
      consents: consentRows,
      auditRows,
      optOut,
      otherRequests,
      statuses: REQUEST_STATUSES,
      replyError: null,
      draft: "",
      ...extra,
    });
  };

  app.get<{ Params: { id: string } }>("/requests/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    return renderDetail(reply, id);
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/requests/:id/status", async (request, reply) => {
    const id = Number(request.params.id);
    const status = request.body?.status as RequestStatus;
    if (!Number.isInteger(id) || !REQUEST_STATUSES.includes(status)) return reply.code(400).send("Bad status");
    await db.transaction(async (tx) => {
      const [before] = await tx.select({ status: requests.status }).from(requests).where(eq(requests.id, id)).for("update");
      if (!before) return;
      await tx.update(requests).set({ status, updatedAt: sql`now()` }).where(eq(requests.id, id));
      await audit(tx, {
        actor: request.admin!.name,
        action: "request.status",
        entityType: "request",
        entityId: id,
        before: { status: before.status },
        after: { status },
      });
    });
    return reply.redirect(`/admin/requests/${id}`, 303);
  });

  app.post<{ Params: { id: string }; Body: { body?: string } }>("/requests/:id/reply", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    const text = typeof request.body?.body === "string" ? request.body.body : "";
    try {
      await sendAdminSms(app.deps, request.log, { requestId: id }, text, request.admin!.name);
    } catch (err) {
      if (!(err instanceof SendBlockedError)) throw err;
      reply.code(400);
      return renderDetail(reply, id, { replyError: err.message, draft: text });
    }
    return reply.redirect(`/admin/requests/${id}#thread`, 303);
  });
}
