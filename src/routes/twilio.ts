import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleInboundSms, handleStatusCallback, isValidTwilioSignature, type InboundParams } from "../services/sms.js";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

export async function twilioRoutes(app: FastifyInstance) {
  const { deps } = app;

  /** Reject anything not signed by Twilio with our auth token. */
  const verify = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = (request.body ?? {}) as Record<string, unknown>;
    const signature = request.headers["x-twilio-signature"];
    if (!isValidTwilioSignature(deps.config, typeof signature === "string" ? signature : undefined, request.url, params)) {
      request.log.warn({ url: request.url }, "rejected Twilio webhook with bad signature");
      return reply.code(403).type("text/plain").send("Invalid signature");
    }
  };

  app.post("/webhooks/twilio/sms", { preHandler: verify }, async (request, reply) => {
    const result = await handleInboundSms(deps, request.log, request.body as InboundParams);
    request.log.info({ outcome: result.outcome }, "inbound SMS handled");
    // No auto-reply in Phase 1. Twilio sends its own confirmation for STOP/START.
    return reply.type("text/xml").send(EMPTY_TWIML);
  });

  app.post("/webhooks/twilio/status", { preHandler: verify }, async (request, reply) => {
    await handleStatusCallback(deps, request.body as InboundParams);
    return reply.code(204).send();
  });
}
