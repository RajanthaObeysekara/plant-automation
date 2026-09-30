#include "RemoteLog.h"

namespace {
  const int MAX_BUFFERED = 40;
  const unsigned long FLUSH_INTERVAL_MS = 10000UL;

  RemoteLogLine buffer[MAX_BUFFERED];
  int count = 0;
  CloudClient *cloudClient = nullptr;
  unsigned long lastFlushAt = 0;
}

void RemoteLog::begin(CloudClient *client) {
  cloudClient = client;
  lastFlushAt = millis();
}

void RemoteLog::add(const String &level, const String &message) {
  if (count >= MAX_BUFFERED) {
    // Offline for a while — drop the oldest line to make room rather than
    // stop capturing new ones. Losing old boot noise is fine; losing what
    // just happened is not.
    for (int i = 1; i < MAX_BUFFERED; i++) buffer[i - 1] = buffer[i];
    count = MAX_BUFFERED - 1;
  }
  buffer[count].level = level;
  buffer[count].message = message;
  count++;
}

void RemoteLog::loop() {
  if (!cloudClient || count == 0) return;
  if (millis() - lastFlushAt < FLUSH_INTERVAL_MS) return;
  lastFlushAt = millis();

  if (cloudClient->postLogs(buffer, count)) {
    count = 0;
  }
  // On failure the buffer is left as-is and retried next interval — capped
  // at MAX_BUFFERED so it can't grow unbounded while the link is down.
}
