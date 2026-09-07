# Plant Automation

A cloud-hosted misting/feeding controller for a 10-pot Dendrobium orchid
setup in Kadawatha, Sri Lanka — one ESP32 unit today, the same backend a
multi-room greenhouse fleet will use later. See
[plant-automation-architecture.html](plant-automation-architecture.html)
for the full design writeup.

**New to this repo, or picking it up on a different machine?** Start with
[PROJECT.md](PROJECT.md) — full setup, architecture, hardware, pin
reference, firmware behavior, and known gaps in one place.

## Parts of this repo

| Path | What it is |
|---|---|
| `backend/` | Node/Express + Postgres + Socket.IO API. REST for the device, REST + WebSocket for the web app. |
| `frontend/` | React dashboard — farms/rooms/units, live status, schedules, variety templates, history. |
| `device-simulator/` | A Node script that plays the role of the ESP32 firmware, for testing the backend/UI without hardware. |
| `firmware/esp32-unit/` | The real ESP32 firmware (PlatformIO/Arduino) — same protocol as the simulator, flashable to actual hardware. |
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
- A simulated "Unit 1" starts automatically and begins syncing within a
  few seconds — no hardware required to see the whole system working.

To bring in a **real** ESP32 instead of (or alongside) the simulator, see
[firmware/esp32-unit/README.md](firmware/esp32-unit/README.md).

## Protocols, on purpose

- **Device ↔ backend**: plain REST over HTTP(S), polled on an interval,
  bearer device-key auth. No broker to run, resilient to reconnects —
  the unit always keeps misting on its last-synced config even if this
  link is down.
- **Browser ↔ backend**: REST for actions/config, WebSocket (Socket.IO)
  for live push (telemetry, mist/feed status) so the dashboard doesn't
  have to poll.
- **User auth**: JWT. **Device auth**: a per-unit random key, checked
  with a constant-time comparison.
