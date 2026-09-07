#pragma once

// ---------- Pins ----------
// Chosen to avoid boot-strapping pins (0, 2, 5, 12, 15) and the
// flash-connected pins (6-11, never usable). 34-39 are input-only — fine for
// sensor reads, unusable for relay outputs — used deliberately below.
#define PIN_I2C_SDA 21
#define PIN_I2C_SCL 22
#define PIN_DHT22 4
#define PIN_RAIN_DIGITAL 16
#define PIN_WATER_LEVEL_LOW 34  // non-contact sensor, low point: "needs a fill" / dry-run guard
#define PIN_WATER_LEVEL_FULL 35 // non-contact sensor, high point: stops auto-fill
#define PIN_WATER_LEVEL_LIMIT 36 // mechanical float switch, mounted ABOVE the full sensor — last-resort
                                  // overflow cutoff if the full sensor sticks or fails; always active,
                                  // not gated by autofill_enabled

#define PIN_RELAY_WATER_PUMP 25
#define PIN_RELAY_WATER_VALVE 26
#define PIN_RELAY_FERT_PUMP 27
#define PIN_RELAY_FERT_VALVE 33
#define PIN_RELAY_FUNGICIDE_PUMP 17  // optional 3rd line — only wired if fungicide_automated
#define PIN_RELAY_FUNGICIDE_VALVE 18 // feeds its own coarse nozzle, NOT the shared fogging manifold
#define PIN_RELAY_WATER_INLET 19    // opens the main tank's mains/rainwater inlet for auto-fill

#define PIN_WIFI_RESET_BUTTON 0 // the devkit's BOOT button

// FC-37/YL-83 comparator boards vary by manufacturer — some pull the digital
// pin HIGH when wet, others LOW. Verify with a wet finger on the probe
// before trusting this in the field, then flip if needed.
#define RAIN_ACTIVE_HIGH true

// Non-contact level sensors: verify polarity the same way as the rain sensor
// before trusting either in the field.
#define WATER_LEVEL_ACTIVE_HIGH true

// Mechanical float/limit switch is a separate physical device from the two
// non-contact sensors above and may well have different polarity — verify
// independently, don't assume it matches WATER_LEVEL_ACTIVE_HIGH.
#define WATER_LEVEL_LIMIT_ACTIVE_HIGH true

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
#define FEED_RUN_SECONDS 10
#define FUNGICIDE_RUN_SECONDS 10

// Safety cutoff independent of the level sensor — if the "full" sensor never
// triggers (stuck float, sensor failure, dry mains) the inlet valve still
// closes on its own rather than running indefinitely. Sized for a 50L open
// barrel (not the old 500-1000L tank) — a stuck sensor for the full 10
// minutes this used to allow would overflow a 50L barrel long before the
// cutoff ever tripped. Time an actual fill once wired up and tighten this
// further if your mains pressure fills faster than this assumes.
#define AUTOFILL_MAX_SECONDS (3UL * 60UL)

// Mains water here carries chlorine, so the tank is deliberately an OPEN
// (vented, not sealed) barrel — chlorine off-gasses on its own once exposed
// to air, but only after sitting for a while. Misting is held back from a
// freshly filled tank for DeviceConfig::dechlorinateHours (user-configurable
// from the app, default 24h) — see DeviceConfig.h. Not a #define anymore
// since this is now a per-unit setting synced from the backend, not a fixed
// firmware constant.

// Sri Lanka does not observe daylight saving; UTC+5:30 is fixed.
#define TZ_GMT_OFFSET_SEC (5 * 3600 + 30 * 60)
#define TZ_DST_OFFSET_SEC 0
#define NTP_SERVER "pool.ntp.org"

// ---------- Cloud sync ----------
// Filled in via the Wi-Fi setup portal, then persisted to NVS.
#define WIFI_PORTAL_NAME "PlantAutomation-Setup"
#define NVS_NAMESPACE "plantcfg"
