#include "RuleEngine.h"

namespace {

int timeToMinutes(const String &hhmm) {
  int colon = hhmm.indexOf(':');
  if (colon < 0) return 0;
  int h = hhmm.substring(0, colon).toInt();
  int m = hhmm.substring(colon + 1).toInt();
  return h * 60 + m;
}

// Parses "YYYY-MM-DD" into a tm struct at local midnight.
struct tm parseIsoDate(const String &iso) {
  struct tm t = {};
  t.tm_year = iso.substring(0, 4).toInt() - 1900;
  t.tm_mon = iso.substring(5, 7).toInt() - 1;
  t.tm_mday = iso.substring(8, 10).toInt();
  t.tm_hour = 0;
  t.tm_min = 0;
  t.tm_sec = 0;
  t.tm_isdst = -1;
  return t;
}

struct tm midnightOf(const struct tm &now) {
  struct tm t = now;
  t.tm_hour = 0;
  t.tm_min = 0;
  t.tm_sec = 0;
  return t;
}

} // namespace

namespace RuleEngine {

long daysBetween(const String &isoDate, const struct tm &now) {
  struct tm a = parseIsoDate(isoDate);
  struct tm b = midnightOf(now);
  time_t ta = mktime(&a);
  time_t tb = mktime(&b);
  return (long)((tb - ta) / 86400L);
}

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

FeedForecast feedPhase(const struct tm &now, const DeviceConfig &cfg) {
  long elapsedDays = daysBetween(cfg.feedStartDate, now);
  if (elapsedDays < 0) elapsedDays = 0; // schedule starts today or in the future
  int weekIndex = (int)((elapsedDays / 7) % cfg.cycleWeeks);
  int weekNumber = weekIndex + 1;
  bool isFeedWeek = weekNumber <= cfg.cycleWeeks - 1; // last week is the salt flush

  struct tm feedStart = parseIsoDate(cfg.feedStartDate);
  mktime(&feedStart); // normalizes tm_wday
  bool isFeedDay = feedStart.tm_wday == now.tm_wday;

  return { weekNumber, isFeedWeek && isFeedDay };
}

bool fungicideDue(const struct tm &now, const DeviceConfig &cfg) {
  return daysBetween(cfg.fungicideLastSprayedDate, now) >= cfg.fungicideIntervalDays;
}

} // namespace RuleEngine
