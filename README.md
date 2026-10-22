# ADMS — Attendance and Device Management System

[![CI](https://github.com/soleiyait8/ADMS-V1/actions/workflows/ci.yml/badge.svg)](https://github.com/soleiyait8/ADMS-V1/actions/workflows/ci.yml)

Backend for biometric attendance with ZKTeco ADMS (PUSH) integration. This delivery covers Phases 1–2
and the backend of Phases 3–5. See `docs/ARCHITECTURE.md` for the full design and status, and
`docs/MB10-VL-COMPATIBILITY.md` for the device verification checklist (**MB10-VL support is unverified
until that checklist is signed off on real hardware**).

## Run locally (development)

Requirements: Node 22.12+ (see `.nvmrc`), Docker.

```bash
docker run -d --name adms-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=adms -p 5432:5432 postgres:16.6-bookworm
cd backend
cp .env.example .env     # development template; set SEED_ADMIN_PASSWORD and replace the secrets
npm ci
npx prisma migrate dev --name init   # creates prisma/migrations/ – commit this folder
npm run seed                          # roles, permissions, sample departments, Super Admin
npm run dev                           # API :4000, device endpoint :8081
npm test
npm run ci                            # same checks GitHub Actions runs
```

> The initial migration SQL is not included: it is generated from `schema.prisma` by `prisma migrate dev`
> on first run. Commit the generated `prisma/migrations` folder; production uses `prisma migrate deploy`.

## Connect a ZKTeco device (test bench)

1. Log in, then `POST /api/v1/devices` with `{ "name": "Lobby MB10-VL", "serialNumber": "<SN from device>", "protocol": "ZK_PUSH", "timezone": "Asia/Manila", "allowedIpCidrs": ["<device ip>/32"] }`.
2. On the device: Comm. → Cloud Server Setting → server address = this host, port = 8081, HTTPS per checklist item B3.
3. Watch `GET /api/v1/devices/:id/comm-logs`. The device shows **ONLINE** only after it has actually connected.
4. Map employees: `POST /api/v1/employees/:id/device-mappings` with the device PIN. Earlier unmapped punches for that PIN are linked automatically.

## Production

```bash
cp .env.example .env    # fill in secrets: openssl rand -base64 48 / openssl rand -hex 32
# place TLS cert at deploy/certs/fullchain.pem and privkey.pem
docker compose up -d --build
docker compose exec -e SEED_ALLOW_PRODUCTION_RBAC_ONLY=true backend npm run seed:prod   # roles and permissions only
```

Restrict port 8081 to device subnets (firewall and the `allow`/`deny` lines in `deploy/nginx/adms.conf`).

## Continuous integration

Every push and pull request runs `.github/workflows/ci.yml`:

- **Backend:** schema validation, typecheck, unit/protocol tests, build, and a production dependency audit.
- **Database:** applies migrations to a real PostgreSQL 16 service, checks that migrations match `schema.prisma`, seeds, starts the server, and runs `backend/scripts/ci-smoke.sh` (login, permissions, employees, device registration, ADMS handshake, ATTLOG upload, deduplication, command round-trip, audit log).
- **Docker:** builds the backend image and validates `docker-compose.yml`.

If no migrations are committed yet, the database job generates the initial migration, proves it applies cleanly, and uploads it as the `initial-migration` artifact to commit into `backend/prisma/migrations/`.

Dependabot (`.github/dependabot.yml`) opens weekly dependency update PRs. See `SECURITY.md` for how to report vulnerabilities and handle secrets.
