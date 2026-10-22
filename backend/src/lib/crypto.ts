import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** AES-256-GCM for secrets at rest (device comm keys, MFA secrets). Format: iv.tag.ciphertext (base64url). */
export function encryptSecret(plain: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(enc: string, keyHex: string): string {
  const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64url"));
  if (!iv || !tag || !ct) throw new Error("malformed secret");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
