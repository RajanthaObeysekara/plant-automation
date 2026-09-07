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
WaterLevel currentWaterLevel = { true, false, false }; // assume OK until first real read
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

// Epoch seconds of the last time the (open, chlorinated-mains-fed) tank was
// topped up. 0 means "no auto-fill has happened yet this install" — treated
// as already dechlorinated, since that water was put there by hand before
// the unit's first boot.
time_t tankFilledAtEpoch = 0;

bool tankReady() {
  time_t now = time(nullptr);
  if (now < 1600000000) return false; // clock not synced yet — don't assume it's safe
  if (tankFilledAtEpoch == 0) return true;
  time_t holdSeconds = (time_t)cfg.dechlorinateHours * 3600;
  return (now - tankFilledAtEpoch) >= holdSeconds;
}

// Mechanical limit switch is a hard, always-on cutoff — separate from (and a
// backstop for) the normal "full" sensor + autofill_enabled logic. Tracks
// whether we've already alerted so it doesn't spam an event every loop while
// the float stays tripped.
bool overflowAlerted = false;

void checkOverflow() {
  if (currentWaterLevel.overflowDetected) {
    actuators.closeWaterInlet();
    if (autoFilling) autoFilling = false;
    if (!overflowAlerted) {
      overflowAlerted = true;
      Serial.println("[safety] OVERFLOW LIMIT SWITCH TRIPPED — inlet forced closed");
      cloud.postOverflowEvent();
      cloud.postStatus("overflow");
    }
  } else {
    overflowAlerted = false;
  }
}

const char *cycleLabel(); // defined below — used by housekeeping() to report idle sub-states

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
  if (currentWaterLevel.overflowDetected) return; // checkOverflow() already forced the inlet shut

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

    // New chlorinated mains water just went in — restart the dechlorination
    // clock regardless of how the fill ended, even a partial/timed-out one.
    tankFilledAtEpoch = time(nullptr);
    LocalCache::saveTankFilledAt((unsigned long)tankFilledAtEpoch);

    if (timedOut) {
      Serial.println("[autofill] SAFETY CUTOFF — full sensor never triggered, check the float/inlet");
    } else {
      Serial.println("[autofill] tank full — inlet closed");
    }
    Serial.printf("[autofill] dechlorination clock reset — misting blocked for %d more hours\n",
                  cfg.dechlorinateHours);
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
    cloud.postTelemetry(currentReading.humidity, currentReading.tempC, currentReading.raining, currentWaterLevel);
  }

  for (const String &type : cloud.pollCommands()) {
    Serial.println("[main] command received: " + type);
    if (type == "mist_now") mistRequested = true;
    // pause / resume / skip_feed are applied server-side already and
    // arrive here as ordinary fields on the next fetchConfig().
  }

  if (cycle == Cycle::IDLE) {
    // Surfaces "filling" / "dechlorinating" / "overflow" to the dashboard too,
    // not just the local OLED — these were previously OLED-only via
    // cycleLabel() and never reached the cloud, so the app just showed a
    // silent "idle" while misting was actually blocked.
    cloud.postStatus(cycleLabel());

    time_t now = time(nullptr);
    struct tm nowTm;
    localtime_r(&now, &nowTm);

    bool cooledDown = millis() - lastMistAt > MIST_COOLDOWN_MS;
    // Never dry-run the pump, even on a forced request — and never spray
    // still-chlorinated tank water onto the orchids either, forced or not.
    bool tankOk = currentWaterLevel.lowDetected && tankReady();
    bool wants = tankOk && (mistRequested
      || (currentReading.valid && cooledDown
          && RuleEngine::shouldMist(nowTm, currentReading.humidity, currentReading.tempC, currentReading.raining, cfg)));

    if (mistRequested && !tankOk) {
      if (!currentWaterLevel.lowDetected) {
        Serial.println("[main] mist_now ignored — tank is below the low-water mark");
      } else {
        Serial.println("[main] mist_now ignored — tank water is still dechlorinating");
      }
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
        float volumeMl = cfg.pumpFlowLpm * (MIST_DURATION_SECONDS / 60.0f) * 1000.0f;
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
  if (currentWaterLevel.overflowDetected) return "overflow"; // takes priority over everything else
  switch (cycle) {
    case Cycle::MISTING: return "misting";
    case Cycle::WAIT_BEFORE_FEED:
    case Cycle::FEEDING: return "feeding";
    case Cycle::DOSING_FUNGICIDE: return "fungicide";
    default:
      if (autoFilling) return "filling";
      if (currentWaterLevel.lowDetected && !tankReady()) return "dechlorinating";
      return "idle";
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[main] Plant Automation unit starting");

  WifiSetup::checkForFactoryReset();

  cfg = LocalCache::load();
  if (cfg.valid) Serial.println("[main] loaded cached config from NVS");

  tankFilledAtEpoch = (time_t)LocalCache::loadTankFilledAt();
  if (tankFilledAtEpoch != 0) Serial.println("[main] restored last tank-fill time from NVS");

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
  checkOverflow(); // hard safety cutoff — runs before anything else touches the inlet valve

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
