import type { DeviceProtocol } from "@prisma/client";

/** The subset of a device record the integration layer needs. */
export interface DeviceRecord {
  id: string;
  serialNumber: string;
  protocol: DeviceProtocol;
  isEnabled: boolean;
  timezone: string;
  allowedIpCidrs: string[];
  attLogStamp: string | null;
  operLogStamp: string | null;
  pushDelaySeconds: number;
  lastSeenAt: Date | null;
}

export interface NewPunch {
  deviceId: string;
  deviceUserId: string;
  employeeId: string | null;
  punchedAt: Date;
  deviceLocalTime: string;
  punchState: number | null;
  verifyMode: number | null;
  workCode: string | null;
  sourceTxnId: string | null;
  rawLine: string | null;
  dedupKey: string;
  isSimulated: boolean;
  syncJobId: string;
}

export interface SyncCounts {
  received: number;
  imported: number;
  duplicate: number;
  rejected: number;
  unmapped: number;
}

export interface CommLogEntry {
  deviceId: string | null;
  serialNumber: string | null;
  method: string;
  path: string;
  table: string | null;
  statusCode: number;
  outcome: string;
  summary: string | null;
  remoteIp: string | null;
  durationMs: number | null;
}

export interface IncidentInput {
  key: string; // stable per unresolved incident, e.g. "DEVICE_OFFLINE:<deviceId>"
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  message: string;
  deviceId?: string | null;
}

/** Persistence port used by the device integration layer. Prisma implementation + in-memory test double. */
export interface IntegrationStore {
  findDeviceBySerial(serial: string): Promise<DeviceRecord | null>;
  markSeen(deviceId: string, ip: string, at: Date, info?: { firmwareVersion?: string | null; pushVersion?: string | null; userCount?: number | null; attLogCount?: number | null }): Promise<void>;
  setStamp(deviceId: string, table: "ATTLOG" | "OPERLOG", stamp: string): Promise<void>;
  setDeviceError(deviceId: string, error: string, at: Date): Promise<void>;
  resolveEmployees(deviceId: string, pins: string[]): Promise<Map<string, string>>;
  insertPunches(rows: NewPunch[]): Promise<number>; // returns rows actually inserted (duplicates skipped)
  startSync(deviceId: string, kind: string): Promise<string>;
  finishSync(id: string, counts: SyncCounts, error?: string): Promise<void>;
  logComm(entry: CommLogEntry): Promise<void>;
  nextCommand(deviceId: string): Promise<{ seq: number; command: string } | null>; // marks SENT
  completeCommand(deviceId: string, seq: number, returnCode: number, result: string | null): Promise<boolean>;
  raiseIncident(i: IncidentInput): Promise<void>;
  resolveIncident(key: string): Promise<void>;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: "VERIFIED" | "NOT_VERIFIED" | "NOT_SUPPORTED";
  message: string;
  lastSeenAt: Date | null;
}

/** Each protocol supplies its own adapter; nothing assumes one protocol for all terminals. */
export interface DeviceAdapter {
  readonly protocol: DeviceProtocol;
  testConnection(device: DeviceRecord): Promise<ConnectionTestResult>;
  requestAttendanceRange?(device: DeviceRecord, from: Date, to: Date, requestedById: string): Promise<{ queued: boolean; message: string }>;
}
