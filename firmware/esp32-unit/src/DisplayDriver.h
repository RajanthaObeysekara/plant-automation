#pragma once
#include <Arduino.h>

class DisplayDriver {
public:
  bool begin();
  void showReadings(float humidity, float tempC, bool raining, const String &activity);
  void showStatus(const String &line1, const String &line2);
};
