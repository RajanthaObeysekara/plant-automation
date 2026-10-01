#include "Secrets.h"
#include <Preferences.h>
#include "Config.h"

namespace {
const char *NS = "secrets";
const char *REQUIRED[] = {"wifi_ssid", "wifi_pass", "mqtt_user", "mqtt_pass", "device_key"};
const char *KNOWN[] = {"wifi_ssid", "wifi_pass", "mqtt_user", "mqtt_pass", "device_key",
                       "mqtt_host", "mqtt_port", "has_tank", "has_scale", "sr_test", "ota_url"};
Preferences prefs;
bool opened = false;

bool known(const String &k) {
  for (const char *n : KNOWN) if (k == n) return true;
  return false;
}
} // namespace

namespace Secrets {

void begin() {
  if (!opened) opened = prefs.begin(NS, false);
}

String get(const char *key, const char *fallback) {
  begin();
  return prefs.isKey(key) ? prefs.getString(key, fallback) : String(fallback);
}

bool set(const String &key, const String &value) {
  if (!known(key)) return false;
  begin();
  if (value.length() == 0) prefs.remove(key.c_str());
  else prefs.putString(key.c_str(), value);
  return true;
}

bool complete() {
  for (const char *k : REQUIRED) if (get(k).length() == 0) return false;
  return true;
}

void clearAll() {
  begin();
  prefs.clear();
}

void printMasked() {
  for (const char *k : KNOWN) {
    String v = get(k);
    bool secret = strstr(k, "pass") != nullptr;
    Serial.printf("[secret] %-10s = %s\n", k,
                  v.length() == 0 ? "(not set)" : secret ? "******" : v.c_str());
  }
  Serial.printf("[secret] complete: %s\n", complete() ? "yes" : "NO");
}

String mqttHost() { return get("mqtt_host", MQTT_HOST); }
uint16_t mqttPort() { return (uint16_t)get("mqtt_port", String(MQTT_PORT).c_str()).toInt(); }
bool hasTank() { return get("has_tank", "0") == "1"; }
bool hasScale() { return get("has_scale", "1") == "1"; }

} // namespace Secrets
