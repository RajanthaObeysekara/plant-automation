#pragma once
#include <Arduino.h>
#include <vector>
#include "DeviceConfig.h"

// Talks to the same REST contract the device-simulator uses
// (backend/src/routes/device.js): plain HTTP(S) with a per-unit bearer
// device key, polled on an interval — no broker to run, resilient to
// reconnects. Real-time push to the browser happens on the backend side
// over WebSocket; the device itself never needs a persistent connection.
class CloudClient {
public:
  void begin(const String &backendUrl, const String &deviceKey);

  bool fetchConfig(DeviceConfig &out);
  bool postTelemetry(float humidity, float tempC, bool raining);
  bool postMistEvent(int durationSeconds, float volumeMl, bool forced, float humidity, float tempC);
  bool postFeedEvent(int durationSeconds, float volumeMl);
  bool postFungicideReminder(const String &lastSprayedDate);
  bool postFungicideSprayedEvent(int durationSeconds, float volumeMl, bool automated);
  bool postAutofillEvent(int durationSeconds, bool completedNormally);
  bool postStatus(const String &activity);
  std::vector<String> pollCommands();

private:
  String _backendUrl;
  String _deviceKey;
  bool request(const char *method, const String &path, const String &body, String &responseOut, int &statusOut);
};
