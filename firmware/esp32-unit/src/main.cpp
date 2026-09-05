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

// The mist/feed/fungicide sequence is a small state machine rather than a
// chain of blocking delay()s — the real pre-water wait is a full 15
// minutes, and the unit needs to keep syncing and reporting telemetry
// through that, not go dark. Everything here runs on top of a single
// loop(); no RTOS tasks.
enum class Cycle { IDLE, MISTING, WAIT_BEFORE_FEED, FEEDING, DOSING_FUNGICIDE };
Cycle cycle = Cycle::IDLE;
unsigned long cycleStartedAt = 0;
Reading currentReading;
WaterLevel currentWaterLevel = { true, false }; // assume OK until first real read
bool cycleWasForced = false;

unsigned long lastHousekeepingAt = 0;
unsigned long lastMistAt = 0;
bool mistRequested = false;
String lastFedOn = "";
String lastFungicideReminderOn = "";
String lastFungicideDosedOn = "";

// Auto-fill runs independently of the mist/feed/fungicide state machine —
// it shares no actuators with any of those lines, so there's no reason to
// serialize it with them.
bool autoFilling = false;
unsigned long autoFillStartedAt = 0;

String todayKey(const struct tm &t) {
  char buf[11];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02d", t.tm_year + 1900, t.tm_mon + 1, t.tm_mday);
  return String(buf);
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

void startFungicideDose() {
  cycle = Cycle::DOSING_FUNGICIDE;
  cycleStartedAt = millis();
  actuators.startFungicideLine();
  cloud.postStatus("fungicide");
  oled.showStatus("Fungicide dose", String(cfg.fungicideDoseMl) + " mL, own nozzle");
  Serial.println("[cycle] automated fungicide dose started (dedicated line)");
}

void tickAutofill() {
  if (!cfg.autofillEnabled) {
    if (autoFilling) { // config was turned off mid-fill — stop safely
      actuators.closeWaterInlet();
      autoFilling = false;
      cloud.postAutofillEvent((millis() - autoFillStartedAt) / 1000, false);
    }
    return;
  }

  if (!autoFilling) {
    if (!currentWaterLevel.lowDetected) { // level has dropped below the low mark
      autoFilling = true;
      autoFillStartedAt = millis();
      actuators.openWaterInlet();
      cloud.postStatus("filling");
      Serial.println("[autofill] tank below low mark — opening inlet valve");
    }
    return;
  }

  bool timedOut = millis() - autoFillStartedAt > AUTOFILL_MAX_SECONDS * 1000UL;
  if (currentWaterLevel.fullDetected || timedOut) {
    actuators.closeWaterInlet();
    autoFilling = false;
    int durationSeconds = (millis() - autoFillStartedAt) / 1000;
    cloud.postAutofillEvent(durationSeconds, !timedOut);
    if (timedOut) {
      Serial.println("[autofill] SAFETY CUTOFF — full sensor never triggered, check the float/inlet");
    } else {
      Serial.println("[autofill] tank full — inlet closed");
    }
  }
}

void housekeeping() {
  DeviceConfig fresh = cfg;
  if (cloud.fetchConfig(fresh)) {
    cfg = fresh;
    LocalCache::save(cfg);
  } else {
    Serial.println("[main] sync failed, running on last cached config");
  }
  if (!cfg.valid) {
    Serial.println("[main] no config synced yet — nothing to act on");
    return;
  }

  currentReading = sensors.read();
  if (currentReading.valid) {
    cloud.postTelemetry(currentReading.humidity, currentReading.tempC, currentReading.raining);
  }

  for (const String &type : cloud.pollCommands()) {
    Serial.println("[main] command received: " + type);
    if (type == "mist_now") mistRequested = true;
    // pause / resume / skip_feed are applied server-side already and
    // arrive here as ordinary fields on the next fetchConfig().
  }

  if (cycle == Cycle::IDLE) {
    time_t now = time(nullptr);
    struct tm nowTm;
    localtime_r(&now, &nowTm);

    bool cooledDown = millis() - lastMistAt > MIST_COOLDOWN_MS;
    bool tankOk = currentWaterLevel.lowDetected; // never dry-run the pump, even on a forced request
    bool wants = tankOk && (mistRequested
      || (currentReading.valid && cooledDown
          && RuleEngine::shouldMist(nowTm, currentReading.humidity, currentReading.tempC, currentReading.raining, cfg)));

    if (mistRequested && !tankOk) {
      Serial.println("[main] mist_now ignored — tank is below the low-water mark");
    }

    if (wants) {
      bool forced = mistRequested;
      mistRequested = false;
      startMist(forced);
    } else if (!tankOk) {
      mistRequested = false; // don't leave a stale request queued forever while dry
    }

    if (RuleEngine::fungicideDue(nowTm, cfg) && lastFungicideReminderOn != todayKey(nowTm)) {
      lastFungicideReminderOn = todayKey(nowTm);
      if (!cfg.fungicideAutomated) {
        cloud.postFungicideReminder(cfg.fungicideLastSprayedDate);
        Serial.println("[main] fungicide reminder raised (manual spray required)");
      } else if (lastFungicideDosedOn != todayKey(nowTm)) {
        startFungicideDose();
      }
    }
  }
}

void tickCycle() {
  time_t now = time(nullptr);
  struct tm nowTm;
  localtime_r(&now, &nowTm);

  switch (cycle) {
    case Cycle::IDLE:
      break;

    case Cycle::MISTING:
      if (millis() - cycleStartedAt >= (unsigned long)MIST_DURATION_SECONDS * 1000UL) {
        actuators.stopWaterLine();
        float volumeMl = PUMP_FLOW_LPM * (MIST_DURATION_SECONDS / 60.0f) * 1000.0f;
        cloud.postMistEvent(MIST_DURATION_SECONDS, volumeMl, cycleWasForced, currentReading.humidity, currentReading.tempC);

        RuleEngine::FeedForecast feed = RuleEngine::feedPhase(nowTm, cfg);
        String today = todayKey(nowTm);
        if (!cfg.skipFeedOnce && feed.isFeedDay && lastFedOn != today) {
          Serial.printf("[cycle] feed day (week %d/%d) — waiting %d min before dosing\n",
                        feed.weekNumber, cfg.cycleWeeks, cfg.preWaterWaitMinutes);
          cycle = Cycle::WAIT_BEFORE_FEED;
          cycleStartedAt = millis();
          cloud.postStatus("feeding");
          oled.showStatus("Feed day", "waiting to dose");
        } else {
          cycle = Cycle::IDLE;
          cloud.postStatus("idle");
        }
      }
      break;

    case Cycle::WAIT_BEFORE_FEED:
      if (millis() - cycleStartedAt >= (unsigned long)cfg.preWaterWaitMinutes * 60000UL) {
        actuators.startFeedLine();
        cycle = Cycle::FEEDING;
        cycleStartedAt = millis();
        oled.showStatus("Feeding...", String(cfg.doseMl) + " mL dose");
      }
      break;

    case Cycle::FEEDING:
      if (millis() - cycleStartedAt >= (unsigned long)FEED_RUN_SECONDS * 1000UL) {
        actuators.stopFeedLine();
        cloud.postFeedEvent(FEED_RUN_SECONDS, cfg.doseMl);
        lastFedOn = todayKey(nowTm);
        cycle = Cycle::IDLE;
        cloud.postStatus("idle");
        Serial.println("[cycle] feed complete");
      }
      break;

    case Cycle::DOSING_FUNGICIDE:
      if (millis() - cycleStartedAt >= (unsigned long)FUNGICIDE_RUN_SECONDS * 1000UL) {
        actuators.stopFungicideLine();
        cloud.postFungicideSprayedEvent(FUNGICIDE_RUN_SECONDS, cfg.fungicideDoseMl, true);
        lastFungicideDosedOn = todayKey(nowTm);
        cycle = Cycle::IDLE;
        cloud.postStatus("idle");
        Serial.println("[cycle] automated fungicide dose complete");
      }
      break;
  }
}

const char *cycleLabel() {
  switch (cycle) {
    case Cycle::MISTING: return "misting";
    case Cycle::WAIT_BEFORE_FEED:
    case Cycle::FEEDING: return "feeding";
    case Cycle::DOSING_FUNGICIDE: return "fungicide";
    default: return autoFilling ? "filling" : "idle";
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[main] Plant Automation unit starting");

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

  housekeeping(); // get a real config before the first loop, if possible
}

void loop() {
  unsigned long now = millis();

  currentWaterLevel = sensors.readWaterLevel(); // cheap digital reads — every loop, not gated on POLL_INTERVAL_MS

  if (lastHousekeepingAt == 0 || now - lastHousekeepingAt >= POLL_INTERVAL_MS) {
    lastHousekeepingAt = now;
    housekeeping();
  }

  tickCycle();
  tickAutofill();

  if (cfg.valid) {
    oled.showReadings(currentReading.humidity, currentReading.tempC, currentReading.raining, cycleLabel());
  }

  delay(150);
}
