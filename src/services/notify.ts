import nodemailer from "nodemailer";
import { mailSettings, type Config } from "../config.js";
import type { Logger, Mailer } from "../deps.js";

export function createSmtpMailer(config: Config, log: Logger): Mailer {
  const mail = mailSettings(config);
  if (!mail) {
    log.warn({}, "email alerts are off: SMTP_URL, MAIL_FROM and ADMIN_NOTIFY_EMAIL are not set");
    return { enabled: false, async send() {} };
  }
  const transport = nodemailer.createTransport(mail.smtpUrl);
  return {
    enabled: true,
    async send({ to, subject, text }) {
      await transport.sendMail({ from: mail.from, to, subject, text });
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
  const to = deps.config.ADMIN_NOTIFY_EMAIL;
  if (!deps.mailer.enabled || !to) return;
  const text = [...lines, "", `Open in dashboard: ${deps.config.PUBLIC_BASE_URL}${adminPath}`].join("\n");
  try {
    await deps.mailer.send({ to, subject: `[Sideroad] ${subject}`, text });
  } catch (err) {
    log.error({ err, subject }, "admin notification email failed");
  }
}
