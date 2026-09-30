#pragma once
#include <Arduino.h>
#include "SensorManager.h"

// DM0054 0.95" 96x64 full-color SPI OLED (SSD1331). One persistent
// industrial-style readout: a status bar (WiFi signal, live clock, one dot
// per sensor) across the top, and a compact label/value data table below
// — humidity, temperature (both averaged across the two DHT22s), and a
// status line. The branding splash shows once at boot, never again.
class DisplayDriver {
public:
  bool begin();

  // Shown once, briefly, at actual power-on — never repeated. `version`
  // is the running firmware version; `note` an optional extra line (e.g.
  // "UPDATED" right after an OTA install).
  void showBootSplash(const char *version, const String &note = "");

  // Shown when the board has no WiFi/MQTT credentials in NVS yet — it
  // then waits for tools/provision.py over USB (see Secrets.h).
  void showNotProvisioned();
  // Same idea, for the blocking WiFi.begin() wait loop in main.cpp's
  // setup() — it needs something on screen too.
  void showConnecting(const String &ssid);

  // Call once per loop() iteration. Reads WiFi connection/signal and NTP
  // time itself. `paused` and `note` (a short transient string, or "" for
  // the normal status line) are how a dashboard control press — Pause,
  // Mist now — becomes visible here, not just in the background.
  // `identity` is the plain-text farm/room line (empty until config syncs).
  // `tankState` is the bench-test farm-tank state from the two low/high
  // MD0372 float switches (EMPTY/OK/FULL/FAULT, or "" until both have
  // reported — see tankStateLabel() in main.cpp).
  // `outputsOn` is ShiftRegister::activeMask() — one 2x2 dot per shift
  // register output along the bottom edge, green = energized, red = off.
  // Full-screen OTA progress (see Ota.cpp). pct < 0 hides the bar.
  // Takes over the screen; the device restarts afterwards either way, so
  // the normal readout is redrawn from scratch.
  void showUpdate(const String &title, const String &line1, const String &line2, int pct, bool error = false);

  void update(const Reading &r, const String &activity, bool paused, const String &note,
              const String &identity = "", const String &tankState = "", uint32_t outputsOn = 0);

};
