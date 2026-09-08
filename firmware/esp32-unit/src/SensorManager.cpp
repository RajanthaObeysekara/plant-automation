#include "SensorManager.h"
#include <DHT.h>
#include "Config.h"

static DHT dht(PIN_DHT22, DHT22);

void SensorManager::begin() {
  dht.begin();
  pinMode(PIN_RAIN_DIGITAL, INPUT);
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
