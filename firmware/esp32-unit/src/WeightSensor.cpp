#include "WeightSensor.h"
#include <Preferences.h>
#include <algorithm>
#include "Config.h"

namespace {
long samples[WEIGHT_AVG_SAMPLES];
int sampleCount = 0, sampleNext = 0;
unsigned long lastSampleAt = 0;
bool everSampled = false;
bool bootZeroPending = true;
unsigned long firstSampleAt = 0;

long offset = 0;              // raw counts at zero load
float countsPerGram = 0;      // 0 = not calibrated

portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// One conversion: 24 data bits MSB-first, then a 25th pulse selecting
// channel A / gain 128 for the next one. Interrupts stay off for the ~50us
// burst — if SCK sits HIGH for >60us the HX711 powers itself down.
long readRaw() {
  uint32_t v = 0;
  portENTER_CRITICAL(&mux);
  for (int i = 0; i < 24; i++) {
    digitalWrite(PIN_HX711_SCK, HIGH);
    delayMicroseconds(1);
    v = (v << 1) | (uint32_t)digitalRead(PIN_HX711_DT);
    digitalWrite(PIN_HX711_SCK, LOW);
    delayMicroseconds(1);
  }
  digitalWrite(PIN_HX711_SCK, HIGH);
  delayMicroseconds(1);
  digitalWrite(PIN_HX711_SCK, LOW);
  portEXIT_CRITICAL(&mux);
  if (v & 0x800000) v |= 0xFF000000; // sign-extend 24-bit two's complement
  return (long)(int32_t)v;
}

// Trimmed mean: drop the lowest and highest quarter, average the rest.
long rawAvg() {
  if (sampleCount == 0) return 0;
  long sorted[WEIGHT_AVG_SAMPLES];
  memcpy(sorted, samples, sampleCount * sizeof(long));
  std::sort(sorted, sorted + sampleCount);
  int trim = sampleCount / 4;
  int64_t sum = 0;
  for (int i = trim; i < sampleCount - trim; i++) sum += sorted[i];
  return (long)(sum / (sampleCount - 2 * trim));
}

// Called once per second: nudge the zero point toward the current reading
// while it is within WEIGHT_ZERO_TRACK_BAND_KG of zero. Not persisted —
// NVS keeps the last explicit tare, this only follows short-term drift.
void trackZero() {
  static unsigned long lastAt = 0;
  if (millis() - lastAt < 1000) return;
  lastAt = millis();
  if (bootZeroPending || countsPerGram == 0 || sampleCount < WEIGHT_AVG_SAMPLES) return;
  float deltaKg = (rawAvg() - offset) / countsPerGram / 1000.0f;
  if (fabsf(deltaKg) > WEIGHT_ZERO_TRACK_BAND_KG) return;
  float stepKg = constrain(deltaKg, -WEIGHT_ZERO_TRACK_RATE_KG_PER_S, WEIGHT_ZERO_TRACK_RATE_KG_PER_S);
  offset += (long)(stepKg * 1000.0f * countsPerGram);
}

// Boot re-zero: once the window is full and settled, the current load
// becomes 0 kg (see WEIGHT_BOOT_TARE_* in Config.h).
void bootZero() {
  if (!bootZeroPending || sampleCount < WEIGHT_AVG_SAMPLES) return;
  unsigned long waited = millis() - firstSampleAt;
  if (waited < WEIGHT_BOOT_TARE_SETTLE_MS) return;
  long lo = samples[0], hi = samples[0];
  for (int i = 1; i < sampleCount; i++) { lo = min(lo, samples[i]); hi = max(hi, samples[i]); }
  // Uncalibrated: no grams to judge stability by, so just take the settled window.
  bool stable = countsPerGram == 0 || (hi - lo) / fabsf(countsPerGram) / 1000.0f < WEIGHT_BOOT_TARE_STABLE_KG;
  if (!stable && waited < WEIGHT_BOOT_TARE_MAX_WAIT_MS) return;
  offset = rawAvg();
  bootZeroPending = false;
  Serial.printf("[weight] boot zero: load at power-up is now 0 kg (offset=%ld, %s)\n",
                offset, stable ? "settled" : "not fully settled - took it anyway");
}

void save() {
  Preferences p;
  p.begin(NVS_WEIGHT_NAMESPACE, false);
  p.putLong("offset", offset);
  p.putFloat("cpg", countsPerGram);
  p.end();
}
} // namespace

namespace WeightSensor {

void begin() {
  pinMode(PIN_HX711_SCK, OUTPUT);
  digitalWrite(PIN_HX711_SCK, LOW); // LOW = powered up
  pinMode(PIN_HX711_DT, INPUT);
  // No reset() here: powering the HX711 down also cuts the load cells'
  // excitation, and they then drift for minutes while warming back up.

  Preferences p;
  p.begin(NVS_WEIGHT_NAMESPACE, false);
  offset = p.isKey("offset") ? p.getLong("offset", 0) : 0;
  countsPerGram = p.isKey("cpg") ? p.getFloat("cpg", 0) : 0;
  p.end();
  Serial.printf("[weight] HX711 on DT=GPIO%d SCK=GPIO%d, %s\n", PIN_HX711_DT, PIN_HX711_SCK,
                countsPerGram != 0 ? "calibration loaded from NVS" : "NOT calibrated — send 'tare' then 'cal <grams>' over serial");
}

void loop() {
  // DT goes LOW when a conversion is ready.
  if (digitalRead(PIN_HX711_DT) != LOW) return;
  long v = readRaw();
  samples[sampleNext] = v;
  sampleNext = (sampleNext + 1) % WEIGHT_AVG_SAMPLES;
  if (sampleCount < WEIGHT_AVG_SAMPLES) sampleCount++;
  lastSampleAt = millis();
  if (!everSampled) {
    everSampled = true;
    firstSampleAt = lastSampleAt;
    Serial.printf("[weight] HX711 responding, first raw=%ld\n", v);
  }
  bootZero();
  trackZero();
}

void reset() {
  digitalWrite(PIN_HX711_SCK, HIGH);
  delayMicroseconds(200); // >60us HIGH = power down
  digitalWrite(PIN_HX711_SCK, LOW); // back up, channel A / gain 128
  sampleCount = 0;
  sampleNext = 0;
  everSampled = false;
  Serial.println("[weight] HX711 reset");
}

bool zeroing() {
  return bootZeroPending;
}

bool present() {
  return everSampled && millis() - lastSampleAt < WEIGHT_STALE_MS;
}

bool calibrated() {
  return countsPerGram != 0;
}

long raw() {
  return rawAvg();
}

bool saturated() {
  // Full scale is +/-8388607; anything this close is the input clipping.
  long r = raw();
  return r >= 8380000L || r <= -8380000L;
}

float kg() {
  if (!present() || !calibrated() || saturated() || bootZeroPending) return NAN;
  float v = (raw() - offset) / countsPerGram / 1000.0f;
  return fabsf(v) < WEIGHT_ZERO_DEADBAND_KG ? 0.0f : v;
}

void tare() {
  offset = raw();
  save();
  Serial.printf("[weight] tared, offset=%ld\n", offset);
}

bool calibrate(float knownGrams) {
  long delta = raw() - offset;
  if (knownGrams <= 0 || delta == 0) return false;
  countsPerGram = delta / knownGrams;
  save();
  Serial.printf("[weight] calibrated: %.3f counts/g (%ld counts for %.1f g)\n", countsPerGram, delta, knownGrams);
  return true;
}

void setScale(float cpg) {
  countsPerGram = cpg;
  save();
  Serial.printf("[weight] scale set: %.3f counts/g\n", countsPerGram);
}

} // namespace WeightSensor
