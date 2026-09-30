#pragma once
#include <Arduino.h>

// MD0020 HX711 24-bit load cell amplifier, channel A (gain 128). Readings
// are sampled whenever the HX711 has one ready (~10/s) and smoothed over
// the last WEIGHT_AVG_SAMPLES with the extremes trimmed, so an occasional
// corrupted conversion can't drag the reading. Calibration (tare offset + counts-per-gram)
// is kept in NVS, so it survives reboots — the tank may already be loaded
// at power-on, so it can't just re-tare on every boot.
namespace WeightSensor {
  void begin();
  void loop();              // call every loop() — non-blocking
  bool present();           // HX711 has produced a reading recently
  bool calibrated();        // a known-weight calibration is stored
  float kg();               // NAN until present() && calibrated()
  long raw();               // smoothed raw counts, tare not applied
  bool saturated();         // pinned at the 24-bit limit — bridge miswired/open, not a real load
  bool zeroing();           // boot re-zero still waiting for the load cells to settle (see Config.h)

  void reset();                       // power-cycle the HX711 (SCK high >60us) and drop old samples
  void tare();                        // current load becomes zero
  bool calibrate(float knownGrams);   // known weight currently on the cell
  void setScale(float countsPerGram); // set the scale directly, e.g. from an offline fit
}
