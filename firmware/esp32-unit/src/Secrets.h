#pragma once
#include <Arduino.h>

// Per-board settings that must never be compiled into the firmware: the
// firmware image is published publicly (GitHub Releases, for OTA), and any
// string baked into it can be read back out. These live in NVS instead,
// written once per board over USB (tools/provision.py sends the `secret`
// serial commands), and survive every OTA update.
//
// Keys:  wifi_ssid wifi_pass mqtt_user mqtt_pass device_key   (required)
//        mqtt_host mqtt_port has_tank has_scale sr_test ota_url  (optional)
namespace Secrets {
  void begin();                         // load from NVS
  bool complete();                      // all required keys present
  String get(const char *key, const char *fallback = "");
  bool set(const String &key, const String &value);
  void clearAll();
  void printMasked();                   // for the `secret show` command

  // Convenience accessors
  inline String wifiSsid()  { return get("wifi_ssid"); }
  inline String wifiPass()  { return get("wifi_pass"); }
  inline String mqttUser()  { return get("mqtt_user"); }
  inline String mqttPass()  { return get("mqtt_pass"); }
  inline String deviceKey() { return get("device_key"); }
  String mqttHost();
  uint16_t mqttPort();
  bool hasTank();                       // this board has the tank float switches wired
  bool hasScale();                      // this board has an HX711 load cell amplifier wired (default yes)
}
