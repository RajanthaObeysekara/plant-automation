#include <Arduino.h>
#include <WiFi.h>
#include <time.h>
#include <vector>

#include "Config.h"
#include "DeviceConfig.h"
#include "RuleEngine.h"
#include "SensorManager.h"
#include "ActuatorController.h"
#include "CloudClient.h"
#include "DisplayDriver.h"
#include "LocalCache.h"
#include "WifiSetup.h"

SensorManager sensors;
ActuatorController actuators;
CloudClient cloud;
DisplayDriver oled;
DeviceConfig cfg;

// Just IDLE/MISTING now — feed and fungicide dosing are never actuated by
// this board (no farm/dosing hardware exists yet, see Config.h), so there's
// no WAIT_BEFORE_FEED/FEEDING/DOSING_FUNGICIDE state to run through. Those
// become reminder *events* posted from the IDLE branch of housekeeping(),
// not cycle states.
enum class Cycle { IDLE, MISTING };
Cycle cycle = Cycle::IDLE;
unsigned long cycleStartedAt = 0;
Reading currentReading;
bool cycleWasForced = false;

unsigned long lastHousekeepingAt = 0;
unsigned long lastMistAt = 0;
bool mistRequested = false;
String lastFeedReminderOn = "";
String lastFungicideReminderOn = "";
String lastSkippedReminderOn = "";

String todayKey(const struct tm &t) {
  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
  return String(buf);
}

// Server-initiated scheduling: looks up today's entry in the cached 7-day
// plan (see DeviceConfig.h / backend/src/planner.js) rather than computing
// feed/fungicide timing from raw date math on this board. Returns nullptr
// if the plan doesn't cover this date — e.g. the device has been offline
// long enough that even the week-ahead plan has run out; the caller treats
// that as "nothing scheduled" rather than guessing.
const PlanDay *findPlanDay(const String &dateKey) {
  for (int i = 0; i < cfg.planCount; i++) {
    if (cfg.plan[i].date == dateKey) return &cfg.plan[i];
  }
  return nullptr;
}

void startMist(bool forced) {
  cycle = Cycle::MISTING;
  cycleStartedAt = millis();
  cycleWasForced = forced;
  lastMistAt = millis();
  actuators.startWaterLine();
  cloud.postStatus("misting");
  oled.showStatus("Misting...", String(MIST_DURATION_SECONDS) + "s run");
  Serial.printf("[cycle] misting started%s\n", forced ? " [manual override]" : "");
}

// Fetches this room's config (+ 7-day plan) from the server and, on
// success, replaces the cached copy in both RAM and NVS. On failure, `cfg`
// is left exactly as it was — whatever was last synced (or loaded from NVS
// at boot) keeps being acted on. Never assumes a fetch failure means
// anything about *why*; Wi-Fi drop, backend restart, and DNS hiccup all
// look the same from here and are all handled the same way: keep going on
// the last good answer.
bool syncConfig(bool isBoot) {
  DeviceConfig fresh = cfg;
  if (!cloud.fetchConfig(fresh, isBoot)) return false;
  cfg = fresh;
  LocalCache::save(cfg);
  return true;
}

// Telemetry, command handling, and the mist/feed/fungicide decision — runs
// against whatever `cfg` currently holds, fresh or cached. Called once
// right after the boot-sync attempt in setup(), then every POLL_INTERVAL_MS
// from loop() via housekeeping().
void actOnCurrentConfig() {
  if (!cfg.valid) {
    Serial.println("[main] no config synced yet and nothing cached — nothing to act on");
    return;
  }

  currentReading = sensors.read();
  if (currentReading.valid) {
    cloud.postTelemetry(currentReading.humidity, currentReading.tempC, currentReading.raining, cfg.scheduleVersion);
  }

  for (const String &type : cloud.pollCommands()) {
    Serial.println("[main] command received: " + type);
    if (type == "mist_now") mistRequested = true;
    // pause / resume / skip_feed are applied server-side already and
    // arrive here as ordinary fields on the next syncConfig().
  }

  if (cycle != Cycle::IDLE) return;

  time_t now = time(nullptr);
  struct tm nowTm;
  localtime_r(&now, &nowTm);
  String todayStr = todayKey(nowTm);
  const PlanDay *today = findPlanDay(todayStr);

  bool cooledDown = millis() - lastMistAt > MIST_COOLDOWN_MS;
  bool tankOk = cfg.tankReady; // reported by the room's own config fetch, sourced from the farm device
  bool wants = tankOk && (mistRequested
    || (currentReading.valid && cooledDown
        && RuleEngine::shouldMist(nowTm, currentReading.humidity, currentReading.tempC, currentReading.raining, cfg)));

  if (mistRequested && !tankOk) {
    Serial.println(cfg.tankLow
      ? "[main] mist_now ignored — shared tank is low"
      : "[main] mist_now ignored — shared tank not ready");
    cloud.postMistSkipped(cfg.tankLow ? "tank_low" : "tank_not_ready");
  } else if (wants && !tankOk && lastSkippedReminderOn != todayStr) {
    // Would have misted on its own trigger, but the shared tank isn't
    // ready — surface this once a day rather than staying silently idle.
    lastSkippedReminderOn = todayStr;
    cloud.postMistSkipped(cfg.tankLow ? "tank_low" : "tank_not_ready");
  }

  if (wants) {
    bool forced = mistRequested;
    mistRequested = false;
    startMist(forced);
  } else if (!tankOk) {
    mistRequested = false; // don't leave a stale request queued forever while the tank isn't ready
  }

  if (today && today->fungicideDue && lastFungicideReminderOn != todayStr) {
    lastFungicideReminderOn = todayStr;
    cloud.postFungicideReminder(cfg.fungicideLastSprayedDate);
    Serial.println("[main] fungicide reminder raised (spraying is always manual)");
  }

  bool alreadyFedToday = cfg.lastFedDate == todayStr || lastFeedReminderOn == todayStr;
  if (today && today->isFeedDay && !cfg.skipFeedOnce && !alreadyFedToday) {
    lastFeedReminderOn = todayStr;
    cloud.postFeedReminder(todayStr, today->doseMl);
    Serial.printf("[main] feed reminder raised — %d mL due today (no dosing rig wired up, manual feed required)\n", today->doseMl);
  }
}

void tickCycle() {
  switch (cycle) {
    case Cycle::IDLE:
      break;

    case Cycle::MISTING:
      if (millis() - cycleStartedAt >= (unsigned long)MIST_DURATION_SECONDS * 1000UL) {
        actuators.stopWaterLine();
        float volumeMl = cfg.pumpFlowLpm * (MIST_DURATION_SECONDS / 60.0f) * 1000.0f;
        cloud.postMistEvent(MIST_DURATION_SECONDS, volumeMl, currentReading.humidity, currentReading.tempC);
        cycle = Cycle::IDLE;
        cloud.postStatus("idle");
        Serial.println("[cycle] misting complete");
      }
      break;
  }
}

const char *cycleLabel() {
  switch (cycle) {
    case Cycle::MISTING: return "misting";
    default: return "idle";
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[main] Plant Automation room controller starting");

  WifiSetup::checkForFactoryReset();

  cfg = LocalCache::load();
  if (cfg.valid) Serial.println("[main] loaded cached config from NVS");

  oled.begin();
  oled.showStatus("Starting...", "Wi-Fi setup");
  sensors.begin();
  actuators.begin();

  String backendUrl, deviceKey;
  WifiSetup::begin(backendUrl, deviceKey);
  cloud.begin(backendUrl, deviceKey);

  configTime(TZ_GMT_OFFSET_SEC, TZ_DST_OFFSET_SEC, NTP_SERVER);
  oled.showStatus("Connected", WiFi.localIP().toString());

  // Server-initiated sync: a fresh answer from the backend beats a stale
  // local guess, so this always tries live first and only falls back to
  // NVS after genuinely exhausting the retries — never the other way
  // around.
  bool synced = false;
  for (int attempt = 1; attempt <= BOOT_SYNC_MAX_ATTEMPTS && !synced; attempt++) {
    if (syncConfig(/*isBoot=*/true)) {
      synced = true;
      Serial.println("[main] synced fresh config + 7-day plan from server on boot");
    } else {
      Serial.printf("[main] boot sync attempt %d/%d failed\n", attempt, BOOT_SYNC_MAX_ATTEMPTS);
      if (attempt < BOOT_SYNC_MAX_ATTEMPTS) delay(BOOT_SYNC_RETRY_DELAY_MS);
    }
  }
  if (!synced) {
    Serial.println(cfg.valid
      ? "[main] server unreachable at boot — running on the cached config/plan from NVS"
      : "[main] server unreachable at boot and nothing cached — waiting for the next sync attempt");
  }

  actOnCurrentConfig();
}

void loop() {
  unsigned long now = millis();

  if (lastHousekeepingAt == 0 || now - lastHousekeepingAt >= POLL_INTERVAL_MS) {
    lastHousekeepingAt = now;
    if (!syncConfig(/*isBoot=*/false)) {
      Serial.println("[main] sync failed, running on last cached config/plan");
    }
    actOnCurrentConfig();
  }

  tickCycle();

  if (cfg.valid) {
    oled.showReadings(currentReading.humidity, currentReading.tempC, currentReading.raining, cycleLabel());
  }

  delay(150);
}
