import type { FastifyInstance, FastifyRequest } from "fastify";
import { CONSENT } from "../domain/consent.js";
import { TRADE_SERVICES, toServiceSlug } from "../domain/services.js";
import {
  parseForm,
  requestFormSchema,
  submitRequest,
  submitTrade,
  submitWaitlist,
  tradeFormSchema,
  waitlistFormSchema,
  type SubmissionMeta,
} from "../services/intake.js";
import { PhotoError } from "../services/photos.js";

type Body = Record<string, unknown>;

const THANKS = {
  request: {
    eyebrow: "Request received",
    heading: "Thanks, we've got it.",
    message: "We'll look at your job and get back to you soon with a local trade who can do it.",
    showText: true,
  },
  waitlist: {
    eyebrow: "Waitlist",
    heading: "We're not in your area yet.",
    message:
      "We've added you to the waitlist. We're growing out from Erin and Wellington County, and we'll let you know as soon as we reach you.",
    showText: false,
  },
  trade: {
    eyebrow: "Thanks for joining",
    heading: "You're on the list.",
    message:
      "We review every trade before sending work. We'll be in touch to check your insurance and references, then start sending jobs in your area.",
    showText: false,
  },
} as const;

function meta(request: FastifyRequest): SubmissionMeta {
  return { ip: request.ip, userAgent: request.headers["user-agent"] };
}

/** Text fields only, for echoing back into a form after a validation error. Files are never echoed. */
function formValues(body: Body): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === "string" || Array.isArray(v)));
}

/** Bots fill in the hidden "website" field. Pretend it worked and store nothing. */
function isBot(body: Body): boolean {
  return typeof body.website === "string" && body.website.trim() !== "";
}

export async function publicRoutes(app: FastifyInstance) {
  const { deps } = app;
  const formLimit: { rateLimit?: { max: number; timeWindow: string } } = app.rateLimits ? { rateLimit: { max: 10, timeWindow: "10 minutes" } } : {};

  app.get("/", async (_request, reply) => reply.view("landing", {}));

  app.get("/privacy", async (_request, reply) => reply.view("privacy", { title: "Privacy" }));

  app.get("/healthz", async () => ({ ok: true }));

  // ----- homeowner request -----
  app.get<{ Querystring: { service?: string; location?: string } }>("/request", async (request, reply) =>
    reply.view("request", {
      title: "Get a quote",
      values: { service: toServiceSlug(request.query.service), location: request.query.location ?? "" },
      errors: {},
      consentText: CONSENT.homeowner.text,
    }),
  );

  app.post("/request", { config: formLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    if (isBot(body)) return reply.redirect("/thanks/request", 303);

    const render = (errors: Record<string, string>) =>
      reply.code(400).view("request", {
        title: "Get a quote",
        values: formValues(body),
        errors,
        consentText: CONSENT.homeowner.text,
      });

    const parsed = parseForm(requestFormSchema, body);
    if (!parsed.ok) return render(parsed.errors);

    const photo = Buffer.isBuffer(body.photo) ? body.photo : undefined;
    try {
      const result = await submitRequest(deps, request.log, parsed.data, meta(request), photo);
      return reply.redirect(`/thanks/${result.kind}`, 303);
    } catch (err) {
      if (err instanceof PhotoError) return render({ photo: err.message });
      throw err;
    }
  });

  // ----- trade signup -----
  const tradeView = (values: Record<string, unknown>, errors: Record<string, string>) => ({
    title: "Join as a trade",
    values,
    errors,
    tradeServices: TRADE_SERVICES,
    towns: deps.coverage.towns,
    consentText: CONSENT.trade.text,
  });

  app.get("/trades/join", async (_request, reply) => reply.view("trade-join", tradeView({}, {})));

  app.post("/trades/join", { config: formLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    if (isBot(body)) return reply.redirect("/thanks/trade", 303);
    const parsed = parseForm(tradeFormSchema, body);
    if (!parsed.ok) return reply.code(400).view("trade-join", tradeView(formValues(body), parsed.errors));
    await submitTrade(deps, request.log, parsed.data, meta(request));
    return reply.redirect("/thanks/trade", 303);
  });

  // ----- waitlist -----
  const waitlistView = (values: Record<string, unknown>, errors: Record<string, string>) => ({
    title: "Join the waitlist",
    values,
    errors,
    consentText: CONSENT.waitlist.text,
  });

  app.get("/waitlist", async (_request, reply) => reply.view("waitlist", waitlistView({}, {})));

  app.post("/waitlist", { config: formLimit }, async (request, reply) => {
    const body = (request.body ?? {}) as Body;
    if (isBot(body)) return reply.redirect("/thanks/waitlist", 303);
    const parsed = parseForm(waitlistFormSchema, body);
    if (!parsed.ok) return reply.code(400).view("waitlist", waitlistView(formValues(body), parsed.errors));
    await submitWaitlist(deps, request.log, parsed.data, meta(request));
    return reply.redirect("/thanks/waitlist", 303);
  });

  app.get<{ Params: { kind: string } }>("/thanks/:kind", async (request, reply) => {
    const kind = request.params.kind as keyof typeof THANKS;
    const copy = THANKS[kind];
    if (!copy) return reply.callNotFound();
    return reply.view("thanks", { title: "Thanks", ...copy });
  });
}
