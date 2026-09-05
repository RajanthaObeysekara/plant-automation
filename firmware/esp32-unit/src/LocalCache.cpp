#include "LocalCache.h"
#include <Preferences.h>
#include "Config.h"

namespace LocalCache {

void save(const DeviceConfig &cfg) {
  Preferences prefs;
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putFloat("humidityBelow", cfg.humidityBelow);
  prefs.putFloat("tempAbove", cfg.tempAbove);
  prefs.putString("windowStart", cfg.windowStart);
  prefs.putString("windowEnd", cfg.windowEnd);
  prefs.putInt("cycleWeeks", cfg.cycleWeeks);
  prefs.putString("feedStart", cfg.feedStartDate);
  prefs.putInt("preWaterMin", cfg.preWaterWaitMinutes);
  prefs.putInt("doseMl", cfg.doseMl);
  prefs.putInt("fungicideDays", cfg.fungicideIntervalDays);
  prefs.putString("fungicideLast", cfg.fungicideLastSprayedDate);
  prefs.putBool("paused", cfg.paused);
  prefs.putBool("skipFeed", cfg.skipFeedOnce);
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
    cfg.cycleWeeks = prefs.getInt("cycleWeeks", cfg.cycleWeeks);
    cfg.feedStartDate = prefs.getString("feedStart", cfg.feedStartDate);
    cfg.preWaterWaitMinutes = prefs.getInt("preWaterMin", cfg.preWaterWaitMinutes);
    cfg.doseMl = prefs.getInt("doseMl", cfg.doseMl);
    cfg.fungicideIntervalDays = prefs.getInt("fungicideDays", cfg.fungicideIntervalDays);
    cfg.fungicideLastSprayedDate = prefs.getString("fungicideLast", cfg.fungicideLastSprayedDate);
    cfg.paused = prefs.getBool("paused", cfg.paused);
    cfg.skipFeedOnce = prefs.getBool("skipFeed", cfg.skipFeedOnce);
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
