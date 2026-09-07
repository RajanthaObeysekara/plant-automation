#pragma once
#include <Arduino.h>

// Mirrors the shape returned by GET /api/device/config on the backend —
// see backend/src/routes/device.js. Kept in NVS so the unit can keep
// misting on the last-synced copy if the backend or Wi-Fi drops.
struct DeviceConfig {
  bool valid = false;

  float humidityBelow = 60;
  float tempAbove = 32;

  String windowStart = "06:30";
  String windowEnd = "08:00";

  int cycleWeeks = 5;
  String feedStartDate = "2026-01-01";
  int preWaterWaitMinutes = 15;
  int doseMl = 250;

  int fungicideIntervalDays = 14;
  String fungicideLastSprayedDate = "2026-01-01";
  int fungicideDoseMl = 250;
  bool fungicideAutomated = false; // opt-in — needs the dedicated 3rd line + coarse nozzle, never the fine fogging manifold

  bool autofillEnabled = false;
  int dechlorinateHours = 24;  // mains is chlorinated — hold misting this long after every tank fill
  float pumpFlowLpm = 4.5;     // actual misting pump flow rate, for volume-used estimates

  bool paused = false;
  bool skipFeedOnce = false;
};
