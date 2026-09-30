#include "TimeSync.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <sys/time.h>
#include <time.h>
#include "Config.h"

namespace {
unsigned long lastAttemptAt = 0;
int attempts = 0;
bool announced = false;

void startNtp() {
  configTime(TZ_GMT_OFFSET_SEC, TZ_DST_OFFSET_SEC, NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
}

int monthIndex(const char *m) {
  static const char *names = "JanFebMarAprMayJunJulAugSepOctNovDec";
  const char *p = strstr(names, m);
  return p ? (int)(p - names) / 3 : -1;
}

// Parses an RFC 7231 Date header, e.g. "Wed, 30 Sep 2026 02:22:23 GMT".
bool setFromHttpDate() {
  HTTPClient http;
  const char *keys[] = {"Date"};
  http.setTimeout(5000);
  if (!http.begin(TIME_HTTP_FALLBACK_URL)) return false;
  http.collectHeaders(keys, 1);
  int code = http.sendRequest("HEAD");
  String date = http.header("Date");
  http.end();
  if (code <= 0 || date.length() < 29) return false;

  int day, year, hh, mm, ss;
  char mon[4] = {0};
  if (sscanf(date.c_str() + 5, "%d %3s %d %d:%d:%d", &day, mon, &year, &hh, &mm, &ss) != 6) return false;
  int m = monthIndex(mon);
  if (m < 0) return false;

  // Days since the epoch for a UTC civil date (no timegm() on this libc).
  int y = year - (m < 2);
  int era = y / 400;
  int yoe = y - era * 400;
  int doy = (153 * (m + (m > 1 ? -2 : 10)) + 2) / 5 + day - 1;
  int doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  long days = (long)era * 146097 + doe - 719468;

  struct timeval tv = {(time_t)(days * 86400L + hh * 3600L + mm * 60L + ss), 0};
  settimeofday(&tv, nullptr);
  return true;
}
} // namespace

namespace TimeSync {

bool valid() {
  return time(nullptr) > 1700000000; // anything before Nov 2023 means "never set"
}

void begin() {
  startNtp();
  lastAttemptAt = millis();
  attempts = 1;
}

void loop() {
  if (valid()) {
    if (!announced) {
      announced = true;
      struct tm ti;
      getLocalTime(&ti, 0);
      Serial.printf("[time] clock set: %04d-%02d-%02d %02d:%02d:%02d (UTC+5:30)\n",
                    ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday, ti.tm_hour, ti.tm_min, ti.tm_sec);
    }
    return;
  }
  if (WiFi.status() != WL_CONNECTED) return;
  if (attempts > 0 && millis() - lastAttemptAt < TIME_RETRY_MS) return;
  lastAttemptAt = millis();
  attempts++;

  // Alternate: odd attempts restart NTP, even ones try the HTTP Date header.
  if (attempts % 2) {
    Serial.printf("[time] NTP not answered yet — retrying (attempt %d)\n", attempts);
    startNtp();
  } else if (setFromHttpDate()) {
    Serial.println("[time] NTP unavailable — clock set from HTTP Date header");
  } else {
    Serial.println("[time] HTTP time fallback failed too — will retry");
  }
}

} // namespace TimeSync
