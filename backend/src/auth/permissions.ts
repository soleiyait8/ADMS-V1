/** Single source of truth for permissions. Seeded into Role/Permission tables. */
export const PERMISSIONS = [
  "employees.read",
  "employees.write",
  "employees.archive",
  "employees.import_export",
  "devices.read",
  "devices.write",
  "devices.command",
  "attendance.read",
  "attendance.adjust.request",
  "attendance.adjust.approve",
  "attendance.overtime.approve",
  "schedules.manage",
  "org.manage", // departments, positions, sites, holidays
  "reports.read",
  "reports.export",
  "users.manage",
  "settings.manage",
  "audit.read",
  "data.all_departments", // without this, data is scoped to the user's own department
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = {
  SUPER_ADMIN: { name: "Super Administrator", permissions: [...PERMISSIONS] },
  SYSTEM_ADMIN: {
    name: "System Administrator",
    permissions: [
      "employees.read", "devices.read", "devices.write", "devices.command", "attendance.read",
      "users.manage", "settings.manage", "audit.read", "reports.read", "data.all_departments",
    ],
  },
  HR_MANAGER: {
    name: "HR Manager",
    permissions: [
      "employees.read", "employees.write", "employees.archive", "employees.import_export",
      "devices.read", "attendance.read", "attendance.adjust.request", "attendance.adjust.approve",
      "attendance.overtime.approve", "schedules.manage", "org.manage", "reports.read", "reports.export",
      "audit.read", "data.all_departments",
    ],
  },
  HR_STAFF: {
    name: "HR Staff",
    permissions: [
      "employees.read", "employees.write", "devices.read", "attendance.read",
      "attendance.adjust.request", "reports.read", "data.all_departments",
    ],
  },
  IT_DEVICE_ADMIN: {
    name: "IT Device Administrator",
    permissions: ["devices.read", "devices.write", "devices.command", "attendance.read", "data.all_departments"],
  },
  DEPARTMENT_SUPERVISOR: {
    name: "Department Supervisor",
    permissions: [
      "employees.read", "attendance.read", "attendance.adjust.request",
      "attendance.overtime.approve", "reports.read",
    ],
  },
  READ_ONLY_AUDITOR: {
    name: "Read-Only Auditor",
    permissions: ["employees.read", "devices.read", "attendance.read", "reports.read", "audit.read", "data.all_departments"],
  },
} satisfies Record<string, { name: string; permissions: Permission[] }>;

export type RoleKey = keyof typeof ROLES;
