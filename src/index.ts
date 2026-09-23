import { existsSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadConfig, twilioSettings } from "./config.js";
import { createDb } from "./db/client.js";
import { loadCoverage } from "./domain/coverage.js";
import { createSmtpMailer } from "./services/notify.js";
import { createTwilioMediaFetcher, createTwilioSender } from "./services/sms.js";

// Secrets live only in .env (gitignored, mode 600). Nothing is read from the service unit.
if (existsSync(".env")) process.loadEnvFile(".env");

const config = loadConfig();
const { db, pool } = createDb(config.DATABASE_URL);
const coverage = loadCoverage(fileURLToPath(new URL("../config/coverage.json", import.meta.url)));

// Used only for startup warnings, before Fastify's own logger exists.
const startupLog = {
  info: (_o: unknown, msg?: string) => console.log(msg),
  warn: (_o: unknown, msg?: string) => console.warn(msg),
  error: (o: unknown, msg?: string) => console.error(msg, o),
};
if (!twilioSettings(config)) console.warn("texting is off: TWILIO_ settings are not set");

const app = await buildApp(
  {
    config,
    db,
    coverage,
    sms: createTwilioSender(config),
    mailer: createSmtpMailer(config, startupLog),
    fetchMedia: createTwilioMediaFetcher(config),
  },
  {
    logger: {
      level: config.NODE_ENV === "production" ? "info" : "debug",
      // Keep secrets and form contents out of the logs.
      redact: ["req.headers.cookie", "req.headers.authorization", "req.headers[\"x-twilio-signature\"]"],
    },
  },
);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

if (config.SOCKET_PATH) {
  // Only the reverse proxy (in the sideroad group) can connect; nothing is exposed on a TCP port.
  await rm(config.SOCKET_PATH, { force: true });
  await app.listen({ path: config.SOCKET_PATH });
  await chmod(config.SOCKET_PATH, 0o660);
} else {
  await app.listen({ host: config.HOST, port: config.PORT });
}
