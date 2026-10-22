import { Router } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { departmentScope, requirePermission } from "../../middleware/authenticate";

export function attendanceRouter(db: PrismaClient) {
  const r = Router();

  /** Raw device transactions (read-only, append-only source of truth). */
  r.get("/transactions", requirePermission("attendance.read"), ah(async (req, res) => {
    const q = parse(pagination.extend({
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      employeeId: z.string().uuid().optional(),
      deviceId: z.string().uuid().optional(),
      status: z.enum(["IMPORTED", "UNMAPPED"]).optional(),
      includeSimulated: z.enum(["true", "false"]).default("false"),
    }), req.query);
    const scope = departmentScope(req.user!);
    const where: Prisma.RawAttendanceTransactionWhereInput = {
      ...(q.from || q.to ? { punchedAt: { gte: q.from, lt: q.to } } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      ...(q.deviceId ? { deviceId: q.deviceId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.includeSimulated === "true" ? {} : { isSimulated: false }),
      // Scoped users only see mapped punches of their department.
      ...(scope.departmentId ? { employee: { departmentId: scope.departmentId } } : {}),
    };
    const [total, rows] = await Promise.all([
      db.rawAttendanceTransaction.count({ where }),
      db.rawAttendanceTransaction.findMany({
        where, orderBy: { punchedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: {
          employee: { select: { id: true, employeeNo: true, firstName: true, lastName: true } },
          device: { select: { id: true, name: true, timezone: true } },
        },
      }),
    ]);
    // BigInt ids are serialised as strings.
    res.json({ data: rows.map((t) => ({ ...t, id: t.id.toString() })), meta: pageMeta(q.page, q.pageSize, total) });
  }));

  return r;
}
