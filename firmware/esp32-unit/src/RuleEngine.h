#pragma once
#include <Arduino.h>
#include <time.h>
#include "DeviceConfig.h"

// Same threshold/window logic as simulator/src/rules.js's shouldMist(), so a
// real unit and its simulated stand-in mist on the same conditions.
//
// Feed-day and fungicide-due decisions are deliberately NOT here anymore —
// those are server-initiated now (see backend/src/planner.js): the server
// computes which calendar days are feed/fungicide days and hands down a
// 7-day plan (DeviceConfig::plan) for main.cpp to read directly, rather
// than this board re-deriving that date math itself. Humidity/temp/rain
// triggers can't be precomputed that way — they stay here as live,
// sensor-driven decisions.
namespace RuleEngine {

bool isInWindow(const struct tm &now, const String &windowStart, const String &windowEnd);
bool isDaytime(const struct tm &now);
bool shouldMist(const struct tm &now, float humidity, float tempC, bool raining, const DeviceConfig &cfg);

} // namespace RuleEngine
