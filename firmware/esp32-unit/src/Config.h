#pragma once

// ---------- What this board is ----------
// A ROOM controller — monitoring only for now: two DHT22 climate sensors
// and a live status display. No relay/pump/valve is physically wired yet,
// so this build never actuates misting or claims it did (see main.cpp) —
// it just reports real sensor telemetry to the dashboard. The shared water
// tank, auto-fill, and fertigation/dosing rig are a separate FARM device in
// the backend's data model (backend/src/routes/device.js,
// buildFarmDeviceRouter) — that hardware doesn't exist yet either. See
// PROJECT.md §"Firmware scope" for why the split happened.

// ---------- Pins ----------
// Chosen to avoid boot-strapping pins (0, 2, 5, 12, 15) and the
// flash-connected pins (6-11, never usable).
#define PIN_DHT22_1 4
#define PIN_DHT22_2 21   // freed up by moving the OLED off I2C onto SPI (see below)

// MD0019 rain sensor (YL-83/FC-37, tronic.lk) — LM393 comparator board,
// runs fine at 3.3V so DO swings a clean 0-3.3V straight into a GPIO, no
// divider needed. Documented behavior for this exact module family: DO
// goes LOW when the plate is wet (comparator trips), HIGH when dry.
#define PIN_RAIN_DIGITAL 17
#define RAIN_ACTIVE_LOW true

// 24-output shift register board (3x 74HC595, LED-matrix-driver labels),
// powered from 3V3. Only its LDSI end is wired; the far (cascade) end is
// left unconnected. A 10k resistor from LDEN to 3V3 keeps every output
// disabled while the ESP32 boots, until ShiftRegister::begin() has latched
// an all-off frame — so no relay can click on at power-up.
#define PIN_SR_DATA   32 // LDSI  (SER)
#define PIN_SR_CLOCK  22 // LDSCK (SRCLK)
#define PIN_SR_LATCH  25 // LDSRT (RCLK)
#define PIN_SR_ENABLE 26 // LDEN  (OE) + 10k pull-up to 3V3
#define SR_ENABLE_ACTIVE_LOW true // standard 74HC595 OE; flip if outputs never switch
#define SR_CHIP_COUNT 3
#define SR_OUTPUT_COUNT (SR_CHIP_COUNT * 8)
// Level every output rests at when "off". The outputs feed relay inputs,
// so idle = relay de-energized — HIGH on the usual active-low relay board
// (RELAY_ACTIVE_LOW below). Latching all-LOW at boot instead would
// energize every connected relay.
#define SR_IDLE_HIGH RELAY_ACTIVE_LOW

// MD0020 HX711 load cell amplifier, powered from 3V3 (at 5V its DT line
// would drive 5V into the ESP32). DT on an input-only pin is fine — the
// HX711 drives it actively, no pull-up needed. GPIO13 misread as an INPUT
// earlier on this board, but SCK is an output. Load cell on channel A:
// red E+, black E-, white A-, green A+ (swap A+/A- if weight reads negative).
#define PIN_HX711_DT  35
#define PIN_HX711_SCK 13
#define WEIGHT_AVG_SAMPLES 20     // ~2s of readings at the HX711's 10Hz rate; the extremes are trimmed (see WeightSensor::raw())
#define WEIGHT_STALE_MS 2000UL    // no reading for this long = HX711 missing/disconnected
#define NVS_WEIGHT_NAMESPACE "weight"
// Zero handling, as on a commercial scale: readings within the deadband
// show as exactly 0, and while the load sits near zero the zero point
// slowly follows the load cells' thermal/settling drift (rate-limited far
// below any real fill, e.g. 10 L/min = 0.17 kg/s, so real weight isn't
// tracked away).
#define WEIGHT_ZERO_DEADBAND_KG 0.1f
#define WEIGHT_ZERO_TRACK_BAND_KG 0.5f
#define WEIGHT_ZERO_TRACK_RATE_KG_PER_S 0.02f
// Every boot re-zeroes the scale: whatever is on the platform at power-up
// becomes 0 kg. Waits for the load cells to settle (a full sample window
// at least WEIGHT_BOOT_TARE_SETTLE_MS after the first reading, spread under
// WEIGHT_BOOT_TARE_STABLE_KG), or takes zero anyway after
// WEIGHT_BOOT_TARE_MAX_WAIT_MS. Not written to NVS - only a manual `tare` is.
#define WEIGHT_BOOT_TARE_SETTLE_MS 3000UL
#define WEIGHT_BOOT_TARE_MAX_WAIT_MS 15000UL
#define WEIGHT_BOOT_TARE_STABLE_KG 0.2f

// Relay channels, as shift register outputs (Qn) rather than GPIOs.
#define SR_OUT_WATER_PUMP  1
#define SR_OUT_WATER_VALVE 2

// Bench test: energizes outputs 1-24 (Q0-Q23) one at a time in order,
// one step every SR_TEST_INTERVAL_MS, then de-energizes them in the same
// order, and repeats — visible live on the OLED's bottom dot strip.
// Pump/valve actuation is off (ACTUATION_ENABLED in main.cpp), so nothing
// else drives the outputs. Set to 0 once the board is verified — with
// relays connected this clicks every channel.
// ON by default while the boards are bench units with no pumps/valves
// wired (boards are only reachable through OTA now). MUST go back to 0 in
// the release that precedes connecting real pumps/valves, or they cycle.
#define SR_TEST_ENABLED 1 // default for boards that never chose; `srtest on|off` (serial or the srtest_on/off
                          // command) switches it AND remembers the choice per board in NVS ("sr_test")
#define SR_TEST_INTERVAL_MS 150UL

#define PIN_WIFI_RESET_BUTTON 0 // the devkit's BOOT button

// Whether this board has the tank float switches wired is a per-board
// setting in NVS now ("has_tank", see Secrets.h) — one firmware image
// serves every board, so it can't be a build flag any more. Only the unit
// the switches are actually wired to may set it, or its floating pins
// would report bogus readings that race with the real ones.

// Two bench-test farm tank float switches, low/high marks, bench-wired to
// this unit for testing (see has_tank above and getTankWetness()
// in main.cpp). Architecturally this belongs on the farm controller (tank
// low/full/overflow), which doesn't physically exist yet — provisional so
// the sensors themselves can be verified now. (An MD0374 optical sensor
// was tried as a third TOP sensor earlier but isn't part of this setup —
// only these two float switches are wired.)

// LOW mark — MD0372 horizontal float switch (tronic.lk). Passive magnetic
// reed switch: no power wire, just two contacts that close/open as the
// float tilts. Its "100V/0.5A" spec is the MAXIMUM load the contacts could
// switch directly (e.g. driving a relay coil) — we're only reading its
// open/closed state, at microamps, so it just needs the ESP32's internal
// pull-up: one wire to GND, the other to this pin. Picked a pin outside
// 34-39 deliberately — those ESP32 GPIOs have no internal pull-up/down
// hardware at all, so INPUT_PULLUP would silently do nothing there.
#define PIN_WATER_LEVEL_FLOAT 19

// HIGH mark — a second float switch, same kind as PIN_WATER_LEVEL_FLOAT
// above — same wiring (GND + this pin, internal pull-up, no other parts).
#define PIN_WATER_LEVEL_FLOAT_2 16

// Most cheap relay modules energize on a LOW signal. Unused for now — see
// ACTUATION_ENABLED in main.cpp — kept for when a relay is actually wired.
#define RELAY_ACTIVE_LOW true

// ---------- Display ----------
// DM0054 0.95" 96x64 full-color SPI OLED, SSD1331 driver. Bench-tested on
// this exact board: hardware (peripheral) SPI hung/reset on any real pixel
// write — command-only bytes worked, but a real pixel burst never did.
// Software (bit-banged) SPI on the same pins does not have that problem,
// so DisplayDriver uses the 5-pin software-SPI constructor, not the
// 3-pin hardware-SPI one.
#define OLED_WIDTH 96
#define OLED_HEIGHT 64
#define PIN_OLED_CS   27
#define PIN_OLED_DC   14
#define PIN_OLED_MOSI 23
#define PIN_OLED_SCLK 18
#define PIN_OLED_RST  33

// ---------- Timing ----------
// Local sensor read + telemetry-send-check cadence. Reading is free (no
// network); actually publishing is separately gated by maybeSendTelemetry()
// in main.cpp (only sends on a real change, or CONFIG_SYNC_FALLBACK_MS of
// silence) — 15s here just keeps the OLED and RuleEngine fed with fresh
// local readings, it doesn't mean a message goes out every 15s.
#define POLL_INTERVAL_MS 15000UL
// Explicit config_request fallback — a real MQTT message, so kept
// infrequent. Pause/Resume/schedule changes normally reach the device
// within moments anyway via the backend's own push onto the retained
// <deviceKey>/config topic (see CloudClient::pollPushedConfig(), checked
// every loop() iteration at zero message cost) — this is just the safety
// net for a push that got missed (e.g. mid-reconnect).
#define CONFIG_SYNC_FALLBACK_MS (2UL * 60UL * 1000UL)
// Commands (Mist now) are checked on their own separate, much faster loop
// — a dashboard button press should visibly react in a few seconds, not
// wait for the next full sync. See pollCommandsFast() in main.cpp. This is
// also message-free (drains a locally-buffered push, no network call).
#define COMMAND_POLL_MS 3000UL
#define MIST_DURATION_SECONDS 20
#define MIST_COOLDOWN_MS (5UL * 60UL * 1000UL)
#define DHT_READ_INTERVAL_MS 2500UL // DHT22 needs >=2s between reads on a given sensor

// Server-initiated sync: on every boot this board tries to reach the
// backend before trusting whatever's cached in NVS from last time — a
// stale local guess is a worse default than a real answer when one's
// available. Only falls back to NVS after genuinely exhausting these.
#define BOOT_SYNC_MAX_ATTEMPTS 5
#define BOOT_SYNC_RETRY_DELAY_MS 4000UL

// Sri Lanka does not observe daylight saving; UTC+5:30 is fixed.
#define TZ_GMT_OFFSET_SEC (5 * 3600 + 30 * 60)
#define TZ_DST_OFFSET_SEC 0
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.google.com"
#define NTP_SERVER_3 "time.cloudflare.com"
// Plain HTTP (no TLS) on purpose: only the Date response header is read,
// and TLS itself needs a valid clock to verify certificates.
#define TIME_HTTP_FALLBACK_URL "http://www.google.com/"
#define TIME_RETRY_MS 20000UL

// ---------- Cloud sync ----------
#define NVS_NAMESPACE "roomcfg"

// MQTT (HiveMQ Cloud), not the old HTTP polling — a router on this unit's
// own WiFi network blocks it from reaching a LAN-local backend directly
// (client/AP isolation), which a cloud broker sidesteps entirely: both this
// board and the backend just make normal outbound internet connections to
// it, no LAN-to-LAN traffic involved. Also genuinely two-way — the backend
// pushes commands/config the instant they change instead of this board
// polling for them.
//
// The broker address is public; the login is NOT kept here. WiFi and MQTT
// credentials and the device key live in NVS (Secrets.h), written once per
// board by tools/provision.py — this firmware image is published publicly
// for OTA updates, so nothing secret may be compiled into it.
#define MQTT_HOST "d9fd015cce0745229fd10077daa3f527.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883

// ---------- Firmware version + over-the-air updates ----------
// FW_VERSION comes from the release tag in CI (FW_VERSION env var, see
// platformio.ini and .github/workflows/firmware.yml). Local builds are
// "0.0.0-dev" and never auto-install a release over themselves — only an
// explicit `ota check` / dashboard command does that, so bench work isn't
// silently replaced.
#ifndef FW_VERSION
#define FW_VERSION ""
#endif
#define FW_VERSION_DEV "0.0.0-dev"

// Latest release's manifest (GitHub redirects /latest/ to the newest tag).
// Overridable per board with the `ota_url` secret, e.g. for testing.
#define OTA_MANIFEST_URL "https://github.com/RajanthaObeysekara/plant-automation/releases/latest/download/manifest.json"
#define OTA_CHECK_INTERVAL_MS (60UL * 60UL * 1000UL)   // hourly: GitHub is the only update path now
#define OTA_FIRST_CHECK_DELAY_MS (60UL * 1000UL)   // settle after boot first
#define OTA_BUSY_RETRY_MS (5UL * 60UL * 1000UL)    // pump/valves busy -> try again later
#define OTA_FAIL_RETRY_MS (10UL * 60UL * 1000UL)   // GitHub unreachable -> try again sooner than 6h
// Weak links drop mid-download: resume from the last byte (HTTP Range) up
// to this many times; a connection silent for OTA_STALL_MS counts as dropped.
#define OTA_DOWNLOAD_ATTEMPTS 5
#define OTA_STALL_MS 30000UL
// A freshly installed image has this long to prove itself (main loop
// running + WiFi up) before it is confirmed; if it crashes or never gets
// there, the bootloader rolls back to the previous image.
#define OTA_CONFIRM_AFTER_MS (60UL * 1000UL)
#define OTA_GIVE_UP_AFTER_MS (5UL * 60UL * 1000UL)
