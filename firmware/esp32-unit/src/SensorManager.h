#pragma once
#include <Arduino.h>

struct Reading {
  bool valid = false;
  float humidity = NAN;
  float tempC = NAN;
  bool raining = false;
};

// Water level sensing moved to the (not yet built) farm controller — this
// room has no tank of its own to sense. See Config.h.
class SensorManager {
public:
  void begin();
  Reading read();
};
