import { hash, verify, Algorithm } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw: string) => hash(pw, OPTS);
export const verifyPassword = (hashStr: string, pw: string) => verify(hashStr, pw).catch(() => false);

/** Used when the user does not exist, so response time doesn't reveal valid emails. */
let dummy: string | undefined;
export async function dummyVerify(pw: string) {
  dummy ??= await hashPassword("dummy-password-for-timing");
  await verifyPassword(dummy, pw);
  return false;
}

export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters";
  if (pw.length > 128) return "Password is too long";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 3) return "Use at least three of: lowercase, uppercase, digits, symbols";
  return null;
}
