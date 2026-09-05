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
  pinMode(PIN_RELAY_FERT_PUMP, OUTPUT);
  pinMode(PIN_RELAY_FERT_VALVE, OUTPUT);
  pinMode(PIN_RELAY_FUNGICIDE_PUMP, OUTPUT);
  pinMode(PIN_RELAY_FUNGICIDE_VALVE, OUTPUT);
  pinMode(PIN_RELAY_WATER_INLET, OUTPUT);
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

void ActuatorController::startFeedLine() {
  relayWrite(PIN_RELAY_FERT_VALVE, true);
  relayWrite(PIN_RELAY_FERT_PUMP, true);
}

void ActuatorController::stopFeedLine() {
  relayWrite(PIN_RELAY_FERT_PUMP, false);
  relayWrite(PIN_RELAY_FERT_VALVE, false);
}

void ActuatorController::startFungicideLine() {
  relayWrite(PIN_RELAY_FUNGICIDE_VALVE, true);
  relayWrite(PIN_RELAY_FUNGICIDE_PUMP, true);
}

void ActuatorController::stopFungicideLine() {
  relayWrite(PIN_RELAY_FUNGICIDE_PUMP, false);
  relayWrite(PIN_RELAY_FUNGICIDE_VALVE, false);
}

void ActuatorController::openWaterInlet() {
  relayWrite(PIN_RELAY_WATER_INLET, true);
}

void ActuatorController::closeWaterInlet() {
  relayWrite(PIN_RELAY_WATER_INLET, false);
}

void ActuatorController::allOff() {
  stopWaterLine();
  stopFeedLine();
  stopFungicideLine();
  closeWaterInlet();
}
