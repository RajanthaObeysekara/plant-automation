#include "LocalCache.h"
#include <Preferences.h>
#include <ArduinoJson.h>
#include "Config.h"

namespace LocalCache {

void save(const DeviceConfig &cfg) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putFloat("humidityBelow", cfg.humidityBelow);
  prefs.putFloat("tempAbove", cfg.tempAbove);
  prefs.putString("windowStart", cfg.windowStart);
  prefs.putString("windowEnd", cfg.windowEnd);
  prefs.putInt("fungicideDoseMl", cfg.fungicideDoseMl);
  prefs.putString("fungicideLast", cfg.fungicideLastSprayedDate);
  prefs.putString("lastFedDate", cfg.lastFedDate);
  prefs.putBool("paused", cfg.paused);
  prefs.putBool("skipFeed", cfg.skipFeedOnce);
  prefs.putBool("tankReady", cfg.tankReady);
  prefs.putBool("tankLow", cfg.tankLow);
  prefs.putFloat("pumpFlowLpm", cfg.pumpFlowLpm);
  prefs.putInt("scheduleVer", cfg.scheduleVersion);

  // The 7-day plan is the one thing worth serializing as a single blob
  // rather than a field per key — it's a small, fixed-shape array and this
  // keeps save/load from drifting out of sync with PLAN_DAYS.
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (int i = 0; i < cfg.planCount; i++) {
    JsonObject o = arr.add<JsonObject>();
    o["date"] = cfg.plan[i].date;
    o["isFeedDay"] = cfg.plan[i].isFeedDay;
    o["doseMl"] = cfg.plan[i].doseMl;
    o["fungicideDue"] = cfg.plan[i].fungicideDue;
    o["fungicideDoseMl"] = cfg.plan[i].fungicideDoseMl;
  }
  String planJson;
  serializeJson(doc, planJson);
  prefs.putString("plan", planJson);

  prefs.putBool("valid", true);
  prefs.end();
}

DeviceConfig load() {
  DeviceConfig cfg;
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  cfg.valid = prefs.getBool("valid", false);
  if (cfg.valid) {
    cfg.humidityBelow = prefs.getFloat("humidityBelow", cfg.humidityBelow);
    cfg.tempAbove = prefs.getFloat("tempAbove", cfg.tempAbove);
    cfg.windowStart = prefs.getString("windowStart", cfg.windowStart);
    cfg.windowEnd = prefs.getString("windowEnd", cfg.windowEnd);
    cfg.fungicideDoseMl = prefs.getInt("fungicideDoseMl", cfg.fungicideDoseMl);
    cfg.fungicideLastSprayedDate = prefs.getString("fungicideLast", cfg.fungicideLastSprayedDate);
    cfg.lastFedDate = prefs.getString("lastFedDate", cfg.lastFedDate);
    cfg.paused = prefs.getBool("paused", cfg.paused);
    cfg.skipFeedOnce = prefs.getBool("skipFeed", cfg.skipFeedOnce);
    cfg.tankReady = prefs.getBool("tankReady", cfg.tankReady);
    cfg.tankLow = prefs.getBool("tankLow", cfg.tankLow);
    cfg.pumpFlowLpm = prefs.getFloat("pumpFlowLpm", cfg.pumpFlowLpm);
    cfg.scheduleVersion = prefs.getInt("scheduleVer", cfg.scheduleVersion);

    String planJson = prefs.getString("plan", "[]");
    JsonDocument doc;
    if (deserializeJson(doc, planJson) == DeserializationError::Ok) {
      cfg.planCount = 0;
      for (JsonVariant day : doc.as<JsonArray>()) {
        if (cfg.planCount >= PLAN_DAYS) break;
        PlanDay &pd = cfg.plan[cfg.planCount];
        pd.date = day["date"] | "";
        pd.isFeedDay = day["isFeedDay"] | false;
        pd.doseMl = day["doseMl"] | 0;
        pd.fungicideDue = day["fungicideDue"] | false;
        pd.fungicideDoseMl = day["fungicideDoseMl"] | 0;
        cfg.planCount++;
      }
    }
  }
  prefs.end();
  return cfg;
}

void saveBackendUrl(const String &url) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putString("backendUrl", url);
  prefs.end();
}

String loadBackendUrl() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  String v = prefs.getString("backendUrl", "");
  prefs.end();
  return v;
}

void saveDeviceKey(const String &key) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putString("deviceKey", key);
  prefs.end();
}

String loadDeviceKey() {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, true);
  String v = prefs.getString("deviceKey", "");
  prefs.end();
  return v;
}

} // namespace LocalCache
