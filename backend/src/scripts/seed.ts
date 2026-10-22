/**
 * Seeds roles/permissions and an initial Super Administrator whose password comes from
 * SEED_ADMIN_PASSWORD (never hardcoded). Sample site/departments are created in development only.
 * In production it runs only with SEED_ALLOW_PRODUCTION_RBAC_ONLY=true and skips sample data.
 */
import { PrismaClient } from "@prisma/client";
import { PERMISSIONS, ROLES } from "../auth/permissions";
import { hashPassword, passwordPolicyError } from "../auth/password";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION_RBAC_ONLY !== "true") {
    throw new Error("Refusing to seed in production. Set SEED_ALLOW_PRODUCTION_RBAC_ONLY=true to seed roles only.");
  }
  const db = new PrismaClient();
  const isProd = process.env.NODE_ENV === "production";

  for (const key of PERMISSIONS) await db.permission.upsert({ where: { key }, create: { key }, update: {} });
  const perms = new Map((await db.permission.findMany()).map((p) => [p.key, p.id]));
  for (const [key, def] of Object.entries(ROLES)) {
    const role = await db.role.upsert({ where: { key }, create: { key, name: def.name }, update: { name: def.name } });
    await db.rolePermission.deleteMany({ where: { roleId: role.id } });
    await db.rolePermission.createMany({ data: def.permissions.map((p) => ({ roleId: role.id, permissionId: perms.get(p)! })) });
  }
  console.log(`Seeded ${PERMISSIONS.length} permissions and ${Object.keys(ROLES).length} roles`);
  if (!isProd) {
    const site = await db.site.upsert({ where: { code: "MAIN" }, create: { code: "MAIN", name: "Main Office", timezone: "Asia/Manila" }, update: {} });
    for (const [code, name] of [["HR", "Human Resources"], ["IT", "Information Technology"], ["OPS", "Operations"]] as const) {
      await db.department.upsert({ where: { code }, create: { code, name, siteId: site.id }, update: {} });
    }
  }

  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@example.local";
  const pw = process.env.SEED_ADMIN_PASSWORD;
  if (!pw || passwordPolicyError(pw)) {
    console.warn("SEED_ADMIN_PASSWORD missing or too weak; skipping admin user. " + (pw ? passwordPolicyError(pw) : ""));
  } else {
    const role = await db.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
    await db.user.upsert({
      where: { email }, update: {},
      create: { email, fullName: "System Owner", passwordHash: await hashPassword(pw), roleId: role.id },
    });
    console.log(`Super Administrator: ${email}`);
  }
  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
