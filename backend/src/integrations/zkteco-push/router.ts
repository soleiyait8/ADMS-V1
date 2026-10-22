import express, { type Request, type Response, Router } from "express";
import rateLimit from "express-rate-limit";
import { ipAllowed } from "../../lib/net";
import { logger } from "../../lib/logger";
import { ingestPunches } from "../ingest/ingestService";
import type { DeviceRecord, IntegrationStore } from "../types";
import { parseAttLog, parseCommandReplies, parseInfo, parseOperLog } from "./parser";
import { commandLine, handshakeResponse } from "./protocol";

const SN_RE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Device-facing ZKTeco PUSH endpoints. Mounted on a SEPARATE listener/port from the
 * admin API so it can be firewalled to the device VLAN (see docs/DEPLOYMENT.md).
 *
 * Authentication reality: the classic PUSH protocol identifies a device only by its
 * serial number (SN), which is not a secret. Defence in depth is therefore applied:
 *  1. SN must belong to a registered, enabled ZK_PUSH device.
 *  2. Optional per-device source-IP allowlist (CIDR).
 *  3. Network-level restriction (separate port, firewall/VPN), rate limiting.
 *  4. Every rejection is logged; repeated failures raise a single open incident.
 */
export function zkPushRouter(store: IntegrationStore, opts: { now?: () => Date } = {}): Router {
  const now = opts.now ?? (() => new Date());
  const r = Router();

  r.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: false, legacyHeaders: false }));
  // Devices send text/plain bodies (sometimes with odd content types). Never JSON-parse them.
  r.use(express.text({ type: () => true, limit: "5mb" }));

  const text = (res: Response, status: number, body: string) =>
    res.status(status).type("text/plain").send(body);

  async function authenticate(req: Request, res: Response): Promise<DeviceRecord | null> {
    const started = Date.now();
    const sn = String(req.query.SN ?? "");
    const ip = req.ip ?? "";
    const reject = async (outcome: string, deviceId: string | null) => {
      await store.logComm({
        deviceId, serialNumber: sn.slice(0, 64) || null, method: req.method, path: req.path,
        table: (req.query.table as string) ?? null, statusCode: 403, outcome, summary: null,
        remoteIp: ip, durationMs: Date.now() - started,
      });
      await store.raiseIncident({
        key: `DEVICE_AUTH_FAILURE:${sn.slice(0, 64) || ip}`,
        type: "DEVICE_AUTH_FAILURE",
        severity: "WARNING",
        title: "Rejected device request",
        message: `Request from ${ip} with SN "${sn.slice(0, 64)}" was rejected (${outcome}).`,
        deviceId,
      });
      text(res, 403, "Unauthorized");
      return null;
    };
    if (!SN_RE.test(sn)) return reject("MISSING_OR_INVALID_SN", null);
    const device = await store.findDeviceBySerial(sn);
    if (!device) return reject("UNKNOWN_DEVICE", null);
    if (device.protocol !== "ZK_PUSH") return reject("PROTOCOL_MISMATCH", device.id);
    if (!device.isEnabled) return reject("DEVICE_DISABLED", device.id);
    if (!ipAllowed(ip, device.allowedIpCidrs)) return reject("IP_NOT_ALLOWED", device.id);
    return device;
  }

  // Handshake / options exchange.
  r.get("/iclock/cdata", async (req, res, next) => {
    try {
      const device = await authenticate(req, res);
      if (!device) return;
      await store.markSeen(device.id, req.ip ?? "", now(), { pushVersion: (req.query.pushver as string)?.slice(0, 32) ?? null });
      await store.resolveIncident(`DEVICE_OFFLINE:${device.id}`);
      await store.logComm(okLog(device, req, "HANDSHAKE"));
      text(res, 200, handshakeResponse({
        serialNumber: device.serialNumber,
        attLogStamp: device.attLogStamp,
        operLogStamp: device.operLogStamp,
        delaySeconds: device.pushDelaySeconds,
        timezone: device.timezone,
      }));
    } catch (e) { next(e); }
  });

  // Data upload.
  r.post("/iclock/cdata", async (req, res, next) => {
    try {
      const device = await authenticate(req, res);
      if (!device) return;
      const at = now();
      await store.markSeen(device.id, req.ip ?? "", at);
      await store.resolveIncident(`DEVICE_OFFLINE:${device.id}`);
      const table = String(req.query.table ?? "").toUpperCase();
      const stamp = typeof req.query.Stamp === "string" ? req.query.Stamp.slice(0, 32) : null;
      const body = typeof req.body === "string" ? req.body : "";

      if (table === "ATTLOG") {
        const parsed = parseAttLog(body);
        const result = await ingestPunches(store, device, parsed.records, { kind: "PUSH_ATTLOG", preRejected: parsed.rejected.length, now: at });
        if (parsed.rejected.length) {
          logger.warn({ deviceId: device.id, rejected: parsed.rejected.slice(0, 5) }, "ATTLOG lines rejected");
        }
        if (stamp) await store.setStamp(device.id, "ATTLOG", stamp);
        const summary = `received=${result.received} imported=${result.imported} duplicate=${result.duplicate} rejected=${result.rejected} unmapped=${result.unmapped}`;
        await store.logComm(okLog(device, req, "OK", "ATTLOG", summary));
        // Acknowledge only after the transaction is durably stored, so the device retries on failure.
        return text(res, 200, `OK: ${parsed.records.length + parsed.rejected.length}`);
      }

      if (table === "OPERLOG") {
        const s = parseOperLog(body);
        if (stamp) await store.setStamp(device.id, "OPERLOG", stamp);
        await store.logComm(okLog(device, req, "OK", "OPERLOG",
          `ops=${s.operations} users=${s.userRecords.length} biometricDiscarded=${s.biometricLinesDiscarded} unknown=${s.unknownLines}`));
        return text(res, 200, "OK");
      }

      // ATTPHOTO, BIODATA and any other table: acknowledged so the device does not retry forever,
      // but the content is discarded (data minimisation). The event is logged for diagnostics.
      await store.logComm(okLog(device, req, "DISCARDED", table || null, `bytes=${body.length}`));
      return text(res, 200, "OK");
    } catch (e) {
      next(e);
    }
  });

  // Device polls for pending commands; this is also the heartbeat.
  r.get("/iclock/getrequest", async (req, res, next) => {
    try {
      const device = await authenticate(req, res);
      if (!device) return;
      const info = parseInfo(typeof req.query.INFO === "string" ? req.query.INFO : undefined);
      await store.markSeen(device.id, req.ip ?? "", now(), info ?? undefined);
      await store.resolveIncident(`DEVICE_OFFLINE:${device.id}`);
      const cmd = await store.nextCommand(device.id);
      if (cmd) {
        await store.logComm(okLog(device, req, "COMMAND_SENT", null, `C:${cmd.seq}`));
        return text(res, 200, commandLine(cmd.seq, cmd.command));
      }
      return text(res, 200, "OK");
    } catch (e) { next(e); }
  });

  // Command results.
  r.post("/iclock/devicecmd", async (req, res, next) => {
    try {
      const device = await authenticate(req, res);
      if (!device) return;
      await store.markSeen(device.id, req.ip ?? "", now());
      const replies = parseCommandReplies(typeof req.body === "string" ? req.body : "");
      for (const rep of replies) {
        await store.completeCommand(device.id, rep.id, rep.returnCode, rep.cmd);
      }
      await store.logComm(okLog(device, req, "OK", null, `replies=${replies.length}`));
      return text(res, 200, "OK");
    } catch (e) { next(e); }
  });

  // Newer PUSH protocol variants (registry/push/querydata) are NOT assumed to be compatible.
  // They are logged so firmware verification can detect them, and answered with 404.
  r.all(["/iclock/registry", "/iclock/push", "/iclock/querydata", "/iclock/rtdata"], async (req, res) => {
    await store.logComm({
      deviceId: null, serialNumber: String(req.query.SN ?? "").slice(0, 64) || null, method: req.method,
      path: req.path, table: null, statusCode: 404, outcome: "UNSUPPORTED_PROTOCOL_VARIANT",
      summary: "Device uses a PUSH variant this adapter has not been verified against", remoteIp: req.ip ?? null, durationMs: null,
    });
    text(res, 404, "Not Supported");
  });

  r.use((err: unknown, req: Request, res: Response, _next: express.NextFunction) => {
    logger.error({ err, path: req.path }, "device endpoint error");
    // 500 => the device keeps the data and retries later; nothing is lost.
    text(res, 500, "ERROR");
  });

  return r;
}

function okLog(device: DeviceRecord, req: Request, outcome: string, table: string | null = null, summary: string | null = null) {
  return {
    deviceId: device.id, serialNumber: device.serialNumber, method: req.method, path: req.path,
    table, statusCode: 200, outcome, summary, remoteIp: req.ip ?? null, durationMs: null,
  };
}
