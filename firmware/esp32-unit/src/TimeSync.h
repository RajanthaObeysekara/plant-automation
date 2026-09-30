#pragma once
#include <Arduino.h>

// Wall-clock time from the internet, with no PC involved. NTP (three
// servers) is started as soon as WiFi is up and retried until it lands;
// if NTP still hasn't answered (e.g. a router blocking UDP 123), the time
// is taken from an HTTP server's Date header instead. Once set, the
// ESP32's own clock keeps time through WiFi dropouts; SNTP re-syncs it
// hourly in the background.
namespace TimeSync {
  void begin();       // call right after WiFi connects
  void loop();        // call every loop() — non-blocking except a rare HTTP fallback
  bool valid();       // clock has been set at least once
}
