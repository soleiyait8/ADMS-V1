import { Router } from "express";
import { z } from "zod";
import type { DeviceProtocol, PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { badRequest, notFound } from "../../lib/errors";
import { isValidZone } from "../../lib/time";
import { requirePermission } from "../../middleware/authenticate";
import { deviceStatus } from "../../integrations/deviceStatus";
import type { DeviceAdapter } from "../../integrations/types";
import { audit } from "../audit/audit";

const cidr = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/);
const deviceBody = z.object({
  name: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().regex(/^[A-Za-z0-9_-]{4,64}$/, "Serial number: 4–64 letters, digits, _ or -"),
  model: z.string().max(64).nullish(),
  protocol: z.enum(["ZK_PUSH", "ZK_SDK_LAN", "VENDOR_API", "MOCK"]).default("ZK_PUSH"),
  siteId: z.string().uuid().nullish(),
  timezone: z.string().refine(isValidZone, "Invalid IANA timezone").default("Asia/Manila"),
  ipAddress: z.string().ip().nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  allowedIpCidrs: z.array(cidr).max(20).default([]),
  isEnabled: z.boolean().default(true),
  pushDelaySeconds: z.number().int().min(5).max(300).default(10),
});

export function devicesRouter(db: PrismaClient, cfg: Env, adapters: Record<DeviceProtocol, DeviceAdapter | null>) {
  const r = Router();
  const withStatus = <T extends { isEnabled: boolean; lastSeenAt: Date | null; pushDelaySeconds: number; protocol: DeviceProtocol }>(d: T) => ({
    ...d,
    status: deviceStatus(d, cfg.DEVICE_ONLINE_THRESHOLD_SEC),
    isSimulated: d.protocol === "MOCK",
  });

  r.get("/", requirePermission("devices.read"), ah(async (req, res) => {
    const q = parse(pagination.extend({ search: z.string().max(80).optional() }), req.query);
    const where = q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { serialNumber: { contains: q.search, mode: "insensitive" as const } }] } : {};
    const [total, rows] = await Promise.all([
      db.device.count({ where }),
      db.device.findMany({ where, orderBy: { name: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { site: { select: { name: true } }, _count: { select: { rawTransactions: true } } } }),
    ]);
    res.json({ data: rows.map(withStatus), meta: pageMeta(q.page, q.pageSize, total) });
  }));

  r.get("/:id", requirePermission("devices.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const d = await db.device.findUnique({ where: { id }, include: { site: true, _count: { select: { rawTransactions: true, userMappings: true } } } });
    if (!d) throw notFound("Device");
    res.json(withStatus(d));
  }));

  r.post("/", requirePermission("devices.write"), ah(async (req, res) => {
    const b = parse(deviceBody, req.body);
    if (b.protocol === "MOCK" && !cfg.ALLOW_MOCK_DEVICES) throw badRequest("Mock devices are disabled in this environment");
    // lastSeenAt is never accepted from clients: only real device traffic sets it.
    const d = await db.device.create({ data: b });
    await audit(db, req, "device.create", "Device", d.id, undefined, d);
    res.status(201).json(withStatus(d));
  }));

  r.patch("/:id", requirePermission("devices.write"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(deviceBody.partial().omit({ protocol: true }), req.body);
    const before = await db.device.findUnique({ where: { id } });
    if (!before) throw notFound("Device");
    const after = await db.device.update({ where: { id }, data: b });
    await audit(db, req, "device.update", "Device", id, before, after);
    res.json(withStatus(after));
  }));

  r.post("/:id/test-connection", requirePermission("devices.command"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const d = await db.device.findUnique({ where: { id } });
    if (!d) throw notFound("Device");
    const adapter = adapters[d.protocol];
    const result = adapter
      ? await adapter.testConnection(d)
      : { ok: false, status: "NOT_SUPPORTED", message: "No adapter for this protocol", lastSeenAt: d.lastSeenAt };
    await audit(db, req, "device.test_connection", "Device", id, undefined, result);
    res.json(result);
  }));

  r.post("/:id/request-attendance", requirePermission("devices.command"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }).refine((v) => v.from < v.to, "from must be before to"), req.body);
    const d = await db.device.findUnique({ where: { id } });
    if (!d) throw notFound("Device");
    const adapter = adapters[d.protocol];
    if (!adapter?.requestAttendanceRange) throw badRequest("This device's adapter does not support attendance re-upload");
    const out = await adapter.requestAttendanceRange(d, b.from, b.to, req.user!.id);
    await audit(db, req, "device.request_attendance", "Device", id, undefined, b);
    res.status(202).json(out);
  }));

  r.get("/:id/commands", requirePermission("devices.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    res.json(await db.deviceCommand.findMany({ where: { deviceId: id }, orderBy: { createdAt: "desc" }, take: 100 }));
  }));

  r.get("/:id/comm-logs", requirePermission("devices.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const q = parse(pagination, req.query);
    const where = { deviceId: id };
    const [total, data] = await Promise.all([
      db.deviceCommunicationLog.count({ where }),
      db.deviceCommunicationLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
  }));

  r.get("/:id/sync-jobs", requirePermission("devices.read"), ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    res.json(await db.syncJob.findMany({ where: { deviceId: id }, orderBy: { startedAt: "desc" }, take: 100 }));
  }));

  // Rejected/unknown-device traffic, useful during initial MB10-VL setup.
  r.get("/diagnostics/rejected", requirePermission("devices.read"), ah(async (_req, res) => {
    res.json(await db.deviceCommunicationLog.findMany({ where: { statusCode: { not: 200 } }, orderBy: { createdAt: "desc" }, take: 100 }));
  }));

  return r;
}
