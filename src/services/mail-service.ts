import nodemailer from "nodemailer";

import { eq, and, lt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { emailOutbox } from "../db/schema.js";
import type { EmailOutboxRow } from "../db/schema.js";
import { decryptSecret } from "../crypto/encryption.js";
import { logger } from "../logger.js";
import { renderTemplate } from "./mail-templates.js";
import type { MailTemplate } from "./mail-templates.js";
import { getMailSettings } from "./settings.js";

export interface QueueMailInput {
  to: string;
  template: MailTemplate;
  data: Record<string, string>;
}

/**
 * Renders and records the message first, then delivers: the `log` driver marks the row SENT in
 * process (dev and SMTP-less deployments), while `smtp` hands it to the email worker.
 */
export async function queueMail(input: QueueMailInput): Promise<void> {
  const settings = await getMailSettings(db);
  const rendered = renderTemplate(input.template, input.data);

  const [row] = await db
    .insert(emailOutbox)
    .values({
      toEmail: input.to.trim().toLowerCase(),
      subject: rendered.subject,
      bodyHtml: rendered.bodyHtml,
      bodyText: rendered.bodyText,
      template: input.template,
      status: "PENDING",
    })
    .returning();
  if (!row) return;

  if (settings.driver === "log") {
    logger.info(
      { to: row.toEmail, template: input.template },
      "mail (log driver): %s",
      rendered.bodyText,
    );
    await db
      .update(emailOutbox)
      .set({ status: "SENT", sentAt: new Date(), attempts: 1 })
      .where(eq(emailOutbox.id, row.id));
    return;
  }

  try {
    const { enqueueEmail } = await import("../queue/email-queue.js");
    await enqueueEmail(row.id);
  } catch (error) {
    // The row stays PENDING; the worker's retry sweep picks it up.
    logger.warn({ err: error, outboxId: row.id }, "email enqueue failed");
  }
}

export async function deliverOutboxRow(outboxId: string): Promise<void> {
  const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId)).limit(1);
  if (!row) return;
  await deliverRow(row);
}

async function deliverRow(row: EmailOutboxRow): Promise<void> {
  if (row.status === "SENT") return;

  const settings = await getMailSettings(db);
  if (settings.driver === "log") {
    await db
      .update(emailOutbox)
      .set({ status: "SENT", sentAt: new Date(), attempts: row.attempts + 1 })
      .where(eq(emailOutbox.id, row.id));
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      auth:
        settings.smtp.user.length > 0
          ? {
              user: settings.smtp.user,
              pass:
                settings.smtp.passwordEncrypted.length > 0
                  ? decryptSecret(settings.smtp.passwordEncrypted)
                  : "",
            }
          : undefined,
    });

    await transporter.sendMail({
      from: `"${settings.fromName}" <${settings.fromEmail}>`,
      to: row.toEmail,
      subject: row.subject,
      html: row.bodyHtml,
      text: row.bodyText,
    });

    await db
      .update(emailOutbox)
      .set({ status: "SENT", sentAt: new Date(), attempts: row.attempts + 1, lastError: null })
      .where(eq(emailOutbox.id, row.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pengiriman email gagal.";
    const attempts = row.attempts + 1;
    await db
      .update(emailOutbox)
      .set({
        status: attempts >= 5 ? "FAILED" : "PENDING",
        attempts,
        lastError: message,
      })
      .where(eq(emailOutbox.id, row.id));
    logger.warn({ err: error, outboxId: row.id }, "email delivery failed");
  }
}

/** Retries pending rows (enqueue failures, transient SMTP errors) and drops old sent rows. */
export async function retryPendingEmails(limit = 20): Promise<{ retried: number; pruned: number }> {
  const pending = await db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.status, "PENDING"), lt(emailOutbox.attempts, 5)))
    .limit(limit);

  for (const row of pending) await deliverRow(row);

  const pruned = await db
    .delete(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, "SENT"),
        sql`${emailOutbox.createdAt} < now() - interval '30 days'`,
      ),
    )
    .returning({ id: emailOutbox.id });

  return { retried: pending.length, pruned: pruned.length };
}
