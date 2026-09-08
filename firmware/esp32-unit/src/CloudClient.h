#pragma once
#include <Arduino.h>
#include <vector>
#include "DeviceConfig.h"

// Talks to this room's slice of the backend's device API
// (backend/src/routes/device.js, buildRoomDeviceRouter — mounted at
// /api/device/room). Plain HTTP(S), polled on an interval, bearer
// per-device key auth. No broker to run, resilient to reconnects — the
// unit always keeps misting on its last-synced config (and cached 7-day
// plan — see DeviceConfig.h) even if this link is down.
class CloudClient {
public:
  void begin(const String &backendUrl, const String &deviceKey);

  // `isBoot` marks this as the device's first fetch since power-on — sent
  // as ?boot=1 so the backend can record a real reboot instead of it
  // looking like a routine poll (see rooms.last_boot_at).
  bool fetchConfig(DeviceConfig &out, bool isBoot);
  bool postTelemetry(float humidity, float tempC, bool raining, int scheduleVersion);
  bool postMistEvent(int durationSeconds, float volumeMl, float humidity, float tempC);
  bool postMistSkipped(const String &reason);
  bool postFungicideReminder(const String &lastSprayedDate);
  bool postFeedReminder(const String &date, int doseMl);
  bool postStatus(const String &activity);
  std::vector<String> pollCommands();

private:
  String _backendUrl;
  String _deviceKey;
  bool request(const char *method, const String &path, const String &body, String &responseOut, int &statusOut);
};
