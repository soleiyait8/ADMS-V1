import { Router } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { hashPassword, passwordPolicyError } from "../../auth/password";
import { ah, pageMeta, pagination, parse } from "../../lib/http";
import { badRequest, forbidden } from "../../lib/errors";
import { invalidateUserCache, requirePermission } from "../../middleware/authenticate";
import { audit } from "../audit/audit";

const publicUser = { id: true, email: true, fullName: true, isActive: true, departmentId: true, lastLoginAt: true, createdAt: true, role: { select: { key: true, name: true } } } as const;

export function usersRouter(db: PrismaClient) {
  const r = Router();
  r.use(requirePermission("users.manage"));

  r.get("/", ah(async (req, res) => {
    const q = parse(pagination.extend({ search: z.string().max(100).optional() }), req.query);
    const where = q.search ? { OR: [{ email: { contains: q.search, mode: "insensitive" as const } }, { fullName: { contains: q.search, mode: "insensitive" as const } }] } : {};
    const [total, data] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({ where, select: publicUser, orderBy: { fullName: "asc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json({ data, meta: pageMeta(q.page, q.pageSize, total) });
  }));

  r.post("/", ah(async (req, res) => {
    const b = parse(z.object({
      email: z.string().email(), fullName: z.string().min(1).max(120), password: z.string(),
      roleKey: z.string(), departmentId: z.string().uuid().nullable().optional(),
    }), req.body);
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const role = await db.role.findUnique({ where: { key: b.roleKey } });
    if (!role) throw badRequest("Unknown role");
    if (role.key === "SUPER_ADMIN" && req.user!.roleKey !== "SUPER_ADMIN") throw forbidden("Only a Super Administrator can create Super Administrators");
    const u = await db.user.create({
      data: { email: b.email.toLowerCase(), fullName: b.fullName, passwordHash: await hashPassword(b.password), roleId: role.id, departmentId: b.departmentId ?? null },
      select: publicUser,
    });
    await audit(db, req, "user.create", "User", u.id, undefined, u);
    res.status(201).json(u);
  }));

  r.patch("/:id", ah(async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const b = parse(z.object({ fullName: z.string().min(1).max(120).optional(), roleKey: z.string().optional(), isActive: z.boolean().optional(), departmentId: z.string().uuid().nullable().optional() }), req.body);
    if (id === req.user!.id && (b.isActive === false || b.roleKey)) throw badRequest("You cannot deactivate yourself or change your own role");
    const before = await db.user.findUniqueOrThrow({ where: { id }, select: publicUser });
    if (before.role.key === "SUPER_ADMIN" && req.user!.roleKey !== "SUPER_ADMIN") throw forbidden();
    let roleId: string | undefined;
    if (b.roleKey) {
      const role = await db.role.findUnique({ where: { key: b.roleKey } });
      if (!role) throw badRequest("Unknown role");
      if (role.key === "SUPER_ADMIN" && req.user!.roleKey !== "SUPER_ADMIN") throw forbidden();
      roleId = role.id;
    }
    const after = await db.user.update({
      where: { id },
      data: { fullName: b.fullName, isActive: b.isActive, departmentId: b.departmentId, roleId },
      select: publicUser,
    });
    if (b.isActive === false) await db.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    invalidateUserCache(id);
    await audit(db, req, "user.update", "User", id, before, after);
    res.json(after);
  }));

  r.get("/roles", ah(async (_req, res) => {
    res.json(await db.role.findMany({ select: { key: true, name: true, permissions: { select: { permission: { select: { key: true } } } } }, orderBy: { name: "asc" } }));
  }));

  return r;
}
