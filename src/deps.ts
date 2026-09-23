import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { CoverageConfig } from "./domain/coverage.js";

export interface SmsSender {
  /** False until Twilio is configured; the dashboard then explains why it can't send. */
  enabled: boolean;
  /** Send a text. Resolves with Twilio's message SID and initial status, or throws. */
  send(to: string, body: string): Promise<{ sid: string; status: string }>;
}

export interface Mailer {
  /** False until SMTP is configured; alerts are then skipped. */
  enabled: boolean;
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

/** Download an MMS attachment from Twilio. */
export type MediaFetcher = (url: string) => Promise<{ buffer: Buffer; contentType: string | null }>;

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Everything the app talks to. Tests swap the outside-world pieces (sms, mailer, fetchMedia) for fakes. */
export interface Deps {
  config: Config;
  db: Db;
  coverage: CoverageConfig;
  sms: SmsSender;
  mailer: Mailer;
  fetchMedia: MediaFetcher;
  now?: () => Date;
}
