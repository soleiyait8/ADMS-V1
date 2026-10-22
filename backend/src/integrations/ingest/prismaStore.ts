import { Prisma, type PrismaClient } from "@prisma/client";
import type { CommLogEntry, DeviceRecord, IncidentInput, IntegrationStore, NewPunch, SyncCounts } from "../types";

const deviceSelect = {
  id: true, serialNumber: true, protocol: true, isEnabled: true, timezone: true, allowedIpCidrs: true,
  attLogStamp: true, operLogStamp: true, pushDelaySeconds: true, lastSeenAt: true,
} satisfies Prisma.DeviceSelect;

export class PrismaIntegrationStore implements IntegrationStore {
  constructor(private db: PrismaClient) {}

  findDeviceBySerial(serial: string): Promise<DeviceRecord | null> {
    return this.db.device.findUnique({ where: { serialNumber: serial }, select: deviceSelect });
  }

  async markSeen(deviceId: string, ip: string, at: Date, info?: { firmwareVersion?: string | null; pushVersion?: string | null; userCount?: number | null; attLogCount?: number | null }) {
    await this.db.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: at,
        lastSeenIp: ip,
        ...(info?.firmwareVersion ? { firmwareVersion: info.firmwareVersion } : {}),
        ...(info?.pushVersion ? { pushVersion: info.pushVersion } : {}),
        ...(info?.userCount != null ? { deviceUserCount: info.userCount } : {}),
        ...(info?.attLogCount != null ? { deviceLogCount: info.attLogCount } : {}),
      },
    });
  }

  async setStamp(deviceId: string, table: "ATTLOG" | "OPERLOG", stamp: string) {
    await this.db.device.update({
      where: { id: deviceId },
      data: table === "ATTLOG" ? { attLogStamp: stamp } : { operLogStamp: stamp },
    });
  }

  async setDeviceError(deviceId: string, error: string, at: Date) {
    await this.db.device.update({ where: { id: deviceId }, data: { lastError: error.slice(0, 500), lastErrorAt: at } });
  }

  async resolveEmployees(deviceId: string, pins: string[]) {
    if (!pins.length) return new Map<string, string>();
    const rows = await this.db.deviceUserMapping.findMany({
      where: { deviceId, deviceUserId: { in: pins }, employee: { status: { not: "ARCHIVED" } } },
      select: { deviceUserId: true, employeeId: true },
    });
    return new Map(rows.map((r) => [r.deviceUserId, r.employeeId]));
  }

  async insertPunches(rows: NewPunch[]) {
    const r = await this.db.rawAttendanceTransaction.createMany({
      data: rows.map((p) => ({ ...p, status: p.employeeId ? "IMPORTED" : "UNMAPPED" })),
      skipDuplicates: true, // ON CONFLICT (dedupKey) DO NOTHING
    });
    return r.count;
  }

  async startSync(deviceId: string, kind: string) {
    return (await this.db.syncJob.create({ data: { deviceId, kind }, select: { id: true } })).id;
  }

  async finishSync(id: string, c: SyncCounts, error?: string) {
    await this.db.syncJob.update({
      where: { id },
      data: {
        status: error ? "FAILED" : c.rejected > 0 ? "PARTIAL" : "SUCCEEDED",
        recordsReceived: c.received, recordsImported: c.imported, recordsDuplicate: c.duplicate,
        recordsRejected: c.rejected, recordsUnmapped: c.unmapped, error: error?.slice(0, 1000), finishedAt: new Date(),
      },
    });
  }

  async logComm(e: CommLogEntry) {
    await this.db.deviceCommunicationLog.create({ data: { ...e, direction: "INBOUND" } });
  }

  async nextCommand(deviceId: string) {
    return this.db.$transaction(async (tx) => {
      const cmd = await tx.deviceCommand.findFirst({ where: { deviceId, status: "QUEUED" }, orderBy: { seq: "asc" } });
      if (!cmd) return null;
      await tx.deviceCommand.update({ where: { id: cmd.id }, data: { status: "SENT", sentAt: new Date() } });
      return { seq: cmd.seq, command: cmd.command };
    });
  }

  async completeCommand(deviceId: string, seq: number, returnCode: number, result: string | null) {
    const r = await this.db.deviceCommand.updateMany({
      where: { deviceId, seq, status: "SENT" },
      data: { status: returnCode === 0 ? "SUCCEEDED" : "FAILED", returnCode, result: result?.slice(0, 500), completedAt: new Date() },
    });
    return r.count > 0;
  }

  async raiseIncident(i: IncidentInput) {
    // One open row per incident key; repeats only bump the counter.
    await this.db.notification.upsert({
      where: { openIncidentKey: i.key },
      create: { type: i.type, severity: i.severity, title: i.title, message: i.message, deviceId: i.deviceId ?? null, openIncidentKey: i.key },
      update: { occurrenceCount: { increment: 1 }, lastSeenAt: new Date(), message: i.message },
    });
  }

  async resolveIncident(key: string) {
    await this.db.notification.updateMany({
      where: { openIncidentKey: key },
      data: { openIncidentKey: null, resolvedAt: new Date() },
    });
  }
}
