#pragma once
#include <Arduino.h>
#include <time.h>
#include "DeviceConfig.h"

// Same logic as device-simulator/src/rules.js, ported to C++ so a real unit
// and its simulated stand-in behave identically. This is the only module
// that makes decisions — everything else reads, writes, or executes.
namespace RuleEngine {

struct FeedForecast {
  int weekNumber;
  bool isFeedDay;
};

bool isInWindow(const struct tm &now, const String &windowStart, const String &windowEnd);
bool isDaytime(const struct tm &now);
bool shouldMist(const struct tm &now, float humidity, float tempC, bool raining, const DeviceConfig &cfg);
FeedForecast feedPhase(const struct tm &now, const DeviceConfig &cfg);
bool fungicideDue(const struct tm &now, const DeviceConfig &cfg);

// Days between an ISO "YYYY-MM-DD" date and `now`, both truncated to midnight.
long daysBetween(const String &isoDate, const struct tm &now);

} // namespace RuleEngine
