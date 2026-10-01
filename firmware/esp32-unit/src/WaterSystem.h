#pragma once
#include <Arduino.h>
#include "ActuatorController.h"

// Bucket controller for the water rig:
//
//   mains --[input valve R1]--> BUCKET (on the HX711 scale) --[output valve R2]--[pump R3]--> output
//                                  top float  = full mark
//                                  bottom float = low mark
//
// Refill: input valve opens when the water is below the BOTTOM float and
//   closes when it reaches the TOP float (hysteresis). A fill that hasn't
//   reached the top within WATER_FILL_TIMEOUT_MS stops and latches
//   FILL TIMEOUT (no mains / stuck valve / sensor), retried after
//   WATER_FILL_RETRY_MS.
// Pump run: only with water above the bottom float. Output valve opens
//   first, pump starts WATER_VALVE_LEAD_MS later; at the end the pump stops
//   first and the valve closes WATER_VALVE_LAG_MS later. If the water drops
//   below the bottom float mid-run the pump stops at once (dry-run guard).
// Sensor fault (top wet while bottom dry - impossible with real water):
//   everything off until it clears.
// Floats must hold a reading for WATER_FLOAT_DEBOUNCE_MS before it counts,
// so sloshing during a fill can't chatter the valve.
namespace Water {
  void begin(ActuatorController *act);
  // Call every loop(). rawLow/rawHigh: current float readings (true = wet),
  // valid=false until both have reported. weightKg: NAN if no scale.
  void tick(bool valid, bool rawLowWet, bool rawHighWet, float weightKg);

  // Start a pump run of `seconds`. false (with a short reason for the
  // display/log) when it isn't safe right now.
  bool requestPump(int seconds, String &whyNot);
  void stopAll(const char *why);      // immediate, e.g. before OTA or srtest
  void setSuspended(bool s);          // srtest: water control off while the chase runs

  bool pumpBusy();                    // a run (incl. valve lead/lag) is in progress
  bool filling();
  bool busy();                        // pumping or filling - not a good moment to OTA
  bool canPump();
  String statusText();                // short line for the OLED status row ("" = idle)

  // Live state for telemetry (plant/device/water) and the dashboard.
  bool levelsKnown();
  bool bottomWet();
  bool topWet();
  bool suspendedNow();
  const char *fillStateName();        // idle | filling | timeout
  const char *pumpStateName();        // idle | opening | running | closing
  int pumpSecondsLeft();              // -1 unless running

  // Result of the last finished pump run (for the mist event).
  int lastRunSeconds();
  float lastRunKg();                  // weight drop measured by the scale, NAN if unknown
  bool lastRunStoppedDry();
}
