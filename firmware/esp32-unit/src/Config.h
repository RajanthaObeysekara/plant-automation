#pragma once

// ---------- What this board is ----------
// A ROOM controller only: one climate sensor pair (DHT22 + rain) and this
// room's misting line (one pump relay + one valve relay). The shared water
// tank, auto-fill, and fertigation/dosing rig are now a separate FARM
// device in the backend's data model (backend/src/routes/device.js,
// buildFarmDeviceRouter) — that hardware (load cells, mixing/dosing pumps)
// doesn't exist yet, so there is no farm firmware yet either. See
// PROJECT.md §"Firmware scope" for why the split happened and what's still
// simulator-only. Feed and fungicide dosing are NOT actuated by this board
// — it only ever posts a reminder event; a human (or, later, a real farm
// controller) does the actual dosing.

// ---------- Pins ----------
// Chosen to avoid boot-strapping pins (0, 2, 5, 12, 15) and the
// flash-connected pins (6-11, never usable).
#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_DHT22 4
#define PIN_RAIN_DIGITAL 16

#define PIN_RELAY_WATER_PUMP 25
#define PIN_RELAY_WATER_VALVE 26

#define PIN_WIFI_RESET_BUTTON 0 // the devkit's BOOT button

// FC-37/YL-83 comparator boards vary by manufacturer — some pull the digital
// pin HIGH when wet, others LOW. Verify with a wet finger on the probe
// before trusting this in the field, then flip if needed.
#define RAIN_ACTIVE_HIGH true

// Most cheap relay modules energize on a LOW signal.
#define RELAY_ACTIVE_LOW true

// ---------- Display ----------
#define OLED_WIDTH 128
#define OLED_HEIGHT 32
#define OLED_I2C_ADDRESS 0x3C

// ---------- Timing ----------
#define POLL_INTERVAL_MS 60000UL
#define MIST_DURATION_SECONDS 20
#define MIST_COOLDOWN_MS (5UL * 60UL * 1000UL)

// Server-initiated sync: on every boot this board tries to reach the
// backend before trusting whatever's cached in NVS from last time — a
// stale local guess is a worse default than a real answer when one's
// available. Only falls back to NVS after genuinely exhausting these.
#define BOOT_SYNC_MAX_ATTEMPTS 5
#define BOOT_SYNC_RETRY_DELAY_MS 4000UL

// Sri Lanka does not observe daylight saving; UTC+5:30 is fixed.
#define TZ_GMT_OFFSET_SEC (5 * 3600 + 30 * 60)
#define TZ_DST_OFFSET_SEC 0
#define NTP_SERVER "pool.ntp.org"

// ---------- Cloud sync ----------
// Filled in via the Wi-Fi setup portal, then persisted to NVS.
#define WIFI_PORTAL_NAME "PlantAutomation-Setup"
#define NVS_NAMESPACE "roomcfg"
