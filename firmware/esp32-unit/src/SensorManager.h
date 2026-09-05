#pragma once
#include <Arduino.h>

struct Reading {
  bool valid = false;
  float humidity = NAN;
  float tempC = NAN;
  bool raining = false;
};

// Raw physical state only — "does this sensor detect liquid at its mounted
// height?" The fill/no-fill *decision* belongs in the rule layer, not here:
// a low reading of false means the tank has dropped below that point
// (needs a fill), not the reverse.
struct WaterLevel {
  bool lowDetected;  // liquid present at the low-mounted sensor
  bool fullDetected; // liquid present at the high-mounted sensor
};

class SensorManager {
public:
  void begin();
  Reading read();
  WaterLevel readWaterLevel();
};
