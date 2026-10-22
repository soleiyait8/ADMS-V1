## What changed

## Why

## Checklist
- [ ] `npm run ci` passes in `backend/`
- [ ] Schema changes include a committed migration (`npx prisma migrate dev --name <change>`)
- [ ] New API routes call `requirePermission(...)` and write audit logs for sensitive actions
- [ ] No secrets, `.env` files, real employee data, or biometric data added
- [ ] Device-protocol changes are backed by captured traffic or fixtures (not assumptions)
