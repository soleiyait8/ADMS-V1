import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createDeviceApp } from "../src/app";
import { MemoryStore } from "./memoryStore";

/**
 * Exercises the real HTTP endpoints with recorded-format ZK PUSH traffic.
 * These are protocol test fixtures, NOT proof of MB10-VL compatibility:
 * they must be re-validated against traffic captured from the actual device.
 */
const SN = "MB10TEST0001";
let store: MemoryStore;
let app: ReturnType<typeof createDeviceApp>;

beforeEach(() => {
  store = new MemoryStore();
  store.addDevice({ id: "dev-1", serialNumber: SN });
  store.mappings.set("dev-1|1001", "emp-1001");
  app = createDeviceApp(store, 0);
});

const attlog = (lines: string[]) =>
  request(app).post(`/iclock/cdata?SN=${SN}&table=ATTLOG&Stamp=100`).set("Content-Type", "text/plain").send(lines.join("\n"));

describe("device authentication", () => {
  it("rejects unknown serial numbers and records one open incident", async () => {
    const r1 = await request(app).get("/iclock/cdata?SN=UNKNOWN999&options=all");
    await request(app).get("/iclock/cdata?SN=UNKNOWN999&options=all");
    expect(r1.status).toBe(403);
    expect(store.comm.every((c) => c.outcome === "UNKNOWN_DEVICE")).toBe(true);
    const inc = [...store.incidents.values()];
    expect(inc).toHaveLength(1); // no duplicate alerts for the same unresolved incident
    expect(inc[0]!.count).toBe(2);
  });
  it("rejects missing SN, disabled devices and disallowed IPs", async () => {
    expect((await request(app).get("/iclock/cdata")).status).toBe(403);
    store.devices.get("dev-1")!.isEnabled = false;
    expect((await request(app).get(`/iclock/cdata?SN=${SN}`)).status).toBe(403);
    store.devices.get("dev-1")!.isEnabled = true;
    store.devices.get("dev-1")!.allowedIpCidrs = ["10.99.0.0/16"];
    expect((await request(app).get(`/iclock/cdata?SN=${SN}`)).status).toBe(403);
    expect(store.devices.get("dev-1")!.lastSeenAt).toBeNull(); // rejected traffic never marks a device online
  });
  it("logs unsupported newer protocol variants instead of guessing", async () => {
    const r = await request(app).post(`/iclock/registry?SN=${SN}`).send("x");
    expect(r.status).toBe(404);
    expect(store.comm.at(-1)!.outcome).toBe("UNSUPPORTED_PROTOCOL_VARIANT");
  });
});

describe("handshake and heartbeat", () => {
  it("returns options and marks the device seen", async () => {
    const r = await request(app).get(`/iclock/cdata?SN=${SN}&options=all&pushver=2.4.1`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/plain/);
    expect(r.text).toContain(`GET OPTION FROM: ${SN}`);
    expect(store.devices.get("dev-1")!.lastSeenAt).not.toBeNull();
  });
  it("getrequest updates firmware from INFO and returns OK when idle", async () => {
    const r = await request(app).get(`/iclock/getrequest?SN=${SN}&INFO=${encodeURIComponent("Ver 8.0.4.2-20200111,2,0,10,192.168.1.201,10,7,12,2,111")}`);
    expect(r.text).toBe("OK");
    expect(store.devices.get("dev-1")!.firmwareVersion).toBe("8.0.4.2-20200111");
  });
});

describe("attendance upload", () => {
  it("imports punches, converts Manila time to UTC, and acknowledges", async () => {
    const r = await attlog(["1001\t2026-10-22 08:01:33\t0\t15\t0\t0\t0", "2002\t2026-10-22 08:05:00\t0\t1\t0\t0\t0"]);
    expect(r.status).toBe(200);
    expect(r.text).toBe("OK: 2");
    expect(store.punches).toHaveLength(2);
    const p = store.punches.find((x) => x.deviceUserId === "1001")!;
    expect(p.employeeId).toBe("emp-1001");
    expect(p.punchedAt.toISOString()).toBe("2026-10-22T00:01:33.000Z");
    expect(store.punches.find((x) => x.deviceUserId === "2002")!.employeeId).toBeNull(); // kept as UNMAPPED, not dropped
    expect(store.devices.get("dev-1")!.attLogStamp).toBe("100");
    const job = [...store.sync.values()][0]!;
    expect(job.counts).toMatchObject({ received: 2, imported: 2, duplicate: 0, rejected: 0, unmapped: 1 });
  });

  it("is idempotent: re-uploads and in-batch repeats are not duplicated", async () => {
    const line = "1001\t2026-10-22 08:01:33\t0\t15\t0\t0\t0";
    await attlog([line]);
    const r = await attlog([line, line, "1001\t2026-10-22 17:02:00\t1\t15\t0\t0\t0"]);
    expect(r.status).toBe(200);
    expect(store.punches).toHaveLength(2);
    expect([...store.sync.values()][1]!.counts).toMatchObject({ received: 3, imported: 1, duplicate: 2 });
  });

  it("rejects malformed and implausible lines but keeps valid ones", async () => {
    const r = await attlog(["1001\t2026-10-22 08:01:33\t0\t15", "bad line", "1001\t2099-01-01 08:00:00\t0\t15"]);
    expect(r.status).toBe(200);
    expect(store.punches).toHaveLength(1);
    expect([...store.sync.values()][0]!.counts).toMatchObject({ received: 3, imported: 1, rejected: 2 });
  });

  it("answers 500 on storage failure so the device retries (no data loss)", async () => {
    store.insertPunches = async () => { throw new Error("db down"); };
    const r = await attlog(["1001\t2026-10-22 08:01:33\t0\t15"]);
    expect(r.status).toBe(500);
    expect([...store.sync.values()][0]!.error).toBe("db down");
    expect(store.devices.get("dev-1")!.attLogStamp).toBeNull(); // stamp not advanced
  });

  it("discards biometric uploads entirely", async () => {
    const r = await request(app).post(`/iclock/cdata?SN=${SN}&table=OPERLOG&Stamp=5`).set("Content-Type", "text/plain")
      .send("FP PIN=1001\tFID=1\tTMP=U0VDUkVUVEVNUExBVEU=\nUSER PIN=1001\tName=Juan\tPasswd=4321");
    expect(r.text).toBe("OK");
    const everything = JSON.stringify({ comm: store.comm, punches: store.punches });
    expect(everything).not.toContain("U0VDUkVU");
    expect(everything).not.toContain("4321");
    expect(store.comm.at(-1)!.summary).toContain("biometricDiscarded=1");
  });
});

describe("command channel", () => {
  it("delivers queued commands once and records the result", async () => {
    const seq = store.queue("dev-1", "INFO");
    const r1 = await request(app).get(`/iclock/getrequest?SN=${SN}`);
    expect(r1.text).toBe(`C:${seq}:INFO\n`);
    expect((await request(app).get(`/iclock/getrequest?SN=${SN}`)).text).toBe("OK");
    await request(app).post(`/iclock/devicecmd?SN=${SN}`).set("Content-Type", "text/plain").send(`ID=${seq}&Return=0&CMD=INFO`);
    expect(store.commands[0]!.status).toBe("SUCCEEDED");
  });
  it("a device cannot complete another device's command", async () => {
    store.addDevice({ id: "dev-2", serialNumber: "OTHERDEV01" });
    const seq = store.queue("dev-1", "REBOOT");
    await request(app).get(`/iclock/getrequest?SN=${SN}`);
    await request(app).post("/iclock/devicecmd?SN=OTHERDEV01").send(`ID=${seq}&Return=0&CMD=REBOOT`);
    expect(store.commands[0]!.status).toBe("SENT");
  });
});

describe("offline incident lifecycle", () => {
  it("contact from the device resolves its offline incident", async () => {
    await store.raiseIncident({ key: "DEVICE_OFFLINE:dev-1", type: "DEVICE_OFFLINE", severity: "CRITICAL", title: "t", message: "m", deviceId: "dev-1" });
    await request(app).get(`/iclock/getrequest?SN=${SN}`);
    expect(store.incidents.get("DEVICE_OFFLINE:dev-1")!.resolved).toBe(true);
  });
});
