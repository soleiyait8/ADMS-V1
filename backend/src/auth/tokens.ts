import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { randomToken, sha256 } from "../lib/crypto";
import { unauthorized } from "../lib/errors";

export interface AccessClaims { sub: string; iat: number; exp: number }

export function signAccessToken(userId: string, secret: string, ttlSec: number): string {
  return jwt.sign({}, secret, { subject: userId, expiresIn: ttlSec, algorithm: "HS256" });
}

export function verifyAccessToken(token: string, secret: string): AccessClaims {
  try {
    return jwt.verify(token, secret, { algorithms: ["HS256"] }) as AccessClaims;
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}

/** Issues a new refresh token. familyId links rotations so reuse of an old token can revoke the whole chain. */
export async function issueRefreshToken(db: PrismaClient, userId: string, ttlDays: number, meta: { ip?: string; ua?: string }, familyId: string = randomUUID()) {
  const token = randomToken(48);
  const row = await db.refreshToken.create({
    data: {
      userId, familyId, tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      createdIp: meta.ip, userAgent: meta.ua?.slice(0, 255),
    },
  });
  return { token, row };
}

/** Rotate: old token is revoked and replaced. Presenting an already-revoked token revokes the family (theft signal). */
export async function rotateRefreshToken(db: PrismaClient, presented: string, ttlDays: number, meta: { ip?: string; ua?: string }) {
  const existing = await db.refreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
  if (!existing) throw unauthorized("Invalid session");
  if (existing.revokedAt) {
    await db.refreshToken.updateMany({ where: { familyId: existing.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw unauthorized("Session reuse detected; please sign in again");
  }
  if (existing.expiresAt < new Date()) throw unauthorized("Session expired");
  const next = await issueRefreshToken(db, existing.userId, ttlDays, meta, existing.familyId);
  await db.refreshToken.update({ where: { id: existing.id }, data: { revokedAt: new Date(), replacedById: next.row.id } });
  return { userId: existing.userId, token: next.token };
}
