#pragma once
#include <Arduino.h>

// The water rig's three relays (shift register outputs, see Config.h):
// input valve (refills the bucket), output valve and pump (draw from the
// bucket). Valves are normally-closed 12V solenoids; all loads are wired
// to relay COM+NO, so a de-energized relay always means OFF. Sequencing
// and safety interlocks live in WaterSystem - this class only switches.
class ActuatorController {
public:
  void begin();
  void setInputValve(bool open);
  void setOutputValve(bool open);
  void setPump(bool on);
  void allOff();
  bool inputValveOpen() const { return _in; }
  bool outputValveOpen() const { return _out; }
  bool pumpOn() const { return _pump; }

private:
  bool _in = false, _out = false, _pump = false;
};
