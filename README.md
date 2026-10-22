# ADMS — Attendance and Device Management System

Backend for biometric attendance with ZKTeco ADMS (PUSH) integration. This delivery covers Phases 1–2
and the backend of Phases 3–5. See `docs/ARCHITECTURE.md` for the full design and status, and
`docs/MB10-VL-COMPATIBILITY.md` for the device verification checklist (**MB10-VL support is unverified
until that checklist is signed off on real hardware**).

## Run locally (development)

Requirements: Node 22, Docker.

```bash
docker run -d --name adms-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=adms -p 5432:5432 postgres:16.6-bookworm
cd backend
cp .env.example .env     # set NODE_ENV=development, DATABASE_URL, JWT_ACCESS_SECRET, DATA_ENCRYPTION_KEY, SEED_ADMIN_PASSWORD
# DATABASE_URL=postgresql://postgres:dev@localhost:5432/adms
npm ci
npx prisma migrate dev --name init   # creates prisma/migrations/ – commit this folder
npm run seed                          # roles, permissions, sample departments, Super Admin
npm run dev                           # API :4000, device endpoint :8081
npm test
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
docker compose exec backend sh -c "NODE_ENV=production SEED_ALLOW_PRODUCTION_RBAC_ONLY=true npx tsx prisma/seed.ts"  # roles only
```

Restrict port 8081 to device subnets (firewall and the `allow`/`deny` lines in `deploy/nginx/adms.conf`).
