#include "CloudClient.h"
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

void CloudClient::begin(const String &backendUrl, const String &deviceKey) {
  _backendUrl = backendUrl;
  while (_backendUrl.endsWith("/")) _backendUrl.remove(_backendUrl.length() - 1);
  _deviceKey = deviceKey;
}

bool CloudClient::request(const char *method, const String &path, const String &body, String &responseOut, int &statusOut) {
  if (_backendUrl.length() == 0 || _deviceKey.length() == 0) {
    Serial.println("[cloud] not configured (missing backend URL or device key)");
    return false;
  }

  String url = _backendUrl + path;
  HTTPClient http;
  WiFiClientSecure secureClient;
  bool ok;

  if (url.startsWith("https://")) {
    // Local-dev simplification: real deployments should pin Railway's CA
    // instead of skipping verification.
    secureClient.setInsecure();
    ok = http.begin(secureClient, url);
  } else {
    ok = http.begin(url);
  }
  if (!ok) {
    Serial.println("[cloud] http.begin() failed");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", "Bearer " + _deviceKey);
  http.setTimeout(8000);

  int code;
  if (strcmp(method, "GET") == 0) {
    code = http.GET();
  } else {
    code = http.POST(body);
  }

  statusOut = code;
  responseOut = code > 0 ? http.getString() : "";
  http.end();

  if (code <= 0) {
    Serial.printf("[cloud] %s %s failed: %s\n", method, path.c_str(), HTTPClient::errorToString(code).c_str());
    return false;
  }
  if (code >= 400) {
    Serial.printf("[cloud] %s %s -> HTTP %d: %s\n", method, path.c_str(), code, responseOut.c_str());
    return false;
  }
  return true;
}

bool CloudClient::fetchConfig(DeviceConfig &out) {
  String body, response;
  int status;
  if (!request("GET", "/api/device/config", body, response, status)) return false;

  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok) {
    Serial.println("[cloud] config response was not valid JSON");
    return false;
  }

  out.humidityBelow = doc["trigger"]["humidityBelow"] | out.humidityBelow;
  out.tempAbove = doc["trigger"]["tempAbove"] | out.tempAbove;
  out.windowStart = doc["schedule"]["windowStart"] | out.windowStart;
  out.windowEnd = doc["schedule"]["windowEnd"] | out.windowEnd;
  out.cycleWeeks = doc["feed"]["cycleWeeks"] | out.cycleWeeks;
  out.feedStartDate = doc["feed"]["feedStartDate"] | out.feedStartDate;
  out.preWaterWaitMinutes = doc["feed"]["preWaterWaitMinutes"] | out.preWaterWaitMinutes;
  out.doseMl = doc["feed"]["doseMl"] | out.doseMl;
  out.fungicideIntervalDays = doc["fungicide"]["intervalDays"] | out.fungicideIntervalDays;
  out.fungicideLastSprayedDate = doc["fungicide"]["lastSprayedDate"] | out.fungicideLastSprayedDate;
  out.fungicideDoseMl = doc["fungicide"]["doseMl"] | out.fungicideDoseMl;
  out.fungicideAutomated = doc["fungicide"]["automated"] | out.fungicideAutomated;
  out.autofillEnabled = doc["autofillEnabled"] | out.autofillEnabled;
  out.paused = doc["paused"] | out.paused;
  out.skipFeedOnce = doc["skipFeedOnce"] | out.skipFeedOnce;
  out.valid = true;
  return true;
}

bool CloudClient::postTelemetry(float humidity, float tempC, bool raining) {
  JsonDocument doc;
  doc["humidity"] = humidity;
  doc["tempC"] = tempC;
  doc["raining"] = raining;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/telemetry", body, response, status);
}

bool CloudClient::postMistEvent(int durationSeconds, float volumeMl, bool forced, float humidity, float tempC) {
  JsonDocument doc;
  doc["type"] = "mist";
  doc["durationSeconds"] = durationSeconds;
  doc["volumeMl"] = volumeMl;
  doc["meta"]["forced"] = forced;
  doc["meta"]["humidity"] = humidity;
  doc["meta"]["tempC"] = tempC;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/events", body, response, status);
}

bool CloudClient::postFeedEvent(int durationSeconds, float volumeMl) {
  JsonDocument doc;
  doc["type"] = "feed";
  doc["durationSeconds"] = durationSeconds;
  doc["volumeMl"] = volumeMl;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/events", body, response, status);
}

bool CloudClient::postFungicideReminder(const String &lastSprayedDate) {
  JsonDocument doc;
  doc["type"] = "fungicide_reminder";
  doc["meta"]["lastSprayedDate"] = lastSprayedDate;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/events", body, response, status);
}

bool CloudClient::postFungicideSprayedEvent(int durationSeconds, float volumeMl, bool automated) {
  JsonDocument doc;
  doc["type"] = "fungicide_sprayed";
  doc["durationSeconds"] = durationSeconds;
  doc["volumeMl"] = volumeMl;
  doc["meta"]["automated"] = automated;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/events", body, response, status);
}

bool CloudClient::postAutofillEvent(int durationSeconds, bool completedNormally) {
  JsonDocument doc;
  doc["type"] = "autofill";
  doc["durationSeconds"] = durationSeconds;
  doc["meta"]["completedNormally"] = completedNormally;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/events", body, response, status);
}

bool CloudClient::postStatus(const String &activity) {
  JsonDocument doc;
  doc["activity"] = activity;
  String body;
  serializeJson(doc, body);

  String response;
  int status;
  return request("POST", "/api/device/status", body, response, status);
}

std::vector<String> CloudClient::pollCommands() {
  std::vector<String> types;
  String body, response;
  int status;
  if (!request("GET", "/api/device/commands", body, response, status)) return types;

  JsonDocument doc;
  if (deserializeJson(doc, response) != DeserializationError::Ok) return types;
  for (JsonVariant cmd : doc.as<JsonArray>()) {
    types.push_back(cmd["type"].as<String>());
  }
  return types;
}
