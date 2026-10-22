import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env";
import { ah } from "../../lib/http";
import { dayBoundsUtc, todayIn } from "../../lib/time";
import { departmentScope } from "../../middleware/authenticate";
import { deviceStatus } from "../../integrations/deviceStatus";

export function dashboardRouter(db: PrismaClient, cfg: Env) {
  const r = Router();
  r.get("/summary", ah(async (req, res) => {
    const zone = cfg.DEFAULT_TIMEZONE;
    const date = todayIn(zone);
    const { start, end } = dayBoundsUtc(date, zone);
    const scope = departmentScope(req.user!);
    const empWhere = { status: "ACTIVE" as const, ...scope };
    const punchWhere = { punchedAt: { gte: start, lt: end }, isSimulated: false, ...(scope.departmentId ? { employee: { departmentId: scope.departmentId } } : {}) };

    const [totalEmployees, devices, txToday, presentRows, processed, recentSync, openIncidents] = await Promise.all([
      db.employee.count({ where: empWhere }),
      db.device.findMany({ select: { isEnabled: true, lastSeenAt: true, pushDelaySeconds: true, protocol: true } }),
      db.rawAttendanceTransaction.count({ where: punchWhere }),
      db.rawAttendanceTransaction.findMany({ where: { ...punchWhere, employeeId: { not: null } }, distinct: ["employeeId"], select: { employeeId: true } }),
      db.processedAttendance.groupBy({ by: ["status"], where: { workDate: new Date(`${date}T00:00:00Z`), employee: empWhere }, _count: true, _sum: { lateMinutes: true } }),
      db.syncJob.findMany({ orderBy: { startedAt: "desc" }, take: 10, include: { device: { select: { name: true } } } }),
      db.notification.count({ where: { resolvedAt: null } }),
    ]);
    const real = devices.filter((d) => d.protocol !== "MOCK");
    const statuses = real.map((d) => deviceStatus(d, cfg.DEVICE_ONLINE_THRESHOLD_SEC));
    const late = await db.processedAttendance.count({ where: { workDate: new Date(`${date}T00:00:00Z`), lateMinutes: { gt: 0 }, employee: empWhere } });

    res.json({
      date, timezone: zone,
      totalEmployees,
      devices: {
        total: real.length,
        online: statuses.filter((s) => s === "ONLINE").length,
        offline: statuses.filter((s) => s === "OFFLINE").length,
        neverConnected: statuses.filter((s) => s === "NEVER_CONNECTED").length,
        disabled: statuses.filter((s) => s === "DISABLED").length,
      },
      transactionsToday: txToday,
      employeesWithPunchToday: presentRows.length,
      // Rule-based figures come from processed attendance (Phase 6 engine).
      // null means "not yet calculated", which is different from zero.
      processed: processed.length ? {
        byStatus: Object.fromEntries(processed.map((p) => [p.status, p._count])),
        lateArrivals: late,
      } : null,
      recentSyncJobs: recentSync,
      openIncidents,
    });
  }));
  return r;
}
