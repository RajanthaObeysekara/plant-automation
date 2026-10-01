#include "CloudClient.h"
#include <ArduinoJson.h>
#include "Config.h"
#include "Secrets.h"

namespace {
  CloudClient *g_instance = nullptr;
  const unsigned long CONFIG_WAIT_MS = 6000UL;
  const unsigned long RECONNECT_BASE_MS = 3000UL;
  const unsigned long RECONNECT_MAX_MS = 60000UL;
  // A connection that dies before staying up this long doesn't count as a
  // real recovery — still back off harder next time. Only a connection
  // that outlives this resets the interval back to the base.
  const unsigned long STABLE_CONNECTION_MS = 10000UL;
}

void CloudClient::staticCallback(char *topic, uint8_t *payload, unsigned int length) {
  if (g_instance) g_instance->handleMessage(topic, payload, length);
}

void CloudClient::handleMessage(char *topic, uint8_t *payload, unsigned int length) {
  String topicStr(topic);
  String body;
  body.reserve(length);
  for (unsigned int i = 0; i < length; i++) body += (char)payload[i];

  if (topicStr.endsWith("/config")) {
    _configJson = body;
    _configReceived = true; // consumed by fetchConfig()'s wait loop
    _configDirty = true;    // consumed by pollPushedConfig() — independent flag, see header
  } else if (topicStr.endsWith("/commands")) {
    JsonDocument doc;
    if (deserializeJson(doc, body) == DeserializationError::Ok) {
      String type = doc["type"] | "";
      if (type.length()) _pendingCommands.push_back(type);
    }
  }
}

void CloudClient::begin(const String &deviceKey) {
  _deviceKey = deviceKey;
  g_instance = this;

  // Local-dev simplification, same shortcut the old HTTPS code used: a
  // real deployment should pin HiveMQ's actual CA instead of skipping
  // verification.
  _secureClient.setInsecure();
  _mqtt.setClient(_secureClient);
  _host = Secrets::mqttHost(); // PubSubClient keeps the pointer, so the String must outlive it
  _mqtt.setServer(_host.c_str(), Secrets::mqttPort());
  _mqtt.setBufferSize(4096); // must cover the retained /config payload — see platformio.ini's MQTT_MAX_PACKET_SIZE
  _mqtt.setCallback(staticCallback);
  ensureConnected();
}

bool CloudClient::ensureConnected() {
  if (_mqtt.connected()) return true;
  if (WiFi.status() != WL_CONNECTED) return false;

  unsigned long now = millis();
  if (now - _lastConnectAttempt < _reconnectIntervalMs) return false;
  _lastConnectAttempt = now;

  String clientId = "esp32-" + _deviceKey;
  if (_paused) return false;
  bool ok = _mqtt.connect(clientId.c_str(), Secrets::mqttUser().c_str(), Secrets::mqttPass().c_str());
  if (ok) {
    Serial.println("[mqtt] connected to broker");
    _connectedAt = now;
    _mqtt.subscribe(("plant/device/" + _deviceKey + "/config").c_str(), 1);
    _mqtt.subscribe(("plant/device/" + _deviceKey + "/commands").c_str(), 1);
  } else {
    Serial.printf("[mqtt] connect failed, state=%d — retrying in %lus\n", _mqtt.state(), _reconnectIntervalMs / 1000);
    _reconnectIntervalMs = min(_reconnectIntervalMs * 2, RECONNECT_MAX_MS);
  }
  return ok;
}

void CloudClient::loop() {
  // The broker has been observed closing this connection cleanly a couple
  // seconds after every connect — root cause not yet confirmed (ruled out:
  // heap exhaustion, payload size, WiFi modem-sleep). A connect() call
  // itself "succeeding" doesn't mean much here since the session dies
  // moments later, so backoff only resets once a connection has actually
  // stayed up — otherwise it keeps growing even though every connect()
  // reports success, which is what was turning this into a reconnect storm
  // that flooded the broker and this serial link.
  static bool wasConnected = false;
  bool isConnected = _mqtt.connected();
  if (wasConnected && !isConnected) {
    unsigned long uptime = millis() - _connectedAt;
    Serial.printf("[mqtt] connection lost after %lums, state=%d\n", uptime, _mqtt.state());
    _reconnectIntervalMs = (uptime >= STABLE_CONNECTION_MS)
      ? RECONNECT_BASE_MS
      : min(_reconnectIntervalMs * 2, RECONNECT_MAX_MS);
  }
  wasConnected = isConnected;

  if (!ensureConnected()) return;
  _mqtt.loop();
}

bool CloudClient::publish(const char *topic, const String &body) {
  if (!ensureConnected()) return false;
  bool ok = _mqtt.publish(topic, body.c_str());
  if (!ok) Serial.printf("[mqtt] publish to %s failed\n", topic);
  return ok;
}

bool CloudClient::parseConfigJson(const String &json, DeviceConfig &out) {
  JsonDocument doc;
  if (deserializeJson(doc, json) != DeserializationError::Ok) {
    Serial.println("[mqtt] config payload was not valid JSON");
    return false;
  }

  out.roomId = doc["roomId"] | out.roomId;
  out.roomName = doc["roomName"] | out.roomName;
  out.farmId = doc["farmId"] | out.farmId;
  out.farmName = doc["farmName"] | out.farmName;
  out.humidityBelow = doc["trigger"]["humidityBelow"] | out.humidityBelow;
  out.tempAbove = doc["trigger"]["tempAbove"] | out.tempAbove;
  out.windowStart = doc["schedule"]["windowStart"] | out.windowStart;
  out.windowEnd = doc["schedule"]["windowEnd"] | out.windowEnd;
  out.fungicideDoseMl = doc["fungicide"]["doseMl"] | out.fungicideDoseMl;
  out.fungicideLastSprayedDate = doc["fungicide"]["lastSprayedDate"] | out.fungicideLastSprayedDate;
  out.lastFedDate = doc["feed"]["lastFedDate"] | out.lastFedDate;
  out.paused = doc["paused"] | out.paused;
  out.skipFeedOnce = doc["skipFeedOnce"] | out.skipFeedOnce;
  out.pumpFlowLpm = doc["pumpFlowLpm"] | out.pumpFlowLpm;
  out.tankReady = doc["tank"]["ready"] | false;
  out.tankLow = doc["tank"]["low"] | out.tankLow;
  out.scheduleVersion = doc["scheduleVersion"] | out.scheduleVersion;

  out.planCount = 0;
  JsonArray plan = doc["plan"].as<JsonArray>();
  for (JsonVariant day : plan) {
    if (out.planCount >= PLAN_DAYS) break;
    PlanDay &pd = out.plan[out.planCount];
    pd.date = day["date"] | "";
    pd.isFeedDay = day["isFeedDay"] | false;
    pd.doseMl = day["doseMl"] | 0;
    pd.fungicideDue = day["fungicideDue"] | false;
    pd.fungicideDoseMl = day["fungicideDoseMl"] | 0;
    out.planCount++;
  }

  out.valid = true;
  return true;
}

bool CloudClient::fetchConfig(DeviceConfig &out, bool isBoot) {
  if (!ensureConnected()) return false;

  JsonDocument reqDoc;
  reqDoc["boot"] = isBoot;
  String reqBody;
  serializeJson(reqDoc, reqBody);
  _configReceived = false;
  if (!publish(("plant/device/" + _deviceKey + "/config_request").c_str(), reqBody)) return false;

  // The answer arrives asynchronously on the subscribed retained topic —
  // service the client while we wait so handleMessage() actually gets to
  // run, turning this back into the synchronous call syncConfig() expects.
  unsigned long start = millis();
  while (!_configReceived && millis() - start < CONFIG_WAIT_MS) {
    _mqtt.loop();
    delay(20);
  }
  if (!_configReceived) {
    Serial.println("[mqtt] config request timed out");
    return false;
  }
  // Same payload pollPushedConfig() would otherwise reapply moments later
  // — already applying it here via this call's return value.
  _configDirty = false;

  return parseConfigJson(_configJson, out);
}

bool CloudClient::pollPushedConfig(DeviceConfig &out) {
  if (!_configDirty) return false;
  _configDirty = false;
  return parseConfigJson(_configJson, out);
}

bool CloudClient::postTelemetry(float humidity, float tempC, bool raining, int scheduleVersion,
                                 bool sensor1Valid, float humidity1, float tempC1,
                                 bool sensor2Valid, float humidity2, float tempC2,
                                 bool tankSensorsValid, bool waterLow, bool waterHigh) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["humidity"] = humidity;
  doc["tempC"] = tempC;
  doc["raining"] = raining;
  doc["scheduleVersion"] = scheduleVersion;
  if (sensor1Valid) {
    doc["humiditySensor1"] = humidity1;
    doc["tempCSensor1"] = tempC1;
  }
  if (sensor2Valid) {
    doc["humiditySensor2"] = humidity2;
    doc["tempCSensor2"] = tempC2;
  }
  if (tankSensorsValid) {
    doc["waterLow"] = waterLow;
    doc["waterHigh"] = waterHigh;
  }
  String body;
  serializeJson(doc, body);
  return publish("plant/device/telemetry", body);
}

bool CloudClient::postMistEvent(int durationSeconds, float volumeMl, float humidity, float tempC) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["type"] = "mist";
  doc["durationSeconds"] = durationSeconds;
  doc["volumeMl"] = volumeMl;
  doc["meta"]["humidity"] = humidity;
  doc["meta"]["tempC"] = tempC;
  String body;
  serializeJson(doc, body);
  return publish("plant/device/events", body);
}

bool CloudClient::postMistSkipped(const String &reason) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["type"] = "mist_skipped";
  doc["meta"]["reason"] = reason;
  String body;
  serializeJson(doc, body);
  return publish("plant/device/events", body);
}

bool CloudClient::postFungicideReminder(const String &lastSprayedDate) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["type"] = "fungicide_reminder";
  doc["meta"]["lastSprayedDate"] = lastSprayedDate;
  String body;
  serializeJson(doc, body);
  return publish("plant/device/events", body);
}

bool CloudClient::postFeedReminder(const String &date, int doseMl) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["type"] = "feed_reminder";
  doc["meta"]["date"] = date;
  doc["meta"]["doseMl"] = doseMl;
  doc["meta"]["note"] = "no farm dosing rig wired up yet — manual feed required";
  String body;
  serializeJson(doc, body);
  return publish("plant/device/events", body);
}

bool CloudClient::postWater(JsonDocument &doc) {
  doc["deviceKey"] = _deviceKey;
  String body;
  serializeJson(doc, body);
  return publish("plant/device/water", body);
}

bool CloudClient::postStatus(const String &activity) {
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  doc["activity"] = activity;
  String body;
  serializeJson(doc, body);
  return publish("plant/device/status", body);
}

std::vector<String> CloudClient::pollCommands() {
  std::vector<String> out = _pendingCommands;
  _pendingCommands.clear();
  return out;
}

bool CloudClient::postLogs(const RemoteLogLine *lines, int count) {
  if (count <= 0) return true;
  JsonDocument doc;
  doc["deviceKey"] = _deviceKey;
  JsonArray arr = doc["logs"].to<JsonArray>();
  for (int i = 0; i < count; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["level"] = lines[i].level;
    o["message"] = lines[i].message;
  }
  String body;
  serializeJson(doc, body);
  return publish("plant/device/logs", body);
}
