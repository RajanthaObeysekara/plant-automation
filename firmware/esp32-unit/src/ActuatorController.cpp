#include "ActuatorController.h"
#include <Arduino.h>
#include "Config.h"
#include "ShiftRegister.h"

namespace {
void relayWrite(uint8_t output, bool energize) {
  ShiftRegister::write(output, RELAY_ACTIVE_LOW ? !energize : energize);
}
} // namespace

// Relays are driven through the shift register — ShiftRegister::begin()
// must already have run (see setup() in main.cpp).
void ActuatorController::begin() {
  allOff();
}

void ActuatorController::startWaterLine() {
  relayWrite(SR_OUT_WATER_VALVE, true);
  relayWrite(SR_OUT_WATER_PUMP, true);
}

void ActuatorController::stopWaterLine() {
  relayWrite(SR_OUT_WATER_PUMP, false);
  relayWrite(SR_OUT_WATER_VALVE, false);
}

void ActuatorController::allOff() {
  stopWaterLine();
}
