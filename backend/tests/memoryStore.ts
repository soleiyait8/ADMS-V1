import type { CommLogEntry, DeviceRecord, IncidentInput, IntegrationStore, NewPunch, SyncCounts } from "../src/integrations/types";

/** In-memory IntegrationStore with the same uniqueness semantics as the Prisma store. */
export class MemoryStore implements IntegrationStore {
  devices = new Map<string, DeviceRecord & { firmwareVersion?: string | null; lastSeenIp?: string }>();
  mappings = new Map<string, string>(); // `${deviceId}|${pin}` -> employeeId
  punches: NewPunch[] = [];
  sync = new Map<string, { kind: string; counts?: SyncCounts; error?: string }>();
  comm: CommLogEntry[] = [];
  commands: Array<{ deviceId: string; seq: number; command: string; status: string; returnCode?: number }> = [];
  incidents = new Map<string, { input: IncidentInput; count: number; resolved: boolean }>();
  private seq = 0;

  addDevice(d: Partial<DeviceRecord> & { id: string; serialNumber: string }) {
    this.devices.set(d.id, {
      protocol: "ZK_PUSH", isEnabled: true, timezone: "Asia/Manila", allowedIpCidrs: [],
      attLogStamp: null, operLogStamp: null, pushDelaySeconds: 10, lastSeenAt: null, ...d,
    });
  }
  async findDeviceBySerial(s: string) { return [...this.devices.values()].find((d) => d.serialNumber === s) ?? null; }
  async markSeen(id: string, ip: string, at: Date, info?: { firmwareVersion?: string | null }) {
    const d = this.devices.get(id)!; d.lastSeenAt = at; d.lastSeenIp = ip;
    if (info?.firmwareVersion) d.firmwareVersion = info.firmwareVersion;
  }
  async setStamp(id: string, t: "ATTLOG" | "OPERLOG", s: string) {
    const d = this.devices.get(id)!; if (t === "ATTLOG") d.attLogStamp = s; else d.operLogStamp = s;
  }
  async setDeviceError() {}
  async resolveEmployees(deviceId: string, pins: string[]) {
    const m = new Map<string, string>();
    for (const p of pins) { const e = this.mappings.get(`${deviceId}|${p}`); if (e) m.set(p, e); }
    return m;
  }
  async insertPunches(rows: NewPunch[]) {
    let n = 0;
    for (const r of rows) if (!this.punches.some((p) => p.dedupKey === r.dedupKey)) { this.punches.push(r); n++; }
    return n;
  }
  async startSync(_d: string, kind: string) { const id = `job-${this.sync.size + 1}`; this.sync.set(id, { kind }); return id; }
  async finishSync(id: string, counts: SyncCounts, error?: string) { this.sync.set(id, { ...this.sync.get(id)!, counts, error }); }
  async logComm(e: CommLogEntry) { this.comm.push(e); }
  queue(deviceId: string, command: string) { this.commands.push({ deviceId, seq: ++this.seq, command, status: "QUEUED" }); return this.seq; }
  async nextCommand(deviceId: string) {
    const c = this.commands.find((x) => x.deviceId === deviceId && x.status === "QUEUED");
    if (!c) return null; c.status = "SENT"; return { seq: c.seq, command: c.command };
  }
  async completeCommand(deviceId: string, seq: number, rc: number) {
    const c = this.commands.find((x) => x.deviceId === deviceId && x.seq === seq && x.status === "SENT");
    if (!c) return false; c.status = rc === 0 ? "SUCCEEDED" : "FAILED"; c.returnCode = rc; return true;
  }
  async raiseIncident(i: IncidentInput) {
    const cur = this.incidents.get(i.key);
    if (cur && !cur.resolved) cur.count++; else this.incidents.set(i.key, { input: i, count: 1, resolved: false });
  }
  async resolveIncident(key: string) { const c = this.incidents.get(key); if (c) c.resolved = true; }
}
