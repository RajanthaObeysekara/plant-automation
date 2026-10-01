#include "ActuatorController.h"
#include "Config.h"
#include "ShiftRegister.h"

namespace {
void relayWrite(uint8_t output, bool energize) {
  ShiftRegister::write(output, RELAY_ACTIVE_LOW ? !energize : energize);
}
} // namespace

// Relays are driven through the shift register — ShiftRegister::begin()
// must already have run (first thing in setup(), see main.cpp).
void ActuatorController::begin() {
  allOff();
}

void ActuatorController::setInputValve(bool open) {
  _in = open;
  relayWrite(SR_OUT_INPUT_VALVE, open);
}

void ActuatorController::setOutputValve(bool open) {
  _out = open;
  relayWrite(SR_OUT_OUTPUT_VALVE, open);
}

void ActuatorController::setPump(bool on) {
  _pump = on;
  relayWrite(SR_OUT_PUMP, on);
}

void ActuatorController::allOff() {
  setPump(false);       // pump first, so it never runs against a closing valve
  setOutputValve(false);
  setInputValve(false);
}
