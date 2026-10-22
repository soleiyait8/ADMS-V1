import type { Prisma, PrismaClient } from "@prisma/client";
import type { Request } from "express";

type Db = PrismaClient | Prisma.TransactionClient;

export async function audit(
  db: Db,
  req: Request | null,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
  actorIdOverride?: string,
) {
  await db.auditLog.create({
    data: {
      actorUserId: actorIdOverride ?? req?.user?.id ?? null,
      action, entityType, entityId,
      before: before === undefined ? undefined : (JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue),
      after: after === undefined ? undefined : (JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue),
      ip: req?.ip ?? null,
      userAgent: req?.get("user-agent")?.slice(0, 255) ?? null,
    },
  });
}

/** Field-level diff for history tables; ignores timestamps. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (k === "updatedAt" || k === "createdAt") continue;
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const b = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a ?? null, to: b ?? null };
  }
  return out;
}
