#!/usr/bin/env bash
# End-to-end smoke test against a real PostgreSQL database (used by CI).
# Requires: built app (dist/), migrated + seeded database, jq, curl.
set -euo pipefail

API=http://127.0.0.1:4000
DEV=http://127.0.0.1:8081
pass() { echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }
expect_eq() { [[ "$1" == "$2" ]] && pass "$3" || fail "$3 (expected '$2', got '$1')"; }

node dist/server.js > server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; echo "--- server log (tail) ---"; tail -n 40 server.log' EXIT

for _ in $(seq 1 40); do curl -sf "$API/api/health" >/dev/null && break; sleep 0.5; done
curl -sf "$API/api/health" >/dev/null || fail "server became healthy"
pass "server healthy (database reachable)"

echo "Authentication"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/employees")" "401" "unauthenticated request rejected"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$SEED_ADMIN_EMAIL\",\"password\":\"wrong-password\"}")" "401" "wrong password rejected"
TOKEN=$(curl -sf -X POST "$API/api/v1/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$SEED_ADMIN_EMAIL\",\"password\":\"$SEED_ADMIN_PASSWORD\"}" | jq -r .accessToken)
[[ -n "$TOKEN" && "$TOKEN" != "null" ]] && pass "seeded admin can log in" || fail "login"
AUTH=(-H "authorization: Bearer $TOKEN" -H 'content-type: application/json')
expect_eq "$(curl -sf "$API/api/v1/auth/me" "${AUTH[@]}" | jq -r .role)" "SUPER_ADMIN" "/auth/me returns role"

echo "Employees"
EMP=$(curl -sf -X POST "$API/api/v1/employees" "${AUTH[@]}" -d '{"employeeNo":"CI-0001","firstName":"Juan","lastName":"Dela Cruz"}')
EMP_ID=$(echo "$EMP" | jq -r .id)
pass "employee created"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/api/v1/employees" "${AUTH[@]}" \
  -d '{"employeeNo":"CI-0001","firstName":"Dup","lastName":"Licate"}')" "409" "duplicate employee number rejected"
curl -sf -X PATCH "$API/api/v1/employees/$EMP_ID" "${AUTH[@]}" -d '{"phone":"09170000000"}' >/dev/null
expect_eq "$(curl -sf "$API/api/v1/employees/$EMP_ID/history" "${AUTH[@]}" | jq 'length')" "2" "change history recorded"

echo "Devices"
DEV_ID=$(curl -sf -X POST "$API/api/v1/devices" "${AUTH[@]}" \
  -d '{"name":"CI Bench Device","serialNumber":"CITEST0001","protocol":"ZK_PUSH","timezone":"Asia/Manila"}' | jq -r .id)
expect_eq "$(curl -sf "$API/api/v1/devices/$DEV_ID" "${AUTH[@]}" | jq -r .status)" "NEVER_CONNECTED" "new device is not shown online"
curl -sf -X POST "$API/api/v1/employees/$EMP_ID/device-mappings" "${AUTH[@]}" \
  -d "{\"deviceId\":\"$DEV_ID\",\"deviceUserId\":\"1001\"}" >/dev/null
pass "device PIN mapped to employee"

echo "ZKTeco ADMS push protocol (fixture traffic)"
expect_eq "$(curl -s -o /dev/null -w '%{http_code}' "$DEV/iclock/cdata?SN=UNKNOWN0001&options=all")" "403" "unknown serial number rejected"
curl -sf "$DEV/iclock/cdata?SN=CITEST0001&options=all&pushver=2.4.1" | grep -q "GET OPTION FROM: CITEST0001" && pass "handshake" || fail "handshake"
expect_eq "$(curl -sf "$API/api/v1/devices/$DEV_ID" "${AUTH[@]}" | jq -r .status)" "ONLINE" "device online after real contact"
BODY=$'1001\t2026-01-05 08:01:00\t0\t15\t0\t0\t0\n2002\t2026-01-05 08:02:00\t0\t1\t0\t0\t0'
expect_eq "$(curl -sf -X POST "$DEV/iclock/cdata?SN=CITEST0001&table=ATTLOG&Stamp=1" -H 'content-type: text/plain' --data-binary "$BODY")" "OK: 2" "ATTLOG upload acknowledged"
curl -sf -X POST "$DEV/iclock/cdata?SN=CITEST0001&table=ATTLOG&Stamp=1" -H 'content-type: text/plain' --data-binary "$BODY" >/dev/null
TX=$(curl -sf "$API/api/v1/attendance/transactions?deviceId=$DEV_ID" "${AUTH[@]}")
expect_eq "$(echo "$TX" | jq .meta.total)" "2" "re-upload did not create duplicates"
expect_eq "$(echo "$TX" | jq -r '.data[] | select(.deviceUserId=="1001") | .punchedAt')" "2026-01-05T00:01:00.000Z" "Manila time stored as UTC"
expect_eq "$(echo "$TX" | jq -r '.data[] | select(.deviceUserId=="2002") | .status')" "UNMAPPED" "unmapped PIN kept, not dropped"
expect_eq "$(curl -sf "$API/api/v1/sync/jobs?deviceId=$DEV_ID" "${AUTH[@]}" | jq '[.data[].recordsDuplicate] | add')" "2" "sync jobs count duplicates"

echo "Commands, dashboard, audit"
curl -sf -X POST "$API/api/v1/devices/$DEV_ID/test-connection" "${AUTH[@]}" | jq -e '.status=="VERIFIED"' >/dev/null && pass "test-connection verified by real contact" || fail "test-connection"
CMD=$(curl -sf "$DEV/iclock/getrequest?SN=CITEST0001")
[[ "$CMD" =~ ^C:([0-9]+):INFO ]] && pass "queued INFO command delivered" || fail "command delivery (got '$CMD')"
curl -sf -X POST "$DEV/iclock/devicecmd?SN=CITEST0001" -H 'content-type: text/plain' --data-binary "ID=${BASH_REMATCH[1]}&Return=0&CMD=INFO" >/dev/null
expect_eq "$(curl -sf "$API/api/v1/devices/$DEV_ID/commands" "${AUTH[@]}" | jq -r '.[0].status')" "SUCCEEDED" "command result recorded"
expect_eq "$(curl -sf "$API/api/v1/dashboard/summary" "${AUTH[@]}" | jq -r '.processed')" "null" "dashboard reports rules as not calculated"
curl -sf "$API/api/v1/audit-logs?entityType=Employee" "${AUTH[@]}" | jq -e '[.data[].action] | index("employee.create")' >/dev/null && pass "audit log written" || fail "audit log"

echo "All smoke checks passed."
