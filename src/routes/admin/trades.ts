import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { auditLog, consents, messages, smsOptOuts, tradeStatus, trades } from "../../db/schema.js";
import { TRADE_SERVICES } from "../../domain/services.js";
import { todayInToronto } from "../../domain/time.js";
import { audit } from "../../services/audit.js";
import { SendBlockedError, sendAdminSms } from "../../services/sms.js";
import type { AdminView } from "./index.js";

export const TRADE_STATUSES = tradeStatus.enumValues;
type TradeStatus = (typeof TRADE_STATUSES)[number];

export async function tradeRoutes(app: FastifyInstance, opts: { view: AdminView }) {
  const { db, coverage } = app.deps;
  const { view } = opts;

  app.get<{ Querystring: { status?: string; service?: string; town?: string; q?: string } }>(
    "/trades",
    async (request, reply) => {
      const f = request.query;
      const where: SQL[] = [];
      if (f.status && (TRADE_STATUSES as readonly string[]).includes(f.status))
        where.push(eq(trades.status, f.status as TradeStatus));
      if (f.service) where.push(sql`${f.service} = any(${trades.services})`);
      if (f.town) where.push(sql`${f.town} = any(${trades.towns})`);
      if (f.q?.trim()) {
        const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
        where.push(
          or(
            ilike(trades.businessName, like),
            ilike(trades.contactName, like),
            ilike(trades.mobile, like),
            ilike(trades.email, like),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(trades)
        .where(and(...where))
        .orderBy(desc(trades.createdAt))
        .limit(300);
      return view(reply, "trades", {
        title: "Trades",
        nav: "trades",
        rows,
        filters: f,
        statuses: TRADE_STATUSES,
        tradeServices: TRADE_SERVICES,
        towns: coverage.towns,
        today: todayInToronto(),
      });
    },
  );

  const renderDetail = async (reply: FastifyReply, id: number, extra: Record<string, unknown> = {}) => {
    const [t] = await db.select().from(trades).where(eq(trades.id, id));
    if (!t) return reply.callNotFound();
    const [thread, consentRows, auditRows, optOut] = await Promise.all([
      db.select().from(messages).where(eq(messages.tradeId, id)).orderBy(asc(messages.createdAt), asc(messages.id)),
      db
        .select()
        .from(consents)
        .where(and(eq(consents.subjectType, "trade"), eq(consents.subjectId, id)))
        .orderBy(desc(consents.givenAt)),
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "trade"), eq(auditLog.entityId, String(id))))
        .orderBy(desc(auditLog.createdAt))
        .limit(50),
      db.select().from(smsOptOuts).where(eq(smsOptOuts.phone, t.mobile)).then((r) => r[0] ?? null),
    ]);
    return view(reply, "trade", {
      title: t.businessName,
      nav: "trades",
      t,
      thread,
      consents: consentRows,
      auditRows,
      optOut,
      statuses: TRADE_STATUSES,
      today: todayInToronto(),
      replyError: null,
      draft: "",
      ...extra,
    });
  };

  app.get<{ Params: { id: string } }>("/trades/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    return renderDetail(reply, id);
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>("/trades/:id/status", async (request, reply) => {
    const id = Number(request.params.id);
    const status = request.body?.status as TradeStatus;
    if (!Number.isInteger(id) || !TRADE_STATUSES.includes(status)) return reply.code(400).send("Bad status");
    await db.transaction(async (tx) => {
      const [before] = await tx.select({ status: trades.status }).from(trades).where(eq(trades.id, id)).for("update");
      if (!before) return;
      await tx.update(trades).set({ status, updatedAt: sql`now()` }).where(eq(trades.id, id));
      await audit(tx, {
        actor: request.admin!.name,
        action: "trade.status",
        entityType: "trade",
        entityId: id,
        before: { status: before.status },
        after: { status },
      });
    });
    return reply.redirect(`/admin/trades/${id}`, 303);
  });

  app.post<{ Params: { id: string }; Body: { body?: string } }>("/trades/:id/reply", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    const text = typeof request.body?.body === "string" ? request.body.body : "";
    try {
      await sendAdminSms(app.deps, request.log, { tradeId: id }, text, request.admin!.name);
    } catch (err) {
      if (!(err instanceof SendBlockedError)) throw err;
      reply.code(400);
      return renderDetail(reply, id, { replyError: err.message, draft: text });
    }
    return reply.redirect(`/admin/trades/${id}#thread`, 303);
  });
}
