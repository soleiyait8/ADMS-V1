import { DateTime } from "luxon";
import { ingestPunches } from "../ingest/ingestService";
import type { DeviceRecord, IntegrationStore } from "../types";

/**
 * Development/test only. Generates punches for MOCK devices, always flagged isSimulated=true
 * so they are visibly labelled in the UI and excluded from production reports.
 * Never marks a device as seen/online.
 */
export async function generateSimulatedPunches(
  store: IntegrationStore,
  device: DeviceRecord,
  pins: string[],
  date: string, // ISO date in device zone
) {
  if (device.protocol !== "MOCK") throw new Error("Simulated punches are only allowed for MOCK devices");
  const punches = pins.flatMap((pin, i) => {
    const day = DateTime.fromISO(date, { zone: device.timezone });
    const inT = day.set({ hour: 7, minute: 45 + (i % 30) });
    const outT = day.set({ hour: 17, minute: (i * 7) % 40 });
    return [
      { pin, localTime: inT.toFormat("yyyy-MM-dd HH:mm:ss"), punchState: 0, verifyMode: 15, workCode: null, rawLine: "SIMULATED" },
      { pin, localTime: outT.toFormat("yyyy-MM-dd HH:mm:ss"), punchState: 1, verifyMode: 15, workCode: null, rawLine: "SIMULATED" },
    ];
  });
  return ingestPunches(store, device, punches, { kind: "MOCK", isSimulated: true });
}
