#pragma once
#include <Arduino.h>
#include "CloudClient.h"

// Small ring buffer of diagnostically-useful lines (boot outcome, WiFi
// result, sync/command activity — not a mirror of every Serial.print),
// periodically batch-uploaded to POST /api/device/room/logs so this board's
// story is visible on the dashboard's Device Console without a laptop on
// its USB port. Buffering (rather than uploading immediately) matters most
// exactly when things are going wrong: lines logged while WiFi/backend is
// down just sit here and flush together the moment connectivity returns.
namespace RemoteLog {
  void begin(CloudClient *client);
  void add(const String &level, const String &message);
  // Call once per loop() iteration — actually flushes on its own timer,
  // not on every call.
  void loop();
}
