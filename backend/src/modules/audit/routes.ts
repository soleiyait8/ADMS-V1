import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/authenticate";

export function auditRouter(db: PrismaClient) {
  const r = Router();
  r.get("/", requirePermission("audit.read"), ah(async (req, res) => {
    const q = parse(pagination.extend({
      entityType: z.string().max(40).optional(), entityId: z.string().max(64).optional(),
      action: z.string().max(80).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
    }), req.query);
    const where = {
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.from || q.to ? { createdAt: { gte: q.from, lt: q.to } } : {}),
    };
    const [total, rows] = await Promise.all([
      db.auditLog.count({ where }),
      db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { actor: { select: { email: true, fullName: true } } } }),
    ]);
    res.json({ data: rows.map((a) => ({ ...a, id: a.id.toString() })), meta: pageMeta(q.page, q.pageSize, total) });
  }));
  return r;
}
