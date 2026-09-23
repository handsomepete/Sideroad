import type { DbOrTx } from "../db/client.js";
import { auditLog } from "../db/schema.js";

export async function audit(
  db: DbOrTx,
  entry: {
    actor: string;
    action: string;
    entityType: string;
    entityId: number | string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: String(entry.entityId),
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}
