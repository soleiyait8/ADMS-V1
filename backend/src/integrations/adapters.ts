import type { DeviceProtocol, PrismaClient } from "@prisma/client";
import { deviceStatus } from "./deviceStatus";
import { DeviceCommands } from "./zkteco-push/protocol";
import type { ConnectionTestResult, DeviceAdapter, DeviceRecord } from "./types";

/**
 * ZK PUSH: the server cannot dial the device; the device calls us. A "connection test"
 * therefore reports the last verified contact and queues an INFO command whose
 * completion (visible in the command list) proves two-way communication.
 */
export class ZkPushAdapter implements DeviceAdapter {
  readonly protocol = "ZK_PUSH" as const;
  constructor(private db: PrismaClient, private thresholdSec: number) {}

  async testConnection(device: DeviceRecord): Promise<ConnectionTestResult> {
    await this.db.deviceCommand.create({ data: { deviceId: device.id, command: DeviceCommands.info() } });
    const status = deviceStatus(device, this.thresholdSec);
    return status === "ONLINE"
      ? { ok: true, status: "VERIFIED", lastSeenAt: device.lastSeenAt, message: "Device contacted the server recently. An INFO command was queued; its result confirms two-way communication." }
      : { ok: false, status: "NOT_VERIFIED", lastSeenAt: device.lastSeenAt, message: status === "NEVER_CONNECTED"
          ? "The server has never received an authenticated request from this device. Check the device's Cloud Server (ADMS) settings and network path."
          : "No recent contact from the device. An INFO command was queued and will be delivered when the device next polls." };
  }

  async requestAttendanceRange(device: DeviceRecord, from: Date, to: Date, requestedById: string) {
    await this.db.deviceCommand.create({
      data: { deviceId: device.id, command: DeviceCommands.queryAttLog(from, to, device.timezone), requestedById },
    });
    return { queued: true, message: "Re-upload request queued. Duplicates are skipped automatically." };
  }
}

/** TCP/4370 pull (standalone SDK). Interface only until verified against the device. */
export class ZkSdkLanAdapter implements DeviceAdapter {
  readonly protocol = "ZK_SDK_LAN" as const;
  async testConnection(device: DeviceRecord): Promise<ConnectionTestResult> {
    return { ok: false, status: "NOT_SUPPORTED", lastSeenAt: device.lastSeenAt, message: "LAN/SDK pull adapter is not implemented. Use ADMS push for this device." };
  }
}

export class MockAdapter implements DeviceAdapter {
  readonly protocol = "MOCK" as const;
  async testConnection(device: DeviceRecord): Promise<ConnectionTestResult> {
    return { ok: false, status: "NOT_VERIFIED", lastSeenAt: device.lastSeenAt, message: "SIMULATED device: no real connection exists." };
  }
}

export function adapterRegistry(db: PrismaClient, thresholdSec: number): Record<DeviceProtocol, DeviceAdapter | null> {
  return {
    ZK_PUSH: new ZkPushAdapter(db, thresholdSec),
    ZK_SDK_LAN: new ZkSdkLanAdapter(),
    VENDOR_API: null,
    MOCK: new MockAdapter(),
  };
}
