import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { requirePermission } from "../../middleware/authenticate";

export function syncRouter(db: PrismaClient) {
  const r = Router();
  r.get("/jobs", requirePermission("devices.read"), ah(async (req, res) => {
    const q = parse(pagination.extend({ deviceId: z.string().uuid().optional(), status: z.enum(["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]).optional() }), req.query);
    const where = { ...(q.deviceId ? { deviceId: q.deviceId } : {}), ...(q.status ? { status: q.status } : {}) };
    const [total, data] = await Promise.all([
      db.syncJob.count({ where }),
      db.syncJob.findMany({ where, orderBy: { startedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { device: { select: { name: true } } } }),
    ]);
    res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
  }));
  return r;
}
