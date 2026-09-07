#include "SensorManager.h"
#include <DHT.h>
#include "Config.h"

static DHT dht(PIN_DHT22, DHT22);

void SensorManager::begin() {
  dht.begin();
  pinMode(PIN_RAIN_DIGITAL, INPUT);
  pinMode(PIN_WATER_LEVEL_LOW, INPUT);  // input-only pin — no pull resistor available or needed,
  pinMode(PIN_WATER_LEVEL_FULL, INPUT); // the sensor module drives this actively
  // The limit switch is a bare mechanical contact, not an active sensor module,
  // and GPIO34-39 have NO internal pull resistors on the ESP32 — INPUT_PULLUP
  // silently does nothing here. Wire an external pull resistor (or a switch
  // module with one built in) or this reading will float.
  pinMode(PIN_WATER_LEVEL_LIMIT, INPUT);
}

Reading SensorManager::read() {
  Reading r;
  r.humidity = dht.readHumidity();
  r.tempC = dht.readTemperature();
  bool pinHigh = digitalRead(PIN_RAIN_DIGITAL) == HIGH;
  r.raining = RAIN_ACTIVE_HIGH ? pinHigh : !pinHigh;
  r.valid = !isnan(r.humidity) && !isnan(r.tempC);
  if (!r.valid) {
    Serial.println("[sensors] DHT22 read failed — check wiring/pull-up");
  }
  return r;
}

WaterLevel SensorManager::readWaterLevel() {
  bool lowPinHigh = digitalRead(PIN_WATER_LEVEL_LOW) == HIGH;
  bool fullPinHigh = digitalRead(PIN_WATER_LEVEL_FULL) == HIGH;
  bool limitPinHigh = digitalRead(PIN_WATER_LEVEL_LIMIT) == HIGH;
  WaterLevel w;
  w.lowDetected = WATER_LEVEL_ACTIVE_HIGH ? lowPinHigh : !lowPinHigh;
  w.fullDetected = WATER_LEVEL_ACTIVE_HIGH ? fullPinHigh : !fullPinHigh;
  w.overflowDetected = WATER_LEVEL_LIMIT_ACTIVE_HIGH ? limitPinHigh : !limitPinHigh;
  return w;
}
