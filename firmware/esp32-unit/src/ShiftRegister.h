#pragma once
#include <Arduino.h>

// 24-output board (3x 74HC595 cascaded, sold as an LED-matrix driver —
// hence its LDSI/LDSCK/LDSRT/LDEN pin names). Keeps a shadow copy of all
// 24 outputs and pushes the whole frame on every change, since a 595 can't
// set a single output on its own. See Config.h for pins and wiring.
namespace ShiftRegister {
  // Latches every output at its idle (relay-off) level BEFORE enabling
  // them — the external 10k pull-up on LDEN holds the outputs off until
  // this runs, so nothing clicks on at boot.
  void begin();
  void write(uint8_t output, bool high); // output = 0..SR_OUTPUT_COUNT-1 (Q0 = 0)
  bool read(uint8_t output);             // last value written, from the shadow copy
  uint32_t state(); // bit n = output Qn
  uint32_t activeMask(); // bit n set = output Qn is away from its idle level (relay energized)
  void allIdle();        // every output back to its idle (relay-off) level
}
