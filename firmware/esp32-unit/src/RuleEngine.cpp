#include "RuleEngine.h"

namespace {

int timeToMinutes(const String &hhmm) {
  int colon = hhmm.indexOf(':');
  if (colon < 0) return 0;
  int h = hhmm.substring(0, colon).toInt();
  int m = hhmm.substring(colon + 1).toInt();
  return h * 60 + m;
}

} // namespace

namespace RuleEngine {

bool isInWindow(const struct tm &now, const String &windowStart, const String &windowEnd) {
  int nowMin = now.tm_hour * 60 + now.tm_min;
  return nowMin >= timeToMinutes(windowStart) && nowMin <= timeToMinutes(windowEnd);
}

// Never mist between dusk and dawn, even on a threshold trigger — a wet
// crown overnight is how crown rot starts.
bool isDaytime(const struct tm &now) {
  return now.tm_hour >= 6 && now.tm_hour < 18;
}

bool shouldMist(const struct tm &now, float humidity, float tempC, bool raining, const DeviceConfig &cfg) {
  if (cfg.paused) return false;
  if (raining) return false;
  if (isInWindow(now, cfg.windowStart, cfg.windowEnd)) return true;
  if (!isDaytime(now)) return false;
  return humidity < cfg.humidityBelow || tempC > cfg.tempAbove;
}

} // namespace RuleEngine
