import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { waitlistEntries, waitlistStatus } from "../../db/schema.js";
import { audit } from "../../services/audit.js";
import type { AdminView } from "./index.js";

export const WAITLIST_STATUSES = waitlistStatus.enumValues;
type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export async function waitlistRoutes(app: FastifyInstance, opts: { view: AdminView }) {
  const { db } = app.deps;

  app.get<{ Querystring: { status?: string; q?: string } }>("/waitlist", async (request, reply) => {
    const f = request.query;
    const where: SQL[] = [];
    if (f.status && (WAITLIST_STATUSES as readonly string[]).includes(f.status))
      where.push(eq(waitlistEntries.status, f.status as WaitlistStatus));
    if (f.q?.trim()) {
      const like = `%${f.q.trim().replace(/[%_\\]/g, "\\$&")}%`;
      where.push(
        or(
          ilike(waitlistEntries.postalCode, like),
          ilike(waitlistEntries.name, like),
          ilike(waitlistEntries.email, like),
          ilike(waitlistEntries.mobile, like),
          ilike(waitlistEntries.locationText, like),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(waitlistEntries)
      .where(and(...where))
      .orderBy(waitlistEntries.postalCode, desc(waitlistEntries.createdAt))
      .limit(500);
    return opts.view(reply, "waitlist", {
      title: "Waitlist",
      nav: "waitlist",
      rows,
      filters: f,
      statuses: WAITLIST_STATUSES,
    });
  });

  app.post<{ Params: { id: string }; Body: { status?: string; back?: string } }>(
    "/waitlist/:id/status",
    async (request, reply) => {
      const id = Number(request.params.id);
      const status = request.body?.status as WaitlistStatus;
      if (!Number.isInteger(id) || !WAITLIST_STATUSES.includes(status)) return reply.code(400).send("Bad status");
      await db.transaction(async (tx) => {
        const [before] = await tx
          .select({ status: waitlistEntries.status })
          .from(waitlistEntries)
          .where(eq(waitlistEntries.id, id))
          .for("update");
        if (!before) return;
        await tx.update(waitlistEntries).set({ status, updatedAt: sql`now()` }).where(eq(waitlistEntries.id, id));
        await audit(tx, {
          actor: request.admin!.name,
          action: "waitlist.status",
          entityType: "waitlist",
          entityId: id,
          before: { status: before.status },
          after: { status },
        });
      });
      return reply.redirect("/admin/waitlist", 303);
    },
  );
}
