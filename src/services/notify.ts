import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import type { Logger, Mailer } from "../deps.js";

export function createSmtpMailer(config: Config): Mailer {
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
    },
  };
}

/**
 * Email the admin. Never throws: a mail outage must not lose a customer's request,
 * which is already saved by the time this runs.
 */
export async function notifyAdmin(
  deps: { config: Config; mailer: Mailer },
  log: Logger,
  subject: string,
  lines: string[],
  adminPath: string,
): Promise<void> {
  const text = [...lines, "", `Open in dashboard: ${deps.config.PUBLIC_BASE_URL}${adminPath}`].join("\n");
  try {
    await deps.mailer.send({ to: deps.config.ADMIN_NOTIFY_EMAIL, subject: `[Sideroad] ${subject}`, text });
  } catch (err) {
    log.error({ err, subject }, "admin notification email failed");
  }
}
