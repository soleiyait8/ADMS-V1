import { describe, expect, it } from "vitest";
import { parseAttLog, parseCommandReplies, parseInfo, parseOperLog } from "../src/integrations/zkteco-push/parser";
import { handshakeResponse, COMMAND_ALLOWLIST, DeviceCommands } from "../src/integrations/zkteco-push/protocol";

describe("ATTLOG parsing", () => {
  it("parses tab-separated lines", () => {
    const r = parseAttLog("1001\t2026-10-22 08:01:33\t0\t15\t0\t0\t0\n1002\t2026-10-22 08:03:10\t0\t1\t\t0\t0\n");
    expect(r.rejected).toEqual([]);
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toMatchObject({ pin: "1001", localTime: "2026-10-22 08:01:33", punchState: 0, verifyMode: 15, workCode: null });
    expect(r.records[1]!.verifyMode).toBe(1);
  });
  it("accepts unambiguous space-separated variant", () => {
    const r = parseAttLog("7 2026-10-22 17:00:00 1 15");
    expect(r.records[0]).toMatchObject({ pin: "7", punchState: 1, verifyMode: 15 });
  });
  it("rejects malformed lines without dropping good ones", () => {
    const r = parseAttLog("1001\t2026-10-22 08:01:33\t0\t1\n\t2026-10-22 08:00:00\n1003\tyesterday\t0\n'; DROP TABLE x;--\t2026-10-22 08:00:00");
    expect(r.records).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason)).toEqual(["invalid or missing PIN", "invalid timestamp", "invalid or missing PIN"]);
  });
  it("handles CRLF and blank lines", () => {
    expect(parseAttLog("\r\n1\t2026-01-01 00:00:00\t0\t1\r\n\r\n").records).toHaveLength(1);
  });
});

describe("OPERLOG parsing", () => {
  it("discards biometric template lines and keeps only PIN/name from USER lines", () => {
    const body = [
      "OPLOG 4\t0\t2026-10-22 08:00:00\t0\t0\t0\t0",
      "USER PIN=1001\tName=Juan Dela Cruz\tPri=0\tPasswd=1234\tCard=998877\tGrp=1",
      "FP PIN=1001\tFID=6\tSize=1384\tValid=1\tTMP=SGVsbG9CaW9tZXRyaWM=",
      "BIODATA Pin=1001\tNo=0\tIndex=0\tValid=1\tType=9\tTmp=AAAA",
      "SOMETHINGNEW x=1",
    ].join("\n");
    const s = parseOperLog(body);
    expect(s).toMatchObject({ operations: 1, biometricLinesDiscarded: 2, unknownLines: 1 });
    expect(s.userRecords).toEqual([{ pin: "1001", name: "Juan Dela Cruz" }]);
    expect(JSON.stringify(s)).not.toContain("1234");      // password ignored
    expect(JSON.stringify(s)).not.toContain("998877");    // card ignored
    expect(JSON.stringify(s)).not.toContain("SGVsbG9");   // template ignored
  });
});

describe("INFO and command replies", () => {
  it("parses firmware and IP from INFO", () => {
    expect(parseInfo("Ver 8.0.4.2-20200111,25,0,1340,192.168.1.201,10,7,12,2,111")).toMatchObject({
      firmwareVersion: "8.0.4.2-20200111", userCount: 25, attLogCount: 1340, ipAddress: "192.168.1.201",
    });
    expect(parseInfo(undefined)).toBeNull();
  });
  it("parses devicecmd replies", () => {
    expect(parseCommandReplies("ID=3&Return=0&CMD=INFO\nID=4&Return=-1002&CMD=DATA\ngarbage")).toEqual([
      { id: 3, returnCode: 0, cmd: "INFO" }, { id: 4, returnCode: -1002, cmd: "DATA" },
    ]);
  });
});

describe("handshake and commands", () => {
  it("does not request fingerprint templates or photos", () => {
    const h = handshakeResponse({ serialNumber: "ABC123", attLogStamp: "9999", operLogStamp: null, delaySeconds: 10, timezone: "Asia/Manila" });
    expect(h).toContain("GET OPTION FROM: ABC123");
    expect(h).toContain("ATTLOGStamp=9999");
    expect(h).toContain("OPERLOGStamp=None");
    expect(h).toContain("TimeZone=8");
    expect(h).toMatch(/TransFlag=TransData AttLog OpLog\n/);
    expect(h).not.toMatch(/EnrollFP|FPImag|AttPhoto/);
  });
  it("only allow-listed commands pass", () => {
    const q = DeviceCommands.queryAttLog(new Date("2026-10-21T16:00:00Z"), new Date("2026-10-22T16:00:00Z"), "Asia/Manila");
    expect(q).toBe("DATA QUERY ATTLOG StartTime=2026-10-22 00:00:00\tEndTime=2026-10-23 00:00:00");
    expect(COMMAND_ALLOWLIST.test(q)).toBe(true);
    expect(COMMAND_ALLOWLIST.test("INFO")).toBe(true);
    expect(COMMAND_ALLOWLIST.test("CLEAR DATA")).toBe(false);
    expect(COMMAND_ALLOWLIST.test("DATA DELETE USERINFO PIN=1")).toBe(false);
  });
});
