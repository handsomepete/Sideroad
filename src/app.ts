import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { Eta } from "eta";
import Fastify, { type FastifyServerOptions } from "fastify";
import type { Deps } from "./deps.js";
import { formatPhone } from "./domain/phone.js";
import { SERVICES, serviceLabel } from "./domain/services.js";
import { formatDateTime } from "./domain/time.js";
import { adminRoutes } from "./routes/admin/index.js";
import { publicRoutes } from "./routes/public.js";
import { twilioRoutes } from "./routes/twilio.js";
import { MAX_PHOTO_BYTES } from "./services/photos.js";

declare module "fastify" {
  interface FastifyReply {
    view(template: string, data?: Record<string, unknown>): FastifyReply;
  }
  interface FastifyInstance {
    deps: Deps;
    rateLimits: boolean;
  }
}

const viewsDir = fileURLToPath(new URL("../views", import.meta.url));

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "script-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Trust X-Forwarded-For only from a reverse proxy on this machine (loopback, or the Unix socket, which
 * has no address), and only `hops` entries deep. The client's own X-Forwarded-For value is never
 * believed, so it can't dodge rate limits by inventing addresses.
 */
export function localProxyTrust(hops: number) {
  const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  return (address: string | undefined, hop: number) =>
    hop < hops && (hop > 0 || !address || LOCAL.has(address));
}

export interface AppOptions {
  logger?: FastifyServerOptions["logger"];
  /** Tests turn this off so they can submit forms freely. */
  rateLimits?: boolean;
}

export async function buildApp(deps: Deps, opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: deps.config.TRUST_PROXY > 0 ? localProxyTrust(deps.config.TRUST_PROXY) : false,
    bodyLimit: 1024 * 1024,
  });
  app.decorate("deps", deps);
  app.decorate("rateLimits", opts.rateLimits ?? true);

  const eta = new Eta({ views: viewsDir, cache: deps.config.NODE_ENV === "production", autoEscape: true });
  const globals = {
    services: SERVICES,
    serviceLabel,
    formatPhone,
    fmt: formatDateTime,
    // Null until Twilio is set up; templates then leave out the "text us" lines.
    phoneE164: deps.config.TWILIO_PHONE_NUMBER ?? null,
    phoneDisplay: deps.config.TWILIO_PHONE_NUMBER ? formatPhone(deps.config.TWILIO_PHONE_NUMBER) : null,
  };
  app.decorateReply("view", function (template: string, data: Record<string, unknown> = {}) {
    return this.type("text/html; charset=utf-8").send(eta.render(template, { ...globals, ...data }));
  });

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(formbody);
  await app.register(multipart, {
    attachFieldsToBody: "keyValues",
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 40, fieldSize: 100_000 },
  });
  await app.register(rateLimit, { global: false });

  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    if (!reply.hasHeader("Content-Security-Policy")) reply.header("Content-Security-Policy", CSP);
    if (deps.config.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    if (request.url.startsWith("/admin")) reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((err: { code?: string; statusCode?: number }, request, reply) => {
    if (err.code === "FST_REQ_FILE_TOO_LARGE" || err.code === "FST_FILES_LIMIT") {
      return reply.code(413).view("error", {
        title: "Photo too large",
        heading: "That photo is too large",
        message: "Photos can be up to 10 MB. Please go back and choose a smaller one, or text it to us instead.",
      });
    }
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 429) {
      return reply.code(429).view("error", {
        title: "Slow down",
        heading: "Too many attempts",
        message: "Please wait a few minutes and try again.",
      });
    }
    if (status === 500) request.log.error({ err }, "request failed");
    return reply.code(status).view("error", {
      title: "Something went wrong",
      heading: status === 500 ? "Something went wrong" : "We couldn't handle that request",
      message: "Please try again. If it keeps happening, text us and we'll sort it out.",
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).view("error", {
      title: "Not found",
      heading: "Page not found",
      message: "That page doesn't exist.",
    }),
  );

  await app.register(publicRoutes);
  await app.register(twilioRoutes);
  await app.register(adminRoutes, { prefix: "/admin" });
  return app;
}
