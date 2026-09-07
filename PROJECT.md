# Plant Automation — Project Reference

Complete build/dev/hardware reference for this repo, written so the project can be picked up on a fresh computer with no prior context. If something here and the code disagree, the code is right — this file describes the state as of **2026-09-07**.

## 1. What this is

A cloud-hosted misting / fertigation / fungicide controller for a 10-pot **Dendrobium orchid** setup in **Parakandeniya, Kadawatha, Sri Lanka** — 5 Thai hybrid varieties (Bangkok Peach, Pop Eye, Yellow Stripe, Caesar Pink, Thong Deang). One ESP32 unit today; the same backend is designed to run a multi-room greenhouse fleet later (Farm → Room → Unit hierarchy already exists in the schema and UI).

Design principle: **cloud-first, edge-autonomous**. The web app and data live on a hosted backend (Railway-style deployment target), but the ESP32 always keeps operating on its last-synced config if the network or backend is down — it never depends on a live connection to keep misting on schedule.

## 2. Repo layout

| Path | What it is |
|---|---|
| `backend/` | Node/Express + Postgres + Socket.IO API. REST for the device, REST + WebSocket for the web app. |
| `frontend/` | React (Vite) dashboard — farms/rooms/units, live status, schedules, variety templates, history, maintenance tasks. |
| `device-simulator/` | Node script that plays the role of the real ESP32 firmware (same REST contract), so the backend/UI can be tested and demoed without hardware. |
| `firmware/esp32-unit/` | Real ESP32 firmware (PlatformIO + Arduino framework). Same protocol as the simulator, flashable to actual hardware. |
| `db/init.sql` | Full schema, applied automatically on first Postgres start. Kept in sync with live `ALTER TABLE` changes made during development — always the source of truth for a fresh install. |
| `docs/` | Standalone HTML reference documents (open directly in a browser, no build step) plus generated PDF/spreadsheet deliverables — see §9. |
| `plant-automation-architecture.html` | Original system architecture write-up. |

## 3. Run it locally

```bash
cp .env.example .env      # edit if you want different local credentials
docker compose up -d --build
```

- Web app: **http://localhost:8090**
  Default login: `admin@example.com` / `changeme` (from `.env` — change before this ever goes near a real deployment)
- Backend API directly: **http://localhost:4000** (health check: `GET /api/health`)
- Postgres exposed on **localhost:5432** (`plantapp` / `plantapp` by default)
- A simulated "Unit 1" (`device-simulator`) starts automatically and begins syncing within seconds — no hardware required to see the whole system working, including live telemetry, mist/feed cycles, and the water-tank state machine (dechlorination hold, auto-fill, sped up for demo purposes — see §7.4).

To bring in a **real** ESP32 instead of (or alongside) the simulator, see [firmware/esp32-unit/README.md](firmware/esp32-unit/README.md) and the PlatformIO setup below (§8).

### Rebuilding after a code change

```bash
docker compose up -d --build            # rebuild + restart everything
docker compose up -d --build backend    # just one service
docker compose logs -f backend          # tail logs
docker compose exec db psql -U plantapp -d plantapp   # psql shell
```

The frontend is a static build served by nginx inside its container — a code change requires `--build`, there is no hot-reload in this Docker setup. Browser-side caching can also serve stale JS after a rebuild; hard-reload / clear cache if the UI doesn't reflect a change you just deployed.

## 4. Protocols, on purpose

- **Device ↔ backend**: plain REST over HTTP(S), polled on an interval (`POLL_INTERVAL_MS`, 60s default), bearer device-key auth (`Authorization: Bearer <deviceKey>`, compared with `crypto.timingSafeEqual`). No broker to run, resilient to reconnects — the unit always keeps misting on its last-synced config even if this link is down.
- **Browser ↔ backend**: REST for actions/config, WebSocket (Socket.IO) for live push (telemetry, status, events) so the dashboard doesn't have to poll. Clients `emit('subscribe', unitId)` to join that unit's room server-side.
- **User auth**: JWT. **Device auth**: a per-unit random key, checked with a constant-time comparison — never a JWT, never shared with the browser auth path.

## 5. Backend data model (Postgres)

Core tables (see `db/init.sql` for the authoritative, current schema):

- `users` — dashboard logins (bcrypt password hash).
- `farms` → `rooms` → `units` — the location hierarchy. A `unit` has a unique `device_key`.
- `templates` — per-variety default schedules (5 rows seeded: the Thai hybrids listed in §1). Applying a template in the UI copies its fields onto a unit's `unit_schedules` row; it does not link them permanently.
- `unit_schedules` — one row per unit, the actual live config synced to firmware. This is the table that grew the most during this project — see the column list below.
- `unit_status` — current `activity` string per unit (`idle`, `misting`, `feeding`, `fungicide`, `filling`, `dechlorinating`, `overflow`), pushed by the device and broadcast over the socket.
- `telemetry` — humidity/temp/rain **and** water-level sensor readings per poll (see §7.5 — this was added late in the project; earlier telemetry rows won't have the water columns populated).
- `events` — append-only log: `mist`, `feed`, `fungicide_reminder`, `fungicide_sprayed`, `autofill`, `overflow`. Free-form `type` text column, so new event types need no migration.
- `commands` — one-shot device commands queued by the dashboard (`mist_now`, `pause`, `resume`, `skip_feed`), delivered once then marked `delivered`.
- `maintenance_tasks` — recurring manual upkeep (clean tanks, rinse nozzles, recalibrate pump, etc.), completable from the UI, shown as upcoming events.

### `unit_schedules` full column reference

| Column | Meaning |
|---|---|
| `humidity_below`, `temp_above` | Mist trigger thresholds |
| `window_start`, `window_end` | AM window the unit always mists in regardless of thresholds |
| `poll_seconds` | How often the device syncs (mirrors `POLL_INTERVAL_MS`) |
| `cycle_weeks`, `feed_start_date` | Feed rotation length and anchor date — final week of a cycle is always a plain-water flush |
| `pre_water_wait_minutes` | Wait between the mist step and the feed dose on a feed day |
| `dose_ml` | **Computed** feed dose actually sent to firmware — see mix-ratio fields below |
| `feed_mix_ratio_ml_per_l`, `feed_batch_water_l` | User-facing inputs: concentrate mL per liter of water, and the batch water volume. The UI computes `dose_ml = ratio × volume` automatically. |
| `fungicide_interval_days`, `fungicide_last_sprayed_date` | Reminder cadence (spraying itself is manual unless `fungicide_automated`) |
| `fungicide_dose_ml`, `fungicide_mix_ratio_ml_per_l`, `fungicide_batch_water_l` | Same mix-ratio pattern as feed, for the fungicide line |
| `feed_product_early`, `feed_product_late`, `fungicide_product` | Free-text product names (see §6 for the actual products in use) |
| `fungicide_automated` | Opt-in — requires the dedicated 3rd pump/valve line + its own coarse nozzle, **never** the fine fogging manifold |
| `autofill_enabled` | Opt-in — requires the low+full water level sensor pair and inlet valve |
| `dechlorinate_hours` | **New.** Hours to hold misting after every tank fill (mains is chlorinated). Default 24. Editable per-unit from the dashboard — no reflash needed. |
| `pump_flow_lpm` | **New.** Actual misting pump flow rate, used to estimate volume dosed. Editable per-unit. |
| `paused`, `skip_feed_once` | One-shot/standing overrides from the dashboard |

All of the "New" fields above were added via live `ALTER TABLE` during this project and are reflected in `db/init.sql` for fresh installs — a fresh `docker compose up` gets the full current schema with no manual migration step.

## 6. Hardware overview

Full detail lives in the two generated reference documents copied into `docs/` (§9) — this is the summary.

### 6.1 Products in use

- **Fertilizer (early phase, weeks 1–2):** Basfoliar P-40 (13-40-13 + MgO + TE)
- **Fertilizer (late phase, weeks 3–4):** Nitro-tech Mugasole Treble 20 (20-20-20 + TE)
- **Fungicide:** Oasis Captan 50% WP

### 6.2 Water Tank — deliberately redesigned mid-project

The mains supply is chlorinated. The tank is a **50L open HDPE barrel**, not a sealed 500–1000L tank:

- **Open top, mesh lid only, never sealed** — chlorine needs to off-gas into open air; a sealed lid defeats this. The mesh keeps debris and mosquitoes out without trapping chlorine in.
- Firmware holds misting for a configurable **dechlorination hold** (`dechlorinate_hours`, default 24h) after every auto-fill event, tracked via an NVS-persisted timestamp so a reboot doesn't reset the clock early. Applies even to a forced `mist_now` — not skippable from the app.
- **Not a verified number** — 24h is a common rule-of-thumb dwell time for free-chlorine off-gassing by standing. The right value depends on the actual chlorine dosing used by the local water authority (NWSDB) and should be confirmed and adjusted per-installation.
- `AUTOFILL_MAX_SECONDS` (firmware safety backstop, not user-editable) was resized from 10 minutes to **3 minutes** to match the smaller tank — the old timeout would have let a stuck full-sensor overflow a 50L barrel.

### 6.3 Overflow limit switch — new safety hardware

A **mechanical float/limit switch**, mounted on the tank wall *above* the non-contact full sensor, wired to **GPIO36**:

- Always active — trips regardless of `autofill_enabled` or any app setting. Forces the inlet valve shut and raises an `overflow` event/status the moment it trips.
- GPIO34–39 have **no internal pull resistors** on the ESP32 — wire an external one (or use a switch module with one built in), or the reading floats.
- Not yet sourced from a specific verified supplier — search Tronic.lk / Duino.lk / Daraz for "float switch water level" or "limit switch water tank" and confirm voltage/contact type before ordering. (Every other link in the hardware doc is a real, checked listing; this one deliberately isn't, rather than fabricate a URL.)

### 6.4 Full pin reference

Matches `firmware/esp32-unit/src/Config.h` exactly — if you rewire differently, update that file too.

| Component pin | ESP32 pin | Notes |
|---|---|---|
| OLED SDA | GPIO21 | I2C, address 0x3C |
| OLED SCL | GPIO22 | |
| DHT22 data | GPIO4 | Add a 10kΩ pull-up to 3.3V if your module lacks one |
| Rain sensor digital out | GPIO16 | Verify polarity with a wet-finger test |
| Water level — low | GPIO34 | Input-only. Raw "liquid present" reading; firmware inverts it to decide "needs a fill" |
| Water level — full | GPIO35 | Input-only. Stops auto-fill |
| Water level — overflow limit switch | GPIO36 | Input-only, no internal pull resistor — see §6.3 |
| Relay IN1 (water pump) | GPIO25 | |
| Relay IN2 (water valve) | GPIO26 | |
| Relay IN3 (feed pump) | GPIO27 | |
| Relay IN4 (feed valve) | GPIO33 | |
| Relay IN5 (fungicide pump) | GPIO17 | Opt-in — wire only if `fungicide_automated` |
| Relay IN6 (fungicide valve) | GPIO18 | Feeds the dedicated coarse nozzle — never the fine fogging manifold |
| Relay IN7 (water inlet valve) | GPIO19 | Opt-in — wire only if `autofill_enabled` |
| Relay VCC (logic side) | 5V rail | Same rail as ESP32 — do not connect to the 12V bus |
| Relay COM (switched side) | 12V bus | Actually powers the pumps/valves |
| Boot button (Wi-Fi reset) | GPIO0 | Hold 3s at power-on to re-pair |
| All GND | common ground | Every ground must tie together or relays won't trigger reliably |

Pins deliberately avoided: 0, 2, 5, 12, 15 (boot-strapping), 6–11 (flash-connected, never usable).

### 6.5 Power budget

Worst realistic case is one pump + its own valve energized at once (firmware interlocks never run two lines simultaneously, never open a valve without its pump). Auto-fill can legitimately overlap a mist cycle (different lines), adding a fixed ~0.5A. Peak load ~2.5A against a 5A SMPS — comfortable headroom. Wire gauge: 18 AWG minimum for anything carrying pump current, 22–24 AWG fine for logic/signal.

### 6.6 Sri Lanka vs. foreign sourcing

Real, checked prices from Tronic.lk / Alphatronic.lk / Duino.lk / BNS Hardware / Daraz.lk / ThingsInNet vs. AliExpress, gathered 2026-09-07 — see `docs/price-comparison-srilanka-vs-foreign.xlsx`. Headline: small modules are usually cheaper via AliExpress even after accounting for some customs risk, but the margin shrinks once duty/VAT/lead-time (2–4 weeks) are factored in, and quality is far less certain than a named local supplier. Bulky items (tanks) and exact-fit mechanical parts (the check valve) aren't worth importing regardless of price.

## 7. Firmware behavior (`firmware/esp32-unit/src/`)

PlatformIO project, `espressif32` platform, `esp32dev` board, Arduino framework. Last verified build: **RAM 14.7% (48,284 / 327,680 B), Flash 84.0% (1,101,589 / 1,310,720 B)** — comfortable headroom on both.

### 7.1 Files

| File | Role |
|---|---|
| `main.cpp` | State machine, main loop, all the safety/gating logic described below |
| `Config.h` | Pins, hardware constants, polarity flags (compile-time, per-installation) |
| `DeviceConfig.h` | Mirrors the backend's `/api/device/config` shape — the *synced* settings (per-unit, over-the-air) |
| `SensorManager.h/.cpp` | DHT22, rain sensor, water level (low/full/overflow) reads — raw physical state only, no decision logic |
| `ActuatorController.h/.cpp` | Relay drive for all 7 channels |
| `CloudClient.h/.cpp` | REST calls to the backend (config fetch, telemetry/event/status posts, command poll) |
| `LocalCache.h/.cpp` | NVS persistence — cached config, Wi-Fi backend URL/device key, last-tank-fill timestamp |
| `DisplayDriver.h/.cpp` | OLED status display |
| `WifiSetup.h/.cpp` | WiFiManager captive-portal pairing, factory reset |
| `RuleEngine.h/.cpp` | Pure decision functions: should it mist now? Is today a feed day? Is fungicide due? |

### 7.2 The cycle state machine

```
enum class Cycle { IDLE, MISTING, WAIT_BEFORE_FEED, FEEDING, DOSING_FUNGICIDE };
```

Non-blocking — no multi-minute `delay()` calls, so telemetry/sync keep running throughout even the 15-minute pre-feed wait. Auto-fill runs as an independent tick (`tickAutofill()`), sharing no actuators with the mist/feed/fungicide lines, so it's never serialized with them.

### 7.3 Safety interlocks (in the order they're checked)

1. **Overflow limit switch** (`checkOverflow()`, runs first in `loop()`, every iteration) — hard cutoff, forces the inlet shut, independent of everything else.
2. **Dry-run guard** — `lowDetected` must be true or the pump never runs, forced request or not.
3. **Dechlorination hold** (`tankReady()`) — blocks misting until `dechlorinateHours` has passed since the last fill. Clock is NVS-persisted (`tankFilledAtEpoch`), so a reboot doesn't reset it early; if the RTC hasn't synced via NTP yet, `tankReady()` conservatively returns `false` rather than assuming it's safe.
4. **Active-low relay assumption** (`RELAY_ACTIVE_LOW`) — must match the actual relay board or every relay is inverted.
5. **Fungicide line separation** — the fungicide pump/valve feed a dedicated coarse nozzle that never tees into the shared fine fogging manifold. This is a plumbing invariant the firmware cannot detect or enforce; get it right physically.

### 7.4 Status reporting

`cycleLabel()` returns one of `misting / feeding / fungicide / filling / dechlorinating / overflow / idle`, shown on the OLED **and** pushed to the cloud via `postStatus()` — all of these reach the dashboard live over the socket. (A real bug was found and fixed here: the backend's activity whitelist originally only allowed `idle/misting/feeding`, silently rejecting `filling`/`fungicide` and would have rejected the two new states too — see `backend/src/routes/device.js`.)

### 7.5 Telemetry now includes water level

`postTelemetry()` sends `waterLow` / `waterFull` / `waterOverflow` alongside humidity/temp/rain (added this session — earlier code only sent environmental readings). This is what drives the live tank visualization in the dashboard (§8.3) — it reflects real sensor booleans, not a simulated percentage.

## 8. Flashing real firmware

```bash
cd firmware/esp32-unit
pio run                 # compile
pio run -t upload       # flash (device connected via USB)
pio device monitor      # serial console, 115200 baud
```

First boot: the unit starts a Wi-Fi captive portal (`PlantAutomation-Setup`) for pairing — connect to it from a phone/laptop to hand it your Wi-Fi credentials and backend URL/device key. Hold the BOOT button (GPIO0) 3s at power-on to force re-pairing later.

To generate a device key for a new unit, create it from the dashboard (Units → new unit) — the backend returns a random `device_key` at creation time.

## 9. Reference documents in this repo

All standalone, open directly in a browser (no build step) or as generated files:

| File | What it is |
|---|---|
| `docs/wiring-diagram.html` | Full electrical + plumbing wiring diagram, pin table, power budget, tank/plumbing routing, dechlorination hold explanation, pre-power-on checklist (9 items). Kept in sync with `Config.h`. |
| `docs/hardware-and-wiring-reference.pdf` | Same wiring diagram plus the complete hardware purchase list (real Sri Lankan supplier links, organized by already-have/critical/recommended/optional), generated as a standalone PDF. |
| `docs/price-comparison-srilanka-vs-foreign.xlsx` | Sri Lanka vs. AliExpress/eBay price comparison, 11 items, with sourcing methodology on a second sheet. |
| `docs/greenhouse-design.html` | Reference greenhouse structure + automatic multi-product fertigation design (the longer-term Phase 3 vision). |
| `docs/iot-3d-model.html` | Real interactive 3D (Three.js) model of the physical setup — orbit/zoom, click the control box / pump / tank to open them and see internals (ESP32, relay board, buck converter, diaphragm, wiring). |
| `docs/iot-3d-layout.html` | Superseded isometric-SVG 3D layout (kept for history — `iot-3d-model.html` replaced it with real WebGL 3D). |
| `plant-automation-architecture.html` | Original full system architecture write-up. |

These same documents (except the newest PDF/xlsx) were also published as private Claude Artifacts during development for easy sharing — those links only work from the account that published them, so the files in this repo are the portable, permanent copies.

## 10. Known gaps / not yet done

- **Feed pump/valve** not yet physically ordered (relay channels 3/4 are wired in firmware and the dashboard, but the hardware itself isn't in hand yet per the hardware doc's "already have" list).
- **Overflow limit switch** — logic and pin are fully implemented and compiled, but the physical part hasn't been sourced from a verified supplier yet (§6.3).
- **Dechlorination hold default (24h)** is a reasonable starting assumption, not empirically verified against Sri Lanka's actual NWSDB chlorine dosing. Should be tuned once a chlorine test kit or local water-quality data is available.
- **Logic/process flowchart** (full operational decision-flow diagram, distinct from the electrical wiring diagram) was discussed but not yet produced.
- **`AUTOFILL_MAX_SECONDS` (3 min)** is a first-pass estimate for the 50L barrel — time an actual fill once the inlet valve is wired and tighten further if real mains flow fills faster than assumed.

## 11. Credentials & environment variables

See `.env.example` for the full list. Never commit a real `.env` — it's gitignored. Defaults used by `docker compose` if `.env` is absent:

| Variable | Default | Used for |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `plantapp` / `plantapp` / `plantapp` | Local Postgres |
| `JWT_SECRET` | `dev-secret-change-me` | Dashboard session signing — **must** change for any real deployment |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@example.com` / `changeme` | First-run seeded dashboard login |
| `DEMO_DEVICE_KEY` | `dev-unit-1-key` | Device key shared by the backend and the `device-simulator` container |

## 12. Deployment note

Designed for a Railway-style host (or any Docker-friendly PaaS): `backend`, `frontend`, and `db` are the three services that matter in production (`device-simulator` is dev/demo-only — never deploy it alongside a real unit). Set real values for `JWT_SECRET`, `ADMIN_PASSWORD`, and `POSTGRES_PASSWORD` before deploying anywhere reachable from the internet, and give each real ESP32 its own generated `device_key` rather than reusing the demo one.
