import type { PrismaClient } from "@prisma/client";
import { deviceStatus } from "../integrations/deviceStatus";
import type { IntegrationStore } from "../integrations/types";
import { logger } from "../lib/logger";

/** Raises one DEVICE_OFFLINE incident per offline device; resolved automatically on the next real contact. */
export function startDeviceMonitor(db: PrismaClient, store: IntegrationStore, thresholdSec: number, intervalSec: number) {
  const tick = async () => {
    try {
      const devices = await db.device.findMany({ where: { isEnabled: true, protocol: { not: "MOCK" } } });
      for (const d of devices) {
        if (deviceStatus(d, thresholdSec) === "OFFLINE") {
          await store.raiseIncident({
            key: `DEVICE_OFFLINE:${d.id}`, type: "DEVICE_OFFLINE", severity: "CRITICAL",
            title: `Device offline: ${d.name}`,
            message: `No contact from ${d.name} (${d.serialNumber}) since ${d.lastSeenAt?.toISOString()}.`,
            deviceId: d.id,
          });
        }
      }
    } catch (err) {
      logger.error({ err }, "device monitor failed");
    }
  };
  const handle = setInterval(tick, intervalSec * 1000);
  handle.unref();
  void tick();
  return () => clearInterval(handle);
}
