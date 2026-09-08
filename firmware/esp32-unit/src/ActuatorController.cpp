#include "ActuatorController.h"
#include <Arduino.h>
#include "Config.h"

namespace {
void relayWrite(int pin, bool energize) {
  digitalWrite(pin, (RELAY_ACTIVE_LOW ? !energize : energize) ? HIGH : LOW);
}
} // namespace

void ActuatorController::begin() {
  pinMode(PIN_RELAY_WATER_PUMP, OUTPUT);
  pinMode(PIN_RELAY_WATER_VALVE, OUTPUT);
  allOff();
}

void ActuatorController::startWaterLine() {
  relayWrite(PIN_RELAY_WATER_VALVE, true);
  relayWrite(PIN_RELAY_WATER_PUMP, true);
}

void ActuatorController::stopWaterLine() {
  relayWrite(PIN_RELAY_WATER_PUMP, false);
  relayWrite(PIN_RELAY_WATER_VALVE, false);
}

void ActuatorController::allOff() {
  stopWaterLine();
}
