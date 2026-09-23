import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { messages, photos } from "../../db/schema.js";
import {
  SESSION_COOKIE,
  SESSION_HOURS,
  csrfMatches,
  csrfToken,
  isSessionFresh,
  newSessionValue,
  verifyPassword,
} from "../../services/auth.js";
import { requestRoutes } from "./requests.js";
import { tradeRoutes } from "./trades.js";
import { waitlistRoutes } from "./waitlist.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the admin auth hook: who is logged in and the CSRF token for their forms. */
    admin: { name: string; csrf: string } | null;
  }
}

export interface AdminView {
  (reply: FastifyReply, template: string, data: Record<string, unknown>): FastifyReply;
}

export async function adminRoutes(app: FastifyInstance) {
  const { deps } = app;
  const secret = deps.config.SESSION_SECRET;
  const secure = deps.config.NODE_ENV === "production";
  app.decorateRequest("admin", null);

  // Session cookie value: "<issuedAt>.<random>.<name>", signed with SESSION_SECRET.
  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.url === "/admin/login") return;
    const raw = request.cookies[SESSION_COOKIE];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (!unsigned?.valid || !unsigned.value || !isSessionFresh(unsigned.value)) {
      if (request.method === "GET") return reply.redirect("/admin/login", 303);
      return reply.code(401).type("text/plain").send("Not logged in");
    }
    const name = Buffer.from(unsigned.value.split(".")[2] ?? "", "base64url").toString("utf8") || "admin";
    request.admin = { name, csrf: csrfToken(secret, unsigned.value) };
    if (request.method === "POST") {
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!csrfMatches(secret, unsigned.value, body._csrf)) {
        return reply.code(403).type("text/plain").send("Form expired. Go back, reload the page and try again.");
      }
    }
  });

  /** Render an admin page with the CSRF token and admin name available to every form. */
  const view: AdminView = (reply, template, data) =>
    reply.view(`admin/${template}`, { ...data, admin: reply.request.admin });

  const loginLimit: { rateLimit?: { max: number; timeWindow: string } } = app.rateLimits ? { rateLimit: { max: 5, timeWindow: "15 minutes" } } : {};

  app.get("/login", async (_request, reply) => reply.view("admin/login", { title: "Log in", error: null }));

  app.post<{ Body: { name?: string; password?: string } }>(
    "/login",
    { config: loginLimit },
    async (request, reply) => {
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const name = (typeof request.body?.name === "string" ? request.body.name.trim() : "").slice(0, 40) || "admin";
      if (!password || !(await verifyPassword(password, deps.config.ADMIN_PASSWORD_HASH))) {
        request.log.warn({ ip: request.ip }, "failed admin login");
        return reply.code(401).view("admin/login", { title: "Log in", error: "Wrong password." });
      }
      const value = `${newSessionValue()}.${Buffer.from(name).toString("base64url")}`;
      reply.setCookie(SESSION_COOKIE, value, {
        signed: true,
        httpOnly: true,
        secure,
        sameSite: "strict",
        path: "/admin",
        maxAge: SESSION_HOURS * 3600,
      });
      return reply.redirect("/admin/requests", 303);
    },
  );

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/admin" });
    return reply.redirect("/admin/login", 303);
  });

  app.get("/", async (_request, reply) => reply.redirect("/admin/requests", 303));

  app.get<{ Params: { id: string } }>("/photos/:id", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return reply.callNotFound();
    const [photo] = await deps.db.select().from(photos).where(eq(photos.id, id));
    if (!photo) return reply.callNotFound();
    reply.header("Content-Security-Policy", "default-src 'none'; img-src 'self'; sandbox");
    reply.header("Content-Disposition", `inline; filename="photo-${photo.id}.${photo.storedName.split(".").pop()}"`);
    return reply.type(photo.mimeType).send(createReadStream(join(deps.config.UPLOAD_DIR, basename(photo.storedName))));
  });

  app.get("/messages", async (_request, reply) => {
    const rows = await deps.db.select().from(messages).orderBy(desc(messages.createdAt)).limit(200);
    return view(reply, "messages", { title: "All messages", nav: "messages", rows });
  });

  await app.register(requestRoutes, { view });
  await app.register(tradeRoutes, { view });
  await app.register(waitlistRoutes, { view });
}

