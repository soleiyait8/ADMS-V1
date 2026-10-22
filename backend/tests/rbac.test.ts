import { describe, expect, it } from "vitest";
import { PERMISSIONS, ROLES } from "../src/auth/permissions";
import { departmentScope, type AuthUser } from "../src/middleware/authenticate";

const writePerms = PERMISSIONS.filter((p) => /write|archive|command|adjust|approve|manage|import_export|export/.test(p));

describe("role matrix", () => {
  it("all role permissions are known permissions", () => {
    for (const r of Object.values(ROLES)) for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
  });
  it("Read-Only Auditor has no write-type permission", () => {
    expect(ROLES.READ_ONLY_AUDITOR.permissions.filter((p) => (writePerms as string[]).includes(p))).toEqual([]);
  });
  it("only admin roles can manage users and settings", () => {
    const can = (perm: string) => Object.entries(ROLES).filter(([, r]) => (r.permissions as string[]).includes(perm)).map(([k]) => k).sort();
    expect(can("users.manage")).toEqual(["SUPER_ADMIN", "SYSTEM_ADMIN"]);
    expect(can("settings.manage")).toEqual(["SUPER_ADMIN", "SYSTEM_ADMIN"]);
  });
  it("HR Staff can request but not approve adjustments", () => {
    expect(ROLES.HR_STAFF.permissions).toContain("attendance.adjust.request");
    expect(ROLES.HR_STAFF.permissions).not.toContain("attendance.adjust.approve");
  });
  it("supervisors are department-scoped; scope never widens to everything", () => {
    const sup: AuthUser = { id: "u", email: "s@x", fullName: "S", roleKey: "DEPARTMENT_SUPERVISOR", departmentId: "d1", permissions: new Set(ROLES.DEPARTMENT_SUPERVISOR.permissions) };
    expect(departmentScope(sup)).toEqual({ departmentId: "d1" });
    expect(departmentScope({ ...sup, departmentId: null }).departmentId).toBe("00000000-0000-0000-0000-000000000000");
    expect(departmentScope({ ...sup, permissions: new Set(ROLES.HR_MANAGER.permissions) })).toEqual({});
  });
});
