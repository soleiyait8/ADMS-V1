import { Router } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { departmentScope, requirePermission } from "../../middleware/authenticate";
import { audit, diff } from "../audit/audit";

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00Z`));
const base = z.object({
  employeeNo: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9-]+$/),
  firstName: z.string().trim().min(1).max(80),
  middleName: z.string().trim().max(80).nullish(),
  lastName: z.string().trim().min(1).max(80),
  departmentId: z.string().uuid().nullish(),
  positionId: z.string().uuid().nullish(),
  siteId: z.string().uuid().nullish(),
  employmentStatus: z.enum(["REGULAR", "PROBATIONARY", "CONTRACTUAL", "PROJECT_BASED", "PART_TIME", "INTERN"]).optional(),
  dateHired: dateStr.nullish(),
  email: z.string().email().max(254).nullish(),
  phone: z.string().max(32).nullish(),
});

export function employeesRouter(db: PrismaClient) {
  const r = Router();

  const scoped = async (req: import("express").Request, id: string) => {
    const emp = await db.employee.findFirst({ where: { id, ...departmentScope(req.user!) } });
    if (!emp) throw notFound("Employee");
    return emp;
  };

  r.get("/", requirePermission("employees.read"), ah(async (req, res) => {
    const q = parse(pagination.extend({
      search: z.string().max(100).optional(),
      departmentId: z.string().uuid().optional(),
      status: z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]).optional(),
    }), req.query);
    const where: Prisma.EmployeeWhereInput = {
      ...departmentScope(req.user!),
      ...(q.departmentId && req.user!.permissions.has("data.all_departments") ? { departmentId: q.departmentId } : {}),
      status: q.status ?? { not: "ARCHIVED" },
      ...(q.search ? { OR: [
        { employeeNo: { contains: q.search, mode: "insensitive" } },
        { firstName: { contains: q.search, mode: "insensitive" } },
        { lastName: { contains: q.search, mode: "insensitive" } },
      ] } : {}),
    };
    const [total, data] = await Promise.all([
      db.employee.count({ where }),
      db.employee.findMany({
        where, orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        include: { department: { select: { id: true, name: true } }, position: { select: { id: true, title: true } } },
      }),
    ]);
    res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
  }));

  r.get("/:id", requirePermission("employees.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    await scoped(req, id);
    res.json(await db.employee.findUnique({
      where: { id },
      include: {
        department: true, position: true, site: true,
        deviceMappings: { include: { device: { select: { id: true, name: true, serialNumber: true } } } },
        shiftAssignments: { include: { schedule: true }, orderBy: { effectiveFrom: "desc" } },
      },
    }));
  }));

  r.get("/:id/history", requirePermission("employees.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    await scoped(req, id);
    res.json(await db.employeeHistory.findMany({ where: { employeeId: id }, orderBy: { createdAt: "desc" }, take: 200 }));
  }));

  r.post("/", requirePermission("employees.write"), ah(async (req, res) => {
    const b = parse(base, req.body);
    if (!req.user!.permissions.has("data.all_departments") && b.departmentId !== req.user!.departmentId) throw forbidden();
    const emp = await db.$transaction(async (tx) => {
      const e = await tx.employee.create({ data: b }); // unique employeeNo enforced by DB -> 409
      await tx.employeeHistory.create({ data: { employeeId: e.id, changedById: req.user!.id, changes: { created: { from: null, to: e.employeeNo } } } });
      await audit(tx, req, "employee.create", "Employee", e.id, undefined, e);
      return e;
    });
    res.status(201).json(emp);
  }));

  r.patch("/:id", requirePermission("employees.write"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(base.partial().extend({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() }), req.body);
    const before = await scoped(req, id);
    if (before.status === "ARCHIVED") throw badRequest("Archived employees cannot be edited");
    const updated = await db.$transaction(async (tx) => {
      const after = await tx.employee.update({ where: { id }, data: b });
      const changes = diff(before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
      if (Object.keys(changes).length) {
        await tx.employeeHistory.create({ data: { employeeId: id, changedById: req.user!.id, changes: changes as Prisma.InputJsonValue } });
        await audit(tx, req, "employee.update", "Employee", id, before, after);
      }
      return after;
    });
    res.json(updated);
  }));

  r.post("/:id/archive", requirePermission("employees.archive"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const before = await scoped(req, id);
    const after = await db.$transaction(async (tx) => {
      const a = await tx.employee.update({ where: { id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
      await tx.employeeHistory.create({ data: { employeeId: id, changedById: req.user!.id, changes: { status: { from: before.status, to: "ARCHIVED" } } } });
      await audit(tx, req, "employee.archive", "Employee", id, before, a);
      return a;
    });
    res.json(after);
  }));

  // Device user (PIN) mappings. Adding a mapping re-links earlier UNMAPPED punches for that PIN.
  r.post("/:id/device-mappings", requirePermission("employees.write"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ deviceId: z.string().uuid(), deviceUserId: z.string().regex(/^[A-Za-z0-9]{1,24}$/) }), req.body);
    await scoped(req, id);
    const result = await db.$transaction(async (tx) => {
      const m = await tx.deviceUserMapping.create({ data: { employeeId: id, deviceId: b.deviceId, deviceUserId: b.deviceUserId } });
      const relinked = await tx.rawAttendanceTransaction.updateMany({
        where: { deviceId: b.deviceId, deviceUserId: b.deviceUserId, status: "UNMAPPED" },
        data: { employeeId: id, status: "IMPORTED" },
      });
      await audit(tx, req, "employee.device_mapping.create", "Employee", id, undefined, { ...m, relinkedPunches: relinked.count });
      return { mapping: m, relinkedPunches: relinked.count };
    });
    res.status(201).json(result);
  }));

  r.delete("/:id/device-mappings/:mappingId", requirePermission("employees.write"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const mappingId = parse(z.string().uuid(), req.params.mappingId);
    await scoped(req, id);
    const m = await db.deviceUserMapping.findFirst({ where: { id: mappingId, employeeId: id } });
    if (!m) throw notFound("Mapping");
    await db.deviceUserMapping.delete({ where: { id: mappingId } });
    await audit(db, req, "employee.device_mapping.delete", "Employee", id, m);
    res.status(204).end();
  }));

  return r;
}
