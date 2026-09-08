#pragma once
#include <Arduino.h>

// One entry of the server-computed 7-day forward plan (see
// backend/src/planner.js — GET /api/device/room/config). This is what
// "server-initiated scheduling" means concretely: the server decides which
// calendar days get a feed dose or a fungicide reminder, and this board
// just executes that — reading it back out of NVS is enough to keep making
// correct feed/fungicide decisions for up to a week with zero contact with
// the backend.
struct PlanDay {
  String date; // "YYYY-MM-DD"
  bool isFeedDay = false;
  int doseMl = 0;
  bool fungicideDue = false;
  int fungicideDoseMl = 0;
};
#define PLAN_DAYS 7

// Mirrors the shape returned by GET /api/device/room/config on the backend
// — see backend/src/routes/device.js (buildRoomDeviceRouter). Kept in NVS
// so the unit can keep misting on the last-synced copy if the backend or
// Wi-Fi drops, for as long as the cached plan still covers today.
struct DeviceConfig {
  bool valid = false;

  float humidityBelow = 60;
  float tempAbove = 32;

  String windowStart = "06:30";
  String windowEnd = "08:00";

  // Feed/fungicide dosing itself is never actuated by this board (see
  // Config.h) — these are only kept to log/display which product and dose
  // a due reminder refers to, and to prevent re-reminding the same day.
  int fungicideDoseMl = 250;
  String fungicideLastSprayedDate = "2026-01-01";
  String lastFedDate = "";

  bool paused = false;
  bool skipFeedOnce = false;

  // From the farm device, via the room's own config response — this room
  // has no tank sensors of its own, it just reads the shared tank's
  // readiness as a plain boolean.
  bool tankReady = false;
  bool tankLow = false;
  float pumpFlowLpm = 4.5; // for volume-used estimates on the mist event we post

  // Sync state (see PROJECT.md / planner.js) — bumped server-side on every
  // schedule change; this board echoes it back on telemetry so "synced" is
  // a checkable fact on the dashboard, not an assumption.
  int scheduleVersion = 0;
  PlanDay plan[PLAN_DAYS];
  int planCount = 0;
};
