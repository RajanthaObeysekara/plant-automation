#include "ShiftRegister.h"
#include "Config.h"

namespace {
uint32_t frame = 0; // bit n = output Qn
// Idle covers every physical output (unused Q17-Q23 included); only the
// used ones can ever be switched away from it.
const uint32_t physicalMask = (SR_PHYSICAL_OUTPUTS >= 32) ? 0xFFFFFFFFUL : ((1UL << SR_PHYSICAL_OUTPUTS) - 1);
const uint32_t usedMask = (1UL << SR_OUTPUT_COUNT) - 1;
const uint32_t idleFrame = SR_IDLE_HIGH ? physicalMask : 0;

void push() {
  // The first byte shifted in ends up in the chip furthest from the ESP32,
  // so send the last chip's byte first — that leaves bit 0 on Q0 of the
  // chip wired to LDSI.
  digitalWrite(PIN_SR_LATCH, LOW);
  for (int chip = SR_CHIP_COUNT - 1; chip >= 0; chip--) {
    shiftOut(PIN_SR_DATA, PIN_SR_CLOCK, MSBFIRST, (frame >> (chip * 8)) & 0xFF);
  }
  digitalWrite(PIN_SR_LATCH, HIGH);
}
} // namespace

namespace ShiftRegister {

void begin() {
  // Outputs stay disabled (LDEN pull-up) until a known all-off frame is
  // latched — only then are they enabled.
  pinMode(PIN_SR_ENABLE, OUTPUT);
  digitalWrite(PIN_SR_ENABLE, SR_ENABLE_ACTIVE_LOW ? HIGH : LOW);
  pinMode(PIN_SR_DATA, OUTPUT);
  pinMode(PIN_SR_CLOCK, OUTPUT);
  pinMode(PIN_SR_LATCH, OUTPUT);
  digitalWrite(PIN_SR_CLOCK, LOW);
  frame = idleFrame;
  push();
  digitalWrite(PIN_SR_ENABLE, SR_ENABLE_ACTIVE_LOW ? LOW : HIGH);
}

void write(uint8_t output, bool high) {
  if (output >= SR_OUTPUT_COUNT) return;
  uint32_t next = high ? (frame | (1UL << output)) : (frame & ~(1UL << output));
  if (next == frame) return;
  frame = next;
  push();
}

bool read(uint8_t output) {
  return output < SR_OUTPUT_COUNT && (frame >> output) & 1UL;
}

uint32_t state() {
  return frame;
}

void allIdle() {
  frame = idleFrame;
  push();
}

uint32_t activeMask() {
  return (frame ^ idleFrame) & usedMask;
}

} // namespace ShiftRegister
