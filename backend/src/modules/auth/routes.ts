import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import type { Env } from "../../config/env";
import { dummyVerify, hashPassword, passwordPolicyError, verifyPassword } from "../../auth/password";
import { issueRefreshToken, rotateRefreshToken, signAccessToken } from "../../auth/tokens";
import { sha256 } from "../../lib/crypto";
import { ah, parse } from "../../lib/http";
import { badRequest, unauthorized } from "../../lib/errors";
import { authenticate, invalidateUserCache } from "../../middleware/authenticate";
import { requireXhrHeader } from "../../middleware/errorHandler";
import { audit } from "../audit/audit";

const COOKIE = "adms_rt";
const MAX_FAILED = 5;
const LOCK_MIN = 15;

export function authRouter(db: PrismaClient, cfg: Env) {
  const r = Router();
  const cookieOpts = {
    httpOnly: true, secure: cfg.NODE_ENV === "production", sameSite: "strict" as const,
    path: "/api/v1/auth", maxAge: cfg.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const meta = (req: import("express").Request) => ({ ip: req.ip, ua: req.get("user-agent") });

  r.post("/login", loginLimiter, ah(async (req, res) => {
    const body = parse(z.object({ email: z.string().email().max(254), password: z.string().min(1).max(128) }), req.body);
    const user = await db.user.findUnique({ where: { email: body.email.toLowerCase() } });
    const fail = async () => {
      await audit(db, req, "auth.login.failed", "User", user?.id ?? null, undefined, { email: body.email });
      throw unauthorized("Invalid email or password");
    };
    if (!user) { await dummyVerify(body.password); return fail(); }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw unauthorized(`Account temporarily locked. Try again after ${user.lockedUntil.toISOString()}`);
    }
    if (!user.isActive || !(await verifyPassword(user.passwordHash, body.password))) {
      const failed = user.failedLoginCount + 1;
      await db.user.update({
        where: { id: user.id },
        data: failed >= MAX_FAILED
          ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MIN * 60_000) }
          : { failedLoginCount: failed },
      });
      return fail();
    }
    await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    const { token } = await issueRefreshToken(db, user.id, cfg.REFRESH_TOKEN_TTL_DAYS, meta(req));
    res.cookie(COOKIE, token, cookieOpts);
    await audit(db, req, "auth.login", "User", user.id, undefined, undefined, user.id);
    res.json({ accessToken: signAccessToken(user.id, cfg.JWT_ACCESS_SECRET, cfg.ACCESS_TOKEN_TTL_SEC), expiresIn: cfg.ACCESS_TOKEN_TTL_SEC });
  }));

  r.post("/refresh", requireXhrHeader, ah(async (req, res) => {
    const presented = req.cookies?.[COOKIE];
    if (!presented) throw unauthorized("No session");
    const { userId, token } = await rotateRefreshToken(db, presented, cfg.REFRESH_TOKEN_TTL_DAYS, meta(req));
    const u = await db.user.findUnique({ where: { id: userId } });
    if (!u?.isActive) throw unauthorized("Account is disabled");
    res.cookie(COOKIE, token, cookieOpts);
    res.json({ accessToken: signAccessToken(userId, cfg.JWT_ACCESS_SECRET, cfg.ACCESS_TOKEN_TTL_SEC), expiresIn: cfg.ACCESS_TOKEN_TTL_SEC });
  }));

  r.post("/logout", requireXhrHeader, ah(async (req, res) => {
    const presented = req.cookies?.[COOKIE];
    if (presented) {
      const row = await db.refreshToken.findUnique({ where: { tokenHash: sha256(presented) } });
      if (row) {
        await db.refreshToken.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await audit(db, req, "auth.logout", "User", row.userId, undefined, undefined, row.userId);
      }
    }
    res.clearCookie(COOKIE, { ...cookieOpts, maxAge: undefined });
    res.status(204).end();
  }));

  const authed = authenticate(db, cfg.JWT_ACCESS_SECRET);

  r.get("/me", authed, ah(async (req, res) => {
    const u = req.user!;
    res.json({ id: u.id, email: u.email, fullName: u.fullName, role: u.roleKey, departmentId: u.departmentId, permissions: [...u.permissions] });
  }));

  r.post("/change-password", authed, ah(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: z.string() }), req.body);
    const policy = passwordPolicyError(body.newPassword);
    if (policy) throw badRequest(policy);
    const u = await db.user.findUniqueOrThrow({ where: { id: req.user!.id } });
    if (!(await verifyPassword(u.passwordHash, body.currentPassword))) throw unauthorized("Current password is incorrect");
    await db.$transaction([
      db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(body.newPassword), passwordChangedAt: new Date() } }),
      db.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    invalidateUserCache(u.id);
    await audit(db, req, "auth.password.change", "User", u.id);
    res.status(204).end();
  }));

  // Password reset (request/confirm) – token delivery requires the email notifier (Phase 7).
  return r;
}
