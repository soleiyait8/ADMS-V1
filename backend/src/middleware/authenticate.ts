import type { NextFunction, Request, Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { verifyAccessToken } from "../auth/tokens";
import type { Permission } from "../auth/permissions";
import { forbidden, unauthorized } from "../lib/errors";

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roleKey: string;
  departmentId: string | null;
  permissions: Set<Permission>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}

const cache = new Map<string, { user: AuthUser; until: number; pwChangedAt: number; active: boolean }>();
const CACHE_MS = 15_000; // deactivation and role changes take effect within 15s

export function invalidateUserCache(userId: string) { cache.delete(userId); }

export function authenticate(db: PrismaClient, secret: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) throw unauthorized();
      const claims = verifyAccessToken(h.slice(7), secret);
      let entry = cache.get(claims.sub);
      if (!entry || entry.until < Date.now()) {
        const u = await db.user.findUnique({
          where: { id: claims.sub },
          include: { role: { include: { permissions: { include: { permission: true } } } } },
        });
        if (!u) throw unauthorized();
        entry = {
          until: Date.now() + CACHE_MS,
          active: u.isActive,
          pwChangedAt: u.passwordChangedAt.getTime(),
          user: {
            id: u.id, email: u.email, fullName: u.fullName, roleKey: u.role.key, departmentId: u.departmentId,
            permissions: new Set(u.role.permissions.map((rp) => rp.permission.key as Permission)),
          },
        };
        cache.set(claims.sub, entry);
      }
      if (!entry.active) throw unauthorized("Account is disabled");
      // Tokens issued before a password change are invalid.
      if (claims.iat * 1000 < entry.pwChangedAt - 1000) throw unauthorized("Session no longer valid");
      req.user = entry.user;
      next();
    } catch (e) { next(e); }
  };
}

/** Server-side permission enforcement. Every protected route declares what it needs. */
export const requirePermission = (...perms: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!perms.every((p) => req.user!.permissions.has(p))) return next(forbidden());
    next();
  };

/** Department scoping: returns a Prisma filter for employee-related queries. */
export function departmentScope(user: AuthUser): { departmentId?: string } {
  if (user.permissions.has("data.all_departments")) return {};
  // A supervisor without a department sees nothing rather than everything.
  return { departmentId: user.departmentId ?? "00000000-0000-0000-0000-000000000000" };
}
