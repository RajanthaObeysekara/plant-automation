#include "SensorManager.h"
#include <DHT.h>
#include "Config.h"

static DHT dht1(PIN_DHT22_1, DHT22);
static DHT dht2(PIN_DHT22_2, DHT22);

void SensorManager::begin() {
  dht1.begin();
  dht2.begin();
  pinMode(PIN_RAIN_DIGITAL, INPUT);
}

Reading SensorManager::read() {
  Reading r;

  r.humidity1 = dht1.readHumidity();
  r.tempC1 = dht1.readTemperature();
  r.sensor1Valid = !isnan(r.humidity1) && !isnan(r.tempC1);
  if (!r.sensor1Valid) {
    Serial.println("[sensors] DHT22 #1 (GPIO4) read failed — check wiring/pull-up");
  }

  r.humidity2 = dht2.readHumidity();
  r.tempC2 = dht2.readTemperature();
  r.sensor2Valid = !isnan(r.humidity2) && !isnan(r.tempC2);
  if (!r.sensor2Valid) {
    Serial.println("[sensors] DHT22 #2 (GPIO21) read failed — check wiring/pull-up");
  }

  if (r.sensor1Valid && r.sensor2Valid) {
    r.humidity = (r.humidity1 + r.humidity2) / 2.0f;
    r.tempC = (r.tempC1 + r.tempC2) / 2.0f;
  } else if (r.sensor1Valid) {
    r.humidity = r.humidity1;
    r.tempC = r.tempC1;
  } else if (r.sensor2Valid) {
    r.humidity = r.humidity2;
    r.tempC = r.tempC2;
  }
  r.valid = r.sensor1Valid || r.sensor2Valid;

  int rainRaw = digitalRead(PIN_RAIN_DIGITAL);
  r.raining = RAIN_ACTIVE_LOW ? (rainRaw == LOW) : (rainRaw == HIGH);
  static int lastRainRaw = -1;
  if (rainRaw != lastRainRaw) {
    lastRainRaw = rainRaw;
    Serial.printf("[sensors] rain sensor -> raw=%s, raining=%s\n",
                  rainRaw == HIGH ? "HIGH" : "LOW", r.raining ? "true" : "false");
  }

  return r;
}
