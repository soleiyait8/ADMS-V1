import { describe, expect, it } from "vitest";
import { dayBoundsUtc, deviceLocalToUtc, isPlausiblePunch, todayIn } from "../src/lib/time";
import { ipAllowed, ipInCidr } from "../src/lib/net";
import { deviceStatus } from "../src/integrations/deviceStatus";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { hashPassword, passwordPolicyError, verifyPassword } from "../src/auth/password";
import { dedupKeyFor } from "../src/integrations/ingest/ingestService";

describe("time-zone conversion", () => {
  it("interprets device wall clock in Asia/Manila (UTC+8)", () => {
    const r = deviceLocalToUtc("2026-10-22 08:00:00", "Asia/Manila");
    expect(r.ok && r.utc.toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });
  it("handles a punch just after midnight (overnight shift) as the next calendar day", () => {
    const r = deviceLocalToUtc("2026-10-23 00:30:00", "Asia/Manila");
    expect(r.ok && r.utc.toISOString()).toBe("2026-10-22T16:30:00.000Z");
  });
  it("flags DST-gap times in zones that observe DST", () => {
    const r = deviceLocalToUtc("2026-03-08 02:30:00", "America/New_York");
    expect(r.ok && r.adjustedForGap).toBe(true);
  });
  it("rejects invalid zones and timestamps", () => {
    expect(deviceLocalToUtc("2026-10-22 08:00:00", "Mars/Olympus").ok).toBe(false);
    expect(deviceLocalToUtc("2026-02-30 08:00:00", "Asia/Manila").ok).toBe(false);
  });
  it("rejects implausible device clocks", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    expect(isPlausiblePunch(new Date("1999-12-31T00:00:00Z"), now)).toBe(false);
    expect(isPlausiblePunch(new Date("2026-10-22T00:05:00Z"), now)).toBe(true);
    expect(isPlausiblePunch(new Date("2026-10-22T01:00:00Z"), now)).toBe(false);
  });
  it("computes Manila day bounds and 'today'", () => {
    expect(dayBoundsUtc("2026-10-22", "Asia/Manila").start.toISOString()).toBe("2026-10-21T16:00:00.000Z");
    expect(todayIn("Asia/Manila", new Date("2026-10-21T17:00:00Z"))).toBe("2026-10-22");
  });
});

describe("network allowlist", () => {
  it("matches CIDRs including IPv4-mapped IPv6", () => {
    expect(ipInCidr("192.168.10.25", "192.168.10.0/24")).toBe(true);
    expect(ipInCidr("::ffff:192.168.10.25", "192.168.10.0/24")).toBe(true);
    expect(ipInCidr("192.168.11.25", "192.168.10.0/24")).toBe(false);
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipAllowed("1.2.3.4", [])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["10.0.0.0/8"])).toBe(false);
  });
});

describe("device status is evidence-based", () => {
  const now = new Date("2026-10-22T00:10:00Z");
  it("never-connected devices are not online", () => {
    expect(deviceStatus({ isEnabled: true, lastSeenAt: null, pushDelaySeconds: 10 }, 180, now)).toBe("NEVER_CONNECTED");
  });
  it("online only within the threshold", () => {
    expect(deviceStatus({ isEnabled: true, lastSeenAt: new Date("2026-10-22T00:08:00Z"), pushDelaySeconds: 10 }, 180, now)).toBe("ONLINE");
    expect(deviceStatus({ isEnabled: true, lastSeenAt: new Date("2026-10-22T00:00:00Z"), pushDelaySeconds: 10 }, 180, now)).toBe("OFFLINE");
  });
  it("disabled overrides everything", () => {
    expect(deviceStatus({ isEnabled: false, lastSeenAt: now, pushDelaySeconds: 10 }, 180, now)).toBe("DISABLED");
  });
});

describe("security helpers", () => {
  it("AES-GCM round-trips and detects tampering", () => {
    const key = "a".repeat(64);
    const enc = encryptSecret("comm-key-123", key);
    expect(decryptSecret(enc, key)).toBe("comm-key-123");
    const tampered = enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA");
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
  it("hashes with Argon2id and verifies", async () => {
    const h = await hashPassword("Correct-Horse-9");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "Correct-Horse-9")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });
  it("enforces password policy", () => {
    expect(passwordPolicyError("short")).not.toBeNull();
    expect(passwordPolicyError("alllowercaseletters")).not.toBeNull();
    expect(passwordPolicyError("Reasonable-Pass-2026")).toBeNull();
  });
  it("dedup keys are stable and device-scoped", () => {
    const a = dedupKeyFor("dev1", { pin: "1", localTime: "2026-10-22 08:00:00" });
    expect(a).toBe(dedupKeyFor("dev1", { pin: "1", localTime: "2026-10-22 08:00:00" }));
    expect(a).not.toBe(dedupKeyFor("dev2", { pin: "1", localTime: "2026-10-22 08:00:00" }));
    expect(dedupKeyFor("dev1", { pin: "1", localTime: "x", sourceTxnId: "T9" })).toBe(dedupKeyFor("dev1", { pin: "2", localTime: "y", sourceTxnId: "T9" }));
  });
});
