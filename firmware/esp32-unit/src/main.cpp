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
#include "Secrets.h"
#include "Ota.h"
#include "RemoteLog.h"
#include "ShiftRegister.h"
#include "WeightSensor.h"
#include "TimeSync.h"

// No relay/pump/valve is physically wired to this unit yet — only 2x
// DHT22 + the status display. Flip this to 1 once a water line is
// actually wired to SR_OUT_WATER_PUMP/VALVE; nothing else needs to
// change, every mist-decision/actuation call below is already gated on it.
#define ACTUATION_ENABLED 0

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
unsigned long lastCommandPollAt = 0;
unsigned long lastConfigSyncAt = 0;
unsigned long lastMistAt = 0;
unsigned long lastSrTestAt = 0;
unsigned long lastWeightLogAt = 0;

// Load cell text for the OLED's identity row, which alternates with the
// farm name (see loop()) since the rest of the screen is already full.
String weightLabel() {
  if (!WeightSensor::present()) return "load: no hx711";
  if (WeightSensor::saturated()) return "load: chk wiring";
  if (WeightSensor::zeroing()) return "load: zeroing";
  if (!WeightSensor::calibrated()) return "load: not cal";
  return "load " + String(WeightSensor::kg(), 1) + " kg"; // 0.1kg — finer digits would just show noise
}

// USB serial commands for load cell calibration:
//   tare        — current load becomes zero (e.g. empty tank on the cell)
//   cal <grams> — a known weight is on the cell now, e.g. "cal 1000"
//   weight      — print the current raw and calibrated reading
//   scale <c/g> — set counts-per-gram directly, e.g. "scale 10.6"
//   hxreset     — power-cycle the HX711
// Provisioning / maintenance (tools/provision.py drives these):
//   secret set <key> <value>, secret show, secret clear, reboot
//   version, ota check (installs a newer release even over a dev build)
void handleSerialCommands() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') { if (line.length() < 200) line += c; continue; }
    line.trim();
    if (line == "tare") {
      WeightSensor::tare();
    } else if (line.startsWith("cal ")) {
      if (!WeightSensor::calibrate(line.substring(4).toFloat())) {
        Serial.println("[weight] calibration failed — tare first, then put a known weight on and send e.g. 'cal 1000'");
      }
    } else if (line.startsWith("scale ")) {
      WeightSensor::setScale(line.substring(6).toFloat());
    } else if (line == "hxreset") {
      WeightSensor::reset();
    } else if (line == "weight") {
      Serial.printf("[weight] raw=%ld, %s\n", WeightSensor::raw(), weightLabel().c_str());
    } else if (line.startsWith("secret set ")) {
      String rest = line.substring(11);
      int sp = rest.indexOf(' ');
      String key = sp < 0 ? rest : rest.substring(0, sp);
      String value = sp < 0 ? "" : rest.substring(sp + 1);
      Serial.println(Secrets::set(key, value) ? "[secret] ok " + key : "[secret] unknown key " + key);
    } else if (line == "secret show") {
      Secrets::printMasked();
    } else if (line == "secret clear") {
      Secrets::clearAll();
      Serial.println("[secret] cleared");
    } else if (line == "reboot") {
      Serial.println("[main] rebooting");
      delay(100);
      ESP.restart();
    } else if (line == "wifi") {
      // RSSI: > -60 good, -60..-70 ok, < -75 weak (check the -32U's external antenna)
      Serial.printf("[wifi] %s, SSID=%s, RSSI=%ddBm, IP=%s\n", WiFi.status() == WL_CONNECTED ? "connected" : "DISCONNECTED",
                    WiFi.SSID().c_str(), WiFi.RSSI(), WiFi.localIP().toString().c_str());
    } else if (line == "version") {
      Serial.printf("[main] firmware v%s\n", Ota::version());
    } else if (line == "ota check") {
      Ota::requestCheck(true);
      Serial.println("[ota] check requested");
    } else if (line.length()) {
      Serial.println("[serial] unknown command: " + line + " (try: tare, cal <grams>, scale <counts/g>, weight, hxreset, secret show, wifi, version, ota check, reboot)");
    }
    line = "";
  }
}
bool mistRequested = false;
bool hasTank = false;   // Secrets::hasTank(), read once in setup()
bool hasScale = false;  // Secrets::hasScale()

// Holding BOOT for 3s at power-up wipes the stored WiFi/MQTT credentials
// and device key, so the board can be re-provisioned for another site.
void checkForFactoryReset() {
  pinMode(PIN_WIFI_RESET_BUTTON, INPUT_PULLUP);
  if (digitalRead(PIN_WIFI_RESET_BUTTON) != LOW) return;
  Serial.println("[main] BOOT held - keep holding 3s to erase stored credentials...");
  unsigned long start = millis();
  while (digitalRead(PIN_WIFI_RESET_BUTTON) == LOW) {
    if (millis() - start > 3000) {
      Secrets::clearAll();
      Serial.println("[main] credentials erased - restarting");
      ESP.restart();
    }
    delay(50);
  }
}

// Bench-test tank sensor states (see Config.h) — two MD0372 float switches,
// low/high marks (the MD0374 optical sensor was dropped from this setup;
// only 2 physical sensors are actually wired). -1 until each has read at
// least once. Declared up here since actOnCurrentConfig() (below) needs
// them; the check*() functions that actually update these live further
// down, near setup()/loop().
int lastFloatSwitchRaw = -1;   // low mark
int lastFloatSwitch2Raw = -1;  // high mark
String lastFeedReminderOn = "";
String lastFungicideReminderOn = "";
String lastSkippedReminderOn = "";

// Single source of truth for what "wet" means at each of the two tank
// sensors — telemetry and the OLED label both call this instead of each
// re-deriving it themselves, which is exactly how they drifted out of sync
// before (a HIGH/LOW polarity fixed in one copy but not the others).
// Returns false (leaving lowWet/highWet untouched) until both have
// reported at least once.
bool getTankWetness(bool &lowWet, bool &highWet) {
  if (lastFloatSwitchRaw == -1 || lastFloatSwitch2Raw == -1) return false;
  lowWet = (lastFloatSwitchRaw == LOW);   // MD0372 reed switch: closed (LOW) = water reached it
  highWet = (lastFloatSwitch2Raw == LOW);
  return true;
}

// Short-lived feedback so a dashboard button press visibly shows up on the
// device's own screen, not just in the background — cleared automatically
// after CONTROL_NOTE_HOLD_MS.
String controlNote = "";
unsigned long controlNoteAt = 0;
#define CONTROL_NOTE_HOLD_MS 5000UL
void setControlNote(const String &note) {
  controlNote = note;
  controlNoteAt = millis();
}

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
  Serial.printf("[cycle] misting started%s\n", forced ? " [manual override]" : "");
  RemoteLog::add("info", forced ? "misting started [manual override]" : "misting started");
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

// Evaluates whatever mist state is currently pending (a manual mist_now,
// and — once real hardware exists — the rule engine's own trigger) and
// reacts. Called from two places: the fast command-poll loop (so a manual
// dashboard click reacts within COMMAND_POLL_MS) and after every full sync
// (so the rule-engine's automatic trigger, which needs fresh sensor data,
// still gets evaluated).
void reactToMistState() {
  if (!cfg.valid || cycle != Cycle::IDLE) return;

  time_t now = time(nullptr);
  struct tm nowTm;
  localtime_r(&now, &nowTm);
  String todayStr = todayKey(nowTm);

#if ACTUATION_ENABLED
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
    // Both must fit the 96px/16-char display — "MIST: TANK NOT READY" (21
    // chars) does not, so this drops the "MIST:" prefix rather than the
    // more useful half of the message.
    setControlNote(cfg.tankLow ? "TANK LOW" : "TANK NOT READY");
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
#else
  // Monitoring only — no relay/pump/valve wired to this unit yet. Never
  // decide to mist, never actuate; a manual "Mist now" click from the
  // dashboard still gets an honest answer instead of silently doing
  // nothing.
  if (mistRequested) {
    Serial.println("[main] mist_now ignored — no water line wired to this unit yet");
    RemoteLog::add("warn", "mist_now ignored — no water line wired to this unit yet");
    cloud.postMistSkipped("no_hardware");
    setControlNote("MIST: NO PUMP"); // "MIST: NO HARDWARE" (17 chars) overflows the 16-char display width
    mistRequested = false;
  }
#endif
}

// Polled on its own fast COMMAND_POLL_MS loop (see loop()), separately from
// the slower full sync — a "Mist now" click needs to visibly react in a
// few seconds, not wait for the next config/telemetry cycle.
void pollCommandsFast() {
  for (const String &type : cloud.pollCommands()) {
    Serial.println("[main] command received: " + type);
    RemoteLog::add("info", "command received: " + type);
    if (type == "mist_now") {
      mistRequested = true;
      setControlNote("MIST REQUESTED");
    }
    // pause / resume / skip_feed are applied server-side already and
    // arrive here as ordinary fields on the next syncConfig().
  }
  if (mistRequested) reactToMistState();
}

// The MQTT broker's message quota is limited, and this device previously
// published telemetry unconditionally every POLL_INTERVAL_MS regardless of
// whether anything had actually changed — wasteful. Now: send the instant
// something differs from the last thing actually sent, otherwise stay
// quiet, except a HEARTBEAT_INTERVAL_MS "still here, nothing new" sync so
// the backend can still tell this device is online even through a long
// stretch of no real changes. `force` skips the comparison (used for the
// very first send, where there's nothing to compare against yet).
#define HEARTBEAT_INTERVAL_MS (2UL * 60UL * 1000UL)
unsigned long lastTelemetrySentAt = 0;
bool lastSentValid = false;
float lastSentHumidity = NAN, lastSentTempC = NAN;
bool lastSentRaining = false;
int lastSentScheduleVersion = -1;
bool lastSentTankValid = false;
bool lastSentLowWet = false, lastSentHighWet = false;

void maybeSendTelemetry(bool force) {
  bool lowWet, highWet;
  bool tankValid = getTankWetness(lowWet, highWet);
  if (!currentReading.valid && !tankValid) return; // nothing worth sending at all yet

  bool changed = force
    || currentReading.valid != lastSentValid
    || currentReading.humidity != lastSentHumidity
    || currentReading.tempC != lastSentTempC
    || currentReading.raining != lastSentRaining
    || cfg.scheduleVersion != lastSentScheduleVersion
    || tankValid != lastSentTankValid
    || (tankValid && (lowWet != lastSentLowWet || highWet != lastSentHighWet));

  unsigned long now = millis();
  bool heartbeatDue = (lastTelemetrySentAt == 0) || (now - lastTelemetrySentAt >= HEARTBEAT_INTERVAL_MS);
  if (!changed && !heartbeatDue) return;

  // frontend/src/WaterTank.jsx's contract: waterLow = low mark reached
  // ("mid" level), waterHigh = high mark reached ("full" level) — lowWet/
  // highWet map onto it directly.
  cloud.postTelemetry(currentReading.humidity, currentReading.tempC, currentReading.raining, cfg.scheduleVersion,
                       currentReading.sensor1Valid, currentReading.humidity1, currentReading.tempC1,
                       currentReading.sensor2Valid, currentReading.humidity2, currentReading.tempC2,
                       tankValid, lowWet, highWet);

  lastTelemetrySentAt = now;
  lastSentValid = currentReading.valid;
  lastSentHumidity = currentReading.humidity;
  lastSentTempC = currentReading.tempC;
  lastSentRaining = currentReading.raining;
  lastSentScheduleVersion = cfg.scheduleVersion;
  lastSentTankValid = tankValid;
  if (tankValid) { lastSentLowWet = lowWet; lastSentHighWet = highWet; }
}

// Telemetry and the feed/fungicide reminder check — runs against whatever
// `cfg` currently holds, fresh or cached. Called once right after the
// boot-sync attempt in setup(), then every POLL_INTERVAL_MS from loop().
void actOnCurrentConfig() {
  // Telemetry doesn't need a synced config to be worth sending — this
  // device's own reading + device key is meaningful on its own.
  currentReading = sensors.read();
  maybeSendTelemetry(lastTelemetrySentAt == 0);

  if (!cfg.valid) {
    Serial.println("[main] no config synced yet and nothing cached — mist/reminder logic skipped");
    return;
  }

  reactToMistState(); // covers the rule-engine's own trigger, once real hardware exists

  if (cycle != Cycle::IDLE) return;

  time_t now = time(nullptr);
  struct tm nowTm;
  localtime_r(&now, &nowTm);
  String todayStr = todayKey(nowTm);
  const PlanDay *today = findPlanDay(todayStr);

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

// Checked immediately from checkFloatSwitch()/checkFloatSwitch2() the
// instant either changes, not just on the slower POLL_INTERVAL_MS cycle
// actOnCurrentConfig() runs on — without this, the OLED (which updates
// every loop iteration) and the dashboard (which only heard about it on
// the next full sync) could disagree for up to POLL_INTERVAL_MS or longer.
// maybeSendTelemetry() still only actually publishes if the new reading
// differs from what was last sent.
void postTankTelemetryNow() {
  maybeSendTelemetry(false);
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
        RemoteLog::add("info", "misting complete");
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

// LOW mark — MD0372 float switch, passive reed switch read via internal
// pull-up: HIGH = contact open (dry), LOW = contact closed (wet).
void checkFloatSwitch() {
  int raw = digitalRead(PIN_WATER_LEVEL_FLOAT);
  if (raw == lastFloatSwitchRaw) return;
  lastFloatSwitchRaw = raw;
  String msg = "low tank sensor -> " + String(raw == HIGH ? "OPEN (dry)" : "CLOSED (wet)");
  Serial.println("[sensor] " + msg);
  RemoteLog::add("info", msg);
  postTankTelemetryNow();
}

// HIGH mark — second MD0372 float switch, same kind.
void checkFloatSwitch2() {
  int raw = digitalRead(PIN_WATER_LEVEL_FLOAT_2);
  if (raw == lastFloatSwitch2Raw) return;
  lastFloatSwitch2Raw = raw;
  String msg = "high tank sensor -> " + String(raw == HIGH ? "OPEN (dry)" : "CLOSED (wet)");
  Serial.println("[sensor] " + msg);
  RemoteLog::add("info", msg);
  postTankTelemetryNow();
}

// Tank state derived from getTankWetness() — the same shared logic
// actOnCurrentConfig()/postTankTelemetryNow() send to the backend, so this
// and the dashboard can't drift apart the way they did before this was
// centralized. "" until both sensors have reported at least once.
String tankStateLabel() {
  bool lowWet, highWet;
  if (!getTankWetness(lowWet, highWet)) return "";
  // A monotonic tank only ever wets the low mark before the high one —
  // high wet without low wet means a sensor fault or bad wiring, not a
  // real water level.
  if (highWet && !lowWet) return "FAULT";
  if (!lowWet) return "EMPTY";
  if (highWet) return "FULL";
  return "OK";
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n[main] Plant Automation room controller starting");
  // RemoteLog::add() only touches its own buffer, not the network — safe to
  // call this early even though RemoteLog::begin() (below, once `cloud` is
  // configured) hasn't run yet. Everything queued here just uploads on the
  // first flush after connectivity exists, so a bad boot is never silent.
  RemoteLog::add("info", "boot: Plant Automation room controller starting");

  Secrets::begin();
  checkForFactoryReset();
  String otaNote = Ota::begin();

  cfg = LocalCache::load();
  if (cfg.valid) {
    Serial.println("[main] loaded cached config from NVS");
    RemoteLog::add("info", "loaded cached config from NVS");
  }

  oled.begin();
  oled.showBootSplash(Ota::version(), otaNote); // shown once, here, and never again — the live
                          // readout (update(), called every loop()) takes
                          // over for the rest of the device's uptime.
  delay(1500);
  sensors.begin();
  ShiftRegister::begin(); // before actuators — relays are shift register outputs
  hasScale = Secrets::hasScale();
  if (hasScale) WeightSensor::begin(); // no HX711: its DT pin floats "ready" and would be read nonstop
  actuators.begin();
  hasTank = Secrets::hasTank();
  if (hasTank) {
    pinMode(PIN_WATER_LEVEL_FLOAT, INPUT_PULLUP); // passive reed switch to GND — internal pull-up is all it needs
    pinMode(PIN_WATER_LEVEL_FLOAT_2, INPUT_PULLUP);
  }

  // No WiFi/MQTT credentials stored yet (fresh board, or after a factory
  // reset): nothing below can work, so wait here for tools/provision.py
  // to send them over USB, then it reboots us.
  if (!Secrets::complete()) {
    Serial.println("[main] NOT PROVISIONED - waiting for 'secret set ...' over USB (tools/provision.py)");
    oled.showNotProvisioned();
    while (true) {
      handleSerialCommands();
      delay(20);
    }
  }

  String deviceKey;
  WiFi.mode(WIFI_STA);
  // ESP32 WiFi's default modem-sleep power saving periodically suspends the
  // radio between beacon intervals — fine for short HTTP requests, but it
  // silently breaks a long-lived TCP/TLS session like MQTT's: the socket
  // looks connected but stops actually passing traffic a couple seconds in,
  // which PubSubClient then reports as MQTT_CONNECTION_LOST. This unit is
  // mains-powered (no battery to save), so there's no reason to trade
  // connection stability for power here.
  WiFi.setSleep(false);

  String ssid = Secrets::wifiSsid();
  oled.showConnecting(ssid);
  WiFi.begin(ssid.c_str(), Secrets::wifiPass().c_str());
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 20000) {
    handleSerialCommands(); // still reachable over USB (e.g. to fix a wrong WiFi password)
    delay(250);
  }
  deviceKey = Secrets::deviceKey();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[wifi] connected, IP=%s, RSSI=%ddBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    RemoteLog::add("info", "wifi connected, IP=" + WiFi.localIP().toString() + ", RSSI=" + String(WiFi.RSSI()) + "dBm");
  } else {
    // Restarting is simpler than looping forever in setup() and gives the
    // radio/AP a clean retry each time.
    Serial.println("[wifi] connect failed after 20s — restarting to retry");
    RemoteLog::add("error", "wifi connect failed after 20s — restarting to retry");
    ESP.restart();
  }

  cloud.begin(deviceKey);
  RemoteLog::begin(&cloud); // buffered lines above start flushing as soon as loop() runs
  RemoteLog::add("info", String("firmware v") + Ota::version());
  if (WiFi.status() == WL_CONNECTED) {
    TimeSync::begin();
  }

  // Server-initiated sync: a fresh answer from the backend beats a stale
  // local guess, so this always tries live first and only falls back to
  // NVS after genuinely exhausting the retries — never the other way
  // around.
  bool synced = false;
  for (int attempt = 1; attempt <= BOOT_SYNC_MAX_ATTEMPTS && !synced; attempt++) {
    if (syncConfig(/*isBoot=*/true)) {
      synced = true;
      Serial.println("[main] synced fresh config + 7-day plan from server on boot");
      RemoteLog::add("info", "synced fresh config + 7-day plan from server on boot");
    } else {
      Serial.printf("[main] boot sync attempt %d/%d failed\n", attempt, BOOT_SYNC_MAX_ATTEMPTS);
      RemoteLog::add("warn", "boot sync attempt " + String(attempt) + "/" + String(BOOT_SYNC_MAX_ATTEMPTS) + " failed");
      if (attempt < BOOT_SYNC_MAX_ATTEMPTS) delay(BOOT_SYNC_RETRY_DELAY_MS);
    }
  }
  if (!synced) {
    Serial.println(cfg.valid
      ? "[main] server unreachable at boot — running on the cached config/plan from NVS"
      : "[main] server unreachable at boot and nothing cached — waiting for the next sync attempt");
    RemoteLog::add("error", cfg.valid
      ? "server unreachable at boot — running on cached config/plan from NVS"
      : "server unreachable at boot and nothing cached — waiting for the next sync attempt");
  }

  actOnCurrentConfig();
}

void loop() {
  unsigned long now = millis();
  if (hasScale) WeightSensor::loop();
  TimeSync::loop();
  handleSerialCommands();
  cloud.loop(); // services the MQTT client — keepalive, incoming config/commands, reconnects
  if (hasTank) {
    checkFloatSwitch();
    checkFloatSwitch2();
  }
  Ota::loop(WiFi.status() == WL_CONNECTED, cycle == Cycle::IDLE && !mistRequested, oled, cloud,
            [] { actuators.allOff(); });

  // Zero MQTT cost — applies a backend-pushed config (Pause/Resume/
  // schedule change) the instant it arrives, without this device spending
  // a message of its own to ask for it. Covers the normal case;
  // CONFIG_SYNC_FALLBACK_MS below is just the safety net for a push that
  // got missed (e.g. this device was mid-reconnect when it went out).
  if (cloud.pollPushedConfig(cfg)) {
    LocalCache::save(cfg);
    Serial.println("[main] config updated via push");
    RemoteLog::add("info", "config updated via push");
    reactToMistState();
  }

  if (lastCommandPollAt == 0 || now - lastCommandPollAt >= COMMAND_POLL_MS) {
    lastCommandPollAt = now;
    pollCommandsFast();
  }

  if (lastHousekeepingAt == 0 || now - lastHousekeepingAt >= POLL_INTERVAL_MS) {
    lastHousekeepingAt = now;
    actOnCurrentConfig(); // local sensor read + change-gated telemetry send — no network round trip for config here
  }

  if (lastConfigSyncAt == 0 || now - lastConfigSyncAt >= CONFIG_SYNC_FALLBACK_MS) {
    lastConfigSyncAt = now;
    if (!syncConfig(/*isBoot=*/false)) {
      Serial.println("[main] sync failed, running on last cached config/plan");
      RemoteLog::add("warn", "sync failed, running on last cached config/plan");
    }
  }

  tickCycle();
  RemoteLog::loop();

#if SR_TEST_ENABLED
  // Step 0..23 energizes output n+1, 24..47 de-energizes it again — in
  // relay terms (RELAY_ACTIVE_LOW), so it matches the OLED's output dots.
  static int srTestStep = 0;
  if (lastSrTestAt == 0 || now - lastSrTestAt >= SR_TEST_INTERVAL_MS) {
    lastSrTestAt = now;
    int output = srTestStep % SR_OUTPUT_COUNT;
    bool energize = srTestStep < SR_OUTPUT_COUNT;
    ShiftRegister::write(output, RELAY_ACTIVE_LOW ? !energize : energize);
    srTestStep = (srTestStep + 1) % (SR_OUTPUT_COUNT * 2);
  }
#endif

  // Runs every loop iteration regardless of cfg.valid — the status bar
  // (WiFi/clock/sensor dots) and live readout are meaningful before the
  // first successful config sync too, not just after.
  String note = controlNote;
  if (note.length() && now - controlNoteAt > CONTROL_NOTE_HOLD_MS) note = ""; // expired — fall back to the normal status line
  String identity = "";
  if (cfg.valid && cfg.farmName.length()) {
    identity = "farm " + String(cfg.farmId) + " " + cfg.farmName;
    identity.toLowerCase();
  }
  // The load cell reading takes the identity row whenever an HX711 is
  // present — the farm name is start-up information, not a live value.
  if (hasScale && (!identity.length() || WeightSensor::present())) identity = weightLabel();

  if (hasScale && now - lastWeightLogAt >= 10000UL) {
    lastWeightLogAt = now;
    Serial.printf("[weight] raw=%ld, %s\n", WeightSensor::raw(), weightLabel().c_str());
  }
  oled.update(currentReading, cycleLabel(), cfg.paused, note, identity, tankStateLabel(), ShiftRegister::activeMask());

  delay(150);
}
