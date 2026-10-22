/**
 * ZKTeco PUSH ("ADMS" / iclock) payload parsing.
 *
 * Formats below follow the publicly circulated PUSH SDK behaviour of ZKTeco terminals.
 * They MUST be confirmed against the actual MB10-VL firmware (see docs/MB10-VL-COMPATIBILITY.md)
 * using captured traffic; unknown line types are counted and logged, never guessed at.
 */

export interface AttLogRecord {
  pin: string;
  localTime: string; // "YYYY-MM-DD HH:mm:ss" device wall clock
  punchState: number | null;
  verifyMode: number | null;
  workCode: string | null;
  rawLine: string;
}

export interface ParseRejection {
  line: string;
  reason: string;
}

const PIN_RE = /^[A-Za-z0-9]{1,24}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_LINES = 10_000;

const intOrNull = (s: string | undefined) => (s !== undefined && /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : null);

/** ATTLOG line: PIN \t YYYY-MM-DD HH:mm:ss \t status \t verify \t workcode \t reserved \t reserved */
export function parseAttLog(body: string): { records: AttLogRecord[]; rejected: ParseRejection[] } {
  const records: AttLogRecord[] = [];
  const rejected: ParseRejection[] = [];
  const lines = body.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length > MAX_LINES) {
    return { records, rejected: [{ line: `(${lines.length} lines)`, reason: "batch too large" }] };
  }
  for (const line of lines) {
    let fields = line.split("\t");
    if (fields.length < 2) {
      // Some firmware variants space-separate; accept only the unambiguous shape.
      const m = line.trim().match(/^(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\s+(.*))?$/);
      fields = m ? [m[1]!, m[2]!, ...(m[3] ? m[3].split(/\s+/) : [])] : fields;
    }
    const [pinRaw, tsRaw, state, verify, workCode] = fields.map((f) => f.trim());
    if (!pinRaw || !PIN_RE.test(pinRaw)) {
      rejected.push({ line: truncate(line), reason: "invalid or missing PIN" });
      continue;
    }
    if (!tsRaw || !TS_RE.test(tsRaw)) {
      rejected.push({ line: truncate(line), reason: "invalid timestamp" });
      continue;
    }
    records.push({
      pin: pinRaw,
      localTime: tsRaw,
      punchState: intOrNull(state),
      verifyMode: intOrNull(verify),
      workCode: workCode && workCode !== "0" ? workCode.slice(0, 32) : null,
      // Keep only the fields we understand; never keep trailing reserved blobs.
      rawLine: [pinRaw, tsRaw, state ?? "", verify ?? "", workCode ?? ""].join("\t"),
    });
  }
  return { records, rejected };
}

/** Line prefixes in OPERLOG/user uploads that carry biometric data. These are discarded unread. */
const BIOMETRIC_PREFIXES = ["FP ", "FACE ", "BIODATA ", "BIOPHOTO ", "FVEIN ", "USERPIC ", "PALM "];

export interface OperLogSummary {
  operations: number;
  userRecords: Array<{ pin: string; name: string | null }>;
  biometricLinesDiscarded: number;
  unknownLines: number;
}

/** OPERLOG body: "OPLOG ...", "USER PIN=..\tName=..", and possibly template lines we refuse to keep. */
export function parseOperLog(body: string): OperLogSummary {
  const out: OperLogSummary = { operations: 0, userRecords: [], biometricLinesDiscarded: 0, unknownLines: 0 };
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (BIOMETRIC_PREFIXES.some((p) => line.startsWith(p))) {
      out.biometricLinesDiscarded++;
    } else if (line.startsWith("OPLOG ")) {
      out.operations++;
    } else if (line.startsWith("USER ")) {
      // Only PIN and display name are read. Password and card fields are ignored.
      const kv = parseKv(line.slice(5));
      const pin = kv.get("PIN");
      if (pin && PIN_RE.test(pin)) out.userRecords.push({ pin, name: kv.get("Name")?.slice(0, 120) || null });
      else out.unknownLines++;
    } else {
      out.unknownLines++;
    }
  }
  return out;
}

function parseKv(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split("\t")) {
    const i = part.indexOf("=");
    if (i > 0) m.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return m;
}

export interface DeviceInfo {
  firmwareVersion: string | null;
  userCount: number | null;
  attLogCount: number | null;
  ipAddress: string | null;
}

/**
 * INFO query parameter sent with getrequest, commonly:
 * "Ver 8.0.4.2-20200111,<users>,<fp count>,<att logs>,<ip>,<fp alg>,<face alg>,<face req>,<face count>,<flags>"
 * Field order varies by firmware; only fields with an unambiguous shape are trusted.
 */
export function parseInfo(info: string | undefined): DeviceInfo | null {
  if (!info) return null;
  const parts = info.split(",").map((p) => p.trim());
  const fw = parts[0]?.replace(/^Ver\s*/i, "") || null;
  const ip = parts.find((p) => /^\d{1,3}(\.\d{1,3}){3}$/.test(p)) ?? null;
  return {
    firmwareVersion: fw ? fw.slice(0, 64) : null,
    userCount: intOrNull(parts[1]),
    attLogCount: intOrNull(parts[3]),
    ipAddress: ip,
  };
}

export interface CommandReply {
  id: number;
  returnCode: number;
  cmd: string | null;
}

/** devicecmd body: one or more lines like "ID=12&Return=0&CMD=INFO" */
export function parseCommandReplies(body: string): CommandReply[] {
  const out: CommandReply[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes("ID=")) continue;
    const p = new URLSearchParams(line.trim());
    const id = intOrNull(p.get("ID") ?? undefined);
    const rc = intOrNull(p.get("Return") ?? undefined);
    if (id !== null && rc !== null) out.push({ id, returnCode: rc, cmd: p.get("CMD") });
  }
  return out;
}

const truncate = (s: string) => (s.length > 120 ? `${s.slice(0, 120)}…` : s);
