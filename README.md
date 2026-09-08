# Plant Automation

A cloud-hosted misting/feeding controller for Dendrobium orchid greenhouses
in Sri Lanka. The addressable hardware is **not per-bench** — each farm has
one shared water tank + fertilizer mixing rig, and each greenhouse room has
one shared environment sensor + misting controller. Benches are just named,
positioned spots on a room's floor-plan map. See
[plant-automation-architecture.html](plant-automation-architecture.html)
for the fuller design writeup (some of it predates this room/farm-level
model — the tables below are current).

**New to this repo, or picking it up on a different machine?** Start with
[PROJECT.md](PROJECT.md) for setup and hardware background, but note it
also predates the room/farm re-architecture described here.

## The device model

| Level | What it owns | Addressable? |
|---|---|---|
| **Farm** (🏡) | One shared water tank (low/full sensors) + one fertigation rig (mix → stir → filter → dose). Services whichever room's feed day it is, one room at a time. | Yes — its own `device_key`, polls `/api/device/farm/*` |
| **Room** (🏠, a greenhouse) | One environment sensor (humidity/temp/rain) + misting for every bench in it, together. | Yes — its own `device_key`, polls `/api/device/room/*` |
| **Bench** | A name + a position on the room's map. No sensor, no schedule, no device of its own. | No — plain CRUD via `/api/benches` |

## Parts of this repo

| Path | What it is |
|---|---|
| `backend/` | Node/Express + Postgres + Socket.IO API. Two device-facing route groups (`/api/device/room`, `/api/device/farm`), plus REST + WebSocket for the web app. |
| `frontend/` | React dashboard — farms/rooms, live status, schedules, variety templates, draggable bench floor-plan, history. |
| `simulator/` | A single Node process that plays every room + farm controller in the fleet as live simulated hardware (mist/fertigation/tank state machines), for testing without real hardware. Sensor baselines track real current weather per farm. |
| `firmware/esp32-unit/` | Real ESP32 firmware reference — written for the older per-bench protocol; not yet updated for the room/farm split. |
| `db/init.sql` | Schema, applied automatically on first Postgres start. |

## Run it locally

```bash
cp .env.example .env      # edit if you want different local credentials
docker compose up -d --build
```

- Web app: http://localhost:8090 (default login `admin@example.com` /
  `changeme`, from `.env` — change it before this goes anywhere near
  Railway)
- Backend API directly: http://localhost:4000
- The `simulator` service auto-discovers every farm/room in the database and
  starts polling within seconds — no hardware required to see the whole
  system working.

## Protocols, on purpose

- **Device ↔ backend**: plain REST over HTTP(S), polled on an interval,
  bearer device-key auth (one key per room, one per farm). No broker to
  run, resilient to reconnects — a room keeps misting on its last-synced
  config even if this link is down.
- **Browser ↔ backend**: REST for actions/config, WebSocket (Socket.IO)
  for live push (telemetry, mist/fertigation status) so the dashboard
  doesn't have to poll.
- **User auth**: JWT. **Device auth**: a per-device random key, checked
  with a constant-time comparison against every key on file (cached
  in-memory, refreshed every 20s — see `backend/src/deviceAuth.js`).
