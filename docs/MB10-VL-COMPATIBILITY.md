# ZKTeco MB10-VL — Compatibility Checklist (Phase 1)

**Status: NOT YET VERIFIED.** The PUSH adapter in `backend/src/integrations/zkteco-push/` implements the
commonly documented ZKTeco PUSH ("ADMS", `/iclock/*`) behaviour and passes protocol test fixtures. It has
**not** been tested against a physical MB10-VL. Acceptance criterion #10 is open until every item marked
**Required** below is checked off with evidence (screenshots, captured requests, test logs).

## A. Identify the exact unit

| # | Check | How | Required | Result |
|---|---|---|---|---|
| A1 | Model label & hardware version | Device menu → System Info → Device Info | Yes | |
| A2 | Serial number (SN) | System Info, also sent as `?SN=` by the device | Yes | |
| A3 | Firmware version | System Info → Firmware; compare with `INFO=Ver …` the device sends | Yes | |
| A4 | Push protocol version | `pushver=` query parameter in the first handshake (check Device → Comm logs) | Yes | |
| A5 | Biometric modes enabled (face VL, fingerprint, card, PIN) | Device menu | Yes | |
| A6 | Whether "Cloud Server Setting"/ADMS menu exists on this firmware | Comm. menu | Yes | |

## B. Network & transport

| # | Check | Required | Notes |
|---|---|---|---|
| B1 | Device gets a static IP or DHCP reservation | Yes | |
| B2 | Device can reach server IP:8081 (same VLAN or routed) | Yes | Test with a laptop on the device VLAN first |
| B3 | HTTPS supported by the ADMS client? Which TLS versions? | Yes | If HTTP only: restrict port 8081 to device subnets / VPN (see nginx config) |
| B4 | Domain name vs IP-only server address | No | Some firmware accepts IP only |
| B5 | Proxy support needed? | No | |
| B6 | Device clock time zone and NTP availability | Yes | Must match the device `timezone` configured in ADMS |

## C. Protocol behaviour (capture real traffic)

Register the device in ADMS first (Devices → Register, protocol **ZK_PUSH**, exact SN). Then watch
**Device Details → Communication Log** and **Devices → Diagnostics → Rejected**.

| # | Check | Expected by adapter | Required | Observed |
|---|---|---|---|---|
| C1 | Handshake | `GET /iclock/cdata?SN=…&options=all` | Yes | |
| C2 | Heartbeat/command poll | `GET /iclock/getrequest?SN=…` every `Delay` seconds | Yes | |
| C3 | Attendance upload | `POST /iclock/cdata?SN=…&table=ATTLOG&Stamp=…`, tab-separated lines | Yes | |
| C4 | ATTLOG field order | `PIN, YYYY-MM-DD HH:mm:ss, state, verify, workcode, …` | Yes | |
| C5 | Device accepts `OK: n` acknowledgement and stops resending | Yes | |
| C6 | `TransFlag=TransData AttLog OpLog` honoured (vs. bitmask form) | Yes | If ignored, device may push templates; adapter discards them either way |
| C7 | Device uses newer endpoints (`/iclock/registry`, `/iclock/push`, `/iclock/querydata`)? | Yes | Logged as `UNSUPPORTED_PROTOCOL_VARIANT`. If seen, the adapter needs the newer protocol |
| C8 | `INFO` command returns firmware/user counts | No | Device Details → Test connection |
| C9 | `DATA QUERY ATTLOG StartTime…EndTime…` re-uploads a range | No | Needed for outage recovery |
| C10 | Verify-mode codes for face / fingerprint / card / PIN on this firmware | Yes | Record the numeric codes; they become the display mapping |
| C11 | Punch-state codes (check-in/out, break, OT) as configured on device | Yes | Device may be set to "auto" state; document the setting |
| C12 | Behaviour after server outage (does it queue and resend?) | Yes | Stop backend 10 min, punch, restart, confirm no loss and no duplicates |
| C13 | Behaviour when device storage is full / log rollover | No | |

## D. Security & privacy

| # | Check | Required |
|---|---|---|
| D1 | Unknown SN is rejected (try a second unregistered device or curl with a fake SN) | Yes |
| D2 | IP allowlist set for the device and verified | Recommended |
| D3 | Confirm no fingerprint/face templates or photos are stored (search DB/logs after enrolment) | Yes |
| D4 | Device admin menu protected with a device admin password | Yes |
| D5 | Comm key / device password set if firmware supports it for PUSH | No |

## E. Sign-off

- Tested firmware: ____________  Push version: ____________  Date: ____________
- Captured request samples stored in `backend/tests/fixtures/mb10-vl/` and added to the automated suite.
- Signed off by (IT): ____________  (HR): ____________

Until signed off, the dashboard shows the device's real state (it will read **Never connected** until the
device actually reaches the server), and no MB10-VL support is claimed.
