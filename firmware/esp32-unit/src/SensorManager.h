#pragma once
#include <Arduino.h>

struct Reading {
  bool valid = false;      // true if at least one of the two sensors read successfully
  float humidity = NAN;    // the room's one definitive reading: average of both sensors
  float tempC = NAN;       // when both are valid, otherwise whichever one is

  bool sensor1Valid = false;
  float humidity1 = NAN;
  float tempC1 = NAN;

  bool sensor2Valid = false;
  float humidity2 = NAN;
  float tempC2 = NAN;

  // MD0019 rain sensor (YL-83/FC-37) — see Config.h.
  bool raining = false;
};

class SensorManager {
public:
  void begin();
  Reading read();
};
