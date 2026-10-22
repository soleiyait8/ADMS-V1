import { sha256 } from "../../lib/crypto";
import { deviceLocalToUtc, isPlausiblePunch } from "../../lib/time";
import type { DeviceRecord, IntegrationStore, NewPunch, SyncCounts } from "../types";

export interface IncomingPunch {
  pin: string;
  localTime: string;
  punchState: number | null;
  verifyMode: number | null;
  workCode: string | null;
  rawLine: string | null;
  sourceTxnId?: string | null;
}

/**
 * Deduplication: ZK ATTLOG lines carry no transaction ID, so the natural key is
 * (device, device PIN, device wall-clock second). Re-uploads after a stamp reset or a
 * DATA QUERY produce identical keys and are skipped. When a protocol supplies a stable
 * transaction ID, that is used instead.
 */
export function dedupKeyFor(deviceId: string, p: { pin: string; localTime: string; sourceTxnId?: string | null }): string {
  return p.sourceTxnId
    ? sha256(`txn|${deviceId}|${p.sourceTxnId}`)
    : sha256(`att|${deviceId}|${p.pin}|${p.localTime}`);
}

export async function ingestPunches(
  store: IntegrationStore,
  device: DeviceRecord,
  punches: IncomingPunch[],
  opts: { kind: string; preRejected?: number; isSimulated?: boolean; now?: Date },
): Promise<SyncCounts & { syncJobId: string }> {
  const now = opts.now ?? new Date();
  const syncJobId = await store.startSync(device.id, opts.kind);
  const counts: SyncCounts = { received: punches.length + (opts.preRejected ?? 0), imported: 0, duplicate: 0, rejected: opts.preRejected ?? 0, unmapped: 0 };
  try {
    const mapping = await store.resolveEmployees(device.id, [...new Set(punches.map((p) => p.pin))]);
    const rows: NewPunch[] = [];
    const seen = new Set<string>();
    for (const p of punches) {
      const conv = deviceLocalToUtc(p.localTime, device.timezone);
      if (!conv.ok || !isPlausiblePunch(conv.utc, now)) {
        counts.rejected++;
        continue;
      }
      const dedupKey = dedupKeyFor(device.id, p);
      if (seen.has(dedupKey)) {
        counts.duplicate++; // duplicate within the same batch
        continue;
      }
      seen.add(dedupKey);
      const employeeId = mapping.get(p.pin) ?? null;
      if (!employeeId) counts.unmapped++;
      rows.push({
        deviceId: device.id,
        deviceUserId: p.pin,
        employeeId,
        punchedAt: conv.utc,
        deviceLocalTime: p.localTime,
        punchState: p.punchState,
        verifyMode: p.verifyMode,
        workCode: p.workCode,
        sourceTxnId: p.sourceTxnId ?? null,
        rawLine: p.rawLine,
        dedupKey,
        isSimulated: opts.isSimulated ?? false,
        syncJobId,
      });
    }
    const inserted = rows.length ? await store.insertPunches(rows) : 0;
    counts.imported = inserted;
    counts.duplicate += rows.length - inserted;
    await store.finishSync(syncJobId, counts);
    return { ...counts, syncJobId };
  } catch (err) {
    await store.finishSync(syncJobId, counts, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
