/** Minimal IPv4 CIDR matcher (handles IPv4-mapped IPv6 like ::ffff:10.0.0.5). */
function ipv4ToInt(ip: string): number | null {
  const m = ip.replace(/^::ffff:/, "").split(".");
  if (m.length !== 4) return null;
  let n = 0;
  for (const part of m) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = bitsStr === undefined ? 32 : Number(bitsStr);
  const ipN = ipv4ToInt(ip);
  const baseN = base ? ipv4ToInt(base) : null;
  if (ipN === null || baseN === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((ipN & mask) >>> 0) === ((baseN & mask) >>> 0);
}

export const ipAllowed = (ip: string, cidrs: string[]) => cidrs.length === 0 || cidrs.some((c) => ipInCidr(ip, c));
