import { formatForDevice, zoneOffsetHours } from "../../lib/time";

export interface HandshakeOptions {
  serialNumber: string;
  attLogStamp: string | null;
  operLogStamp: string | null;
  delaySeconds: number;
  timezone: string;
}

/**
 * Response to GET /iclock/cdata?SN=...&options=all.
 * TransFlag deliberately requests attendance and operation logs only. It does NOT request
 * fingerprint/face templates (EnrollFP, FPImag) or attendance photos (AttPhoto).
 * NOTE: firmware may expect the older bitmask form of TransFlag (e.g. "1111000000"); verify on the device.
 */
export function handshakeResponse(o: HandshakeOptions): string {
  return [
    `GET OPTION FROM: ${o.serialNumber}`,
    `ATTLOGStamp=${o.attLogStamp ?? "None"}`,
    `OPERLOGStamp=${o.operLogStamp ?? "None"}`,
    "ATTPHOTOStamp=None",
    "ErrorDelay=30",
    `Delay=${o.delaySeconds}`,
    "TransTimes=00:00;14:05",
    "TransInterval=1",
    "TransFlag=TransData AttLog OpLog",
    `TimeZone=${zoneOffsetHours(o.timezone)}`,
    "Realtime=1",
    "Encrypt=None",
    "",
  ].join("\n");
}

/** Command line format sent in getrequest responses: "C:<id>:<command>" */
export const commandLine = (seq: number, command: string) => `C:${seq}:${command}\n`;

/** Only these commands can ever be queued for a device. */
export const DeviceCommands = {
  info: () => "INFO",
  check: () => "CHECK",
  reboot: () => "REBOOT",
  /** Ask the device to re-upload attendance in a range (recovery after outages). */
  queryAttLog: (from: Date, to: Date, zone: string) =>
    `DATA QUERY ATTLOG StartTime=${formatForDevice(from, zone)}\tEndTime=${formatForDevice(to, zone)}`,
} as const;

export const COMMAND_ALLOWLIST = /^(INFO|CHECK|REBOOT|DATA QUERY ATTLOG StartTime=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\tEndTime=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/;
