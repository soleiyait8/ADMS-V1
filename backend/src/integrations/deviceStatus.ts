export type DeviceStatus = "ONLINE" | "OFFLINE" | "NEVER_CONNECTED" | "DISABLED";

/**
 * A device is ONLINE only if an authenticated request from it was received recently.
 * Nothing else (configuration, a successful ping of its IP, mock data) marks it online.
 */
export function deviceStatus(
  d: { isEnabled: boolean; lastSeenAt: Date | null; pushDelaySeconds: number },
  thresholdSec: number,
  now = new Date(),
): DeviceStatus {
  if (!d.isEnabled) return "DISABLED";
  if (!d.lastSeenAt) return "NEVER_CONNECTED";
  const limit = Math.max(thresholdSec, d.pushDelaySeconds * 3) * 1000;
  return now.getTime() - d.lastSeenAt.getTime() <= limit ? "ONLINE" : "OFFLINE";
}
