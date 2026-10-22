import { DateTime } from "luxon";

const DEVICE_FMT = "yyyy-MM-dd HH:mm:ss";

export type LocalToUtcResult =
  | { ok: true; utc: Date; adjustedForGap: boolean }
  | { ok: false; reason: string };

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/**
 * Device clocks report wall-clock time with no offset. Interpret it in the
 * device's configured IANA zone and convert to a UTC instant.
 */
export function deviceLocalToUtc(local: string, zone: string): LocalToUtcResult {
  if (!isValidZone(zone)) return { ok: false, reason: `invalid timezone ${zone}` };
  const dt = DateTime.fromFormat(local.trim(), DEVICE_FMT, { zone });
  if (!dt.isValid) return { ok: false, reason: `unparseable timestamp "${local}"` };
  // Luxon shifts non-existent DST-gap times forward; detect that so it can be flagged.
  const adjustedForGap = dt.toFormat(DEVICE_FMT) !== local.trim();
  return { ok: true, utc: dt.toUTC().toJSDate(), adjustedForGap };
}

/** Sanity bounds for punches: rejects obviously wrong device clocks. */
export function isPlausiblePunch(utc: Date, now = new Date(), maxFutureSkewMin = 10): boolean {
  const t = utc.getTime();
  return t >= Date.UTC(2000, 0, 1) && t <= now.getTime() + maxFutureSkewMin * 60_000;
}

/** Start/end (UTC) of a calendar day in a zone, e.g. "today" in Asia/Manila. */
export function dayBoundsUtc(isoDate: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(isoDate, { zone }).startOf("day");
  return { start: start.toUTC().toJSDate(), end: start.plus({ days: 1 }).toUTC().toJSDate() };
}

export function todayIn(zone: string, now = new Date()): string {
  return DateTime.fromJSDate(now).setZone(zone).toISODate()!;
}

/** UTC offset in whole hours, as ZKTeco's TimeZone option expects. */
export function zoneOffsetHours(zone: string, at = new Date()): number {
  return Math.round(DateTime.fromJSDate(at).setZone(zone).offset / 60);
}

export function formatForDevice(d: Date, zone: string): string {
  return DateTime.fromJSDate(d).setZone(zone).toFormat(DEVICE_FMT);
}
