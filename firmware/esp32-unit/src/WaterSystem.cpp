#include "WaterSystem.h"
#include "Config.h"
#include "RemoteLog.h"

namespace {
enum class FillState { IDLE, FILLING, TIMEOUT };
enum class PumpState { IDLE, OPENING, RUNNING, CLOSING };

ActuatorController *act = nullptr;
bool suspended = false;

// Debounced floats
bool haveLevels = false, lowWet = false, highWet = false;
bool candLow = false, candHigh = false;
unsigned long candLowSince = 0, candHighSince = 0;

FillState fill = FillState::IDLE;
unsigned long fillStartedAt = 0, fillRetryAt = 0;
float fillStartKg = NAN;

PumpState pump = PumpState::IDLE;
unsigned long pumpPhaseAt = 0, pumpRunStartedAt = 0;
int pumpSeconds = 0;
float pumpStartKg = NAN, lastKg = NAN;
int lastRunSec = 0; float lastRunKgVal = NAN; bool lastRunDry = false;

bool sensorFault() { return haveLevels && highWet && !lowWet; }

void log(const char *level, const String &msg) {
  Serial.println("[water] " + msg);
  RemoteLog::add(level, "water: " + msg);
}

void debounce(bool valid, bool rawLow, bool rawHigh, unsigned long now) {
  if (!valid) return;
  if (rawLow != candLow) { candLow = rawLow; candLowSince = now; }
  if (rawHigh != candHigh) { candHigh = rawHigh; candHighSince = now; }
  if (!haveLevels) {   // first reading: take it once both have settled
    if (now - candLowSince >= WATER_FLOAT_DEBOUNCE_MS && now - candHighSince >= WATER_FLOAT_DEBOUNCE_MS) {
      lowWet = candLow; highWet = candHigh; haveLevels = true;
      log("info", String("levels: bottom ") + (lowWet ? "wet" : "dry") + ", top " + (highWet ? "wet" : "dry"));
    }
    return;
  }
  if (candLow != lowWet && now - candLowSince >= WATER_FLOAT_DEBOUNCE_MS) {
    lowWet = candLow;
    log("info", String("bottom sensor -> ") + (lowWet ? "WET (above low mark)" : "DRY (below low mark)"));
  }
  if (candHigh != highWet && now - candHighSince >= WATER_FLOAT_DEBOUNCE_MS) {
    highWet = candHigh;
    log("info", String("top sensor -> ") + (highWet ? "WET (full)" : "DRY"));
  }
}

String kgText(float kg) { return isnan(kg) ? String("") : " (" + String(kg, 1) + " kg)"; }

void stopFill(const String &why) {
  act->setInputValve(false);
  float added = (!isnan(fillStartKg) && !isnan(lastKg)) ? lastKg - fillStartKg : NAN;
  log("info", "input valve CLOSED - " + why + (isnan(added) ? "" : ", +" + String(added, 1) + " kg"));
}

void beginPumpStop(bool dry) {
  act->setPump(false);
  pump = PumpState::CLOSING;
  pumpPhaseAt = millis();
  lastRunSec = (int)((millis() - pumpRunStartedAt) / 1000);
  lastRunKgVal = (!isnan(pumpStartKg) && !isnan(lastKg)) ? pumpStartKg - lastKg : NAN;
  lastRunDry = dry;
  log(dry ? "warn" : "info", String(dry ? "DRY-RUN STOP: water below low mark - pump OFF" : "pump OFF") +
      " after " + String(lastRunSec) + "s" + (isnan(lastRunKgVal) ? "" : ", used " + String(lastRunKgVal, 2) + " kg"));
}

void tickFill(unsigned long now) {
  switch (fill) {
    case FillState::IDLE:
      if (!lowWet && !highWet) {
        fill = FillState::FILLING;
        fillStartedAt = now;
        fillStartKg = lastKg;
        act->setInputValve(true);
        log("info", "water below low mark - input valve OPEN (refilling)" + kgText(lastKg));
      }
      break;
    case FillState::FILLING:
      if (highWet) {
        fill = FillState::IDLE;
        stopFill("bucket full (top sensor)");
      } else if (now - fillStartedAt >= WATER_FILL_TIMEOUT_MS) {
        fill = FillState::TIMEOUT;
        fillRetryAt = now + WATER_FILL_RETRY_MS;
        stopFill("FILL TIMEOUT: top not reached in " + String(WATER_FILL_TIMEOUT_MS / 60000UL) +
                 " min (no mains water? stuck valve? sensor?) - retry in " + String(WATER_FILL_RETRY_MS / 60000UL) + " min");
      }
      break;
    case FillState::TIMEOUT:
      if (highWet || (long)(now - fillRetryAt) >= 0) {
        fill = FillState::IDLE;
        log("info", highWet ? "fill timeout cleared - bucket is full" : "retrying refill after fill timeout");
      }
      break;
  }
}

void tickPump(unsigned long now) {
  switch (pump) {
    case PumpState::IDLE:
      break;
    case PumpState::OPENING:
      if (!lowWet) {   // drained while the valve was opening
        act->setOutputValve(false);
        pump = PumpState::IDLE;
        lastRunSec = 0; lastRunKgVal = NAN; lastRunDry = true;
        log("warn", "pump start cancelled - water below low mark");
      } else if (now - pumpPhaseAt >= WATER_VALVE_LEAD_MS) {
        act->setPump(true);
        pump = PumpState::RUNNING;
        pumpRunStartedAt = now;
        pumpStartKg = lastKg;
        log("info", "pump ON for " + String(pumpSeconds) + "s" + kgText(lastKg));
      }
      break;
    case PumpState::RUNNING:
      if (!lowWet) beginPumpStop(true);
      else if (now - pumpRunStartedAt >= (unsigned long)pumpSeconds * 1000UL) beginPumpStop(false);
      break;
    case PumpState::CLOSING:
      if (now - pumpPhaseAt >= WATER_VALVE_LAG_MS) {
        act->setOutputValve(false);
        pump = PumpState::IDLE;
        log("info", "output valve CLOSED - run complete");
      }
      break;
  }
}
} // namespace

namespace Water {

void begin(ActuatorController *a) {
  act = a;
  act->allOff();
}

void tick(bool valid, bool rawLowWet, bool rawHighWet, float weightKg) {
  unsigned long now = millis();
  lastKg = weightKg;
  debounce(valid, rawLowWet, rawHighWet, now);
  if (!act || suspended || !haveLevels) return;

  if (sensorFault()) {
    if (act->inputValveOpen() || act->outputValveOpen() || act->pumpOn()) {
      act->allOff();
      log("error", "SENSOR FAULT: top wet but bottom dry - everything OFF until it clears");
    }
    if (pump != PumpState::IDLE) { pump = PumpState::IDLE; lastRunDry = true; }
    fill = FillState::IDLE;
    return;
  }
  tickPump(now);
  tickFill(now);
}

bool canPump() {
  return act && !suspended && haveLevels && !sensorFault() && lowWet;
}

bool requestPump(int seconds, String &whyNot) {
  if (!act || suspended) { whyNot = "WATER CTRL OFF"; return false; }
  if (!haveLevels) { whyNot = "LEVELS UNKNOWN"; return false; }
  if (sensorFault()) { whyNot = "SENSOR FAULT"; return false; }
  if (!lowWet) { whyNot = "TANK LOW"; return false; }
  if (pump != PumpState::IDLE) { whyNot = "PUMP BUSY"; return false; }
  pumpSeconds = seconds;
  pump = PumpState::OPENING;
  pumpPhaseAt = millis();
  act->setOutputValve(true);
  log("info", "output valve OPEN - pump starts in " + String(WATER_VALVE_LEAD_MS) + "ms");
  return true;
}

void stopAll(const char *why) {
  if (!act) return;
  bool wasActive = act->inputValveOpen() || act->outputValveOpen() || act->pumpOn();
  act->allOff();
  if (pump == PumpState::RUNNING || pump == PumpState::OPENING) {
    lastRunSec = pump == PumpState::RUNNING ? (int)((millis() - pumpRunStartedAt) / 1000) : 0;
    lastRunKgVal = NAN; lastRunDry = false;
  }
  pump = PumpState::IDLE;
  if (fill == FillState::FILLING) fill = FillState::IDLE;
  if (wasActive) log("warn", String("all water outputs OFF - ") + why);
}

void setSuspended(bool s) {
  if (s && !suspended) stopAll("relay test running");
  if (!s && suspended) log("info", "water control resumed");
  suspended = s;
}

bool pumpBusy() { return pump != PumpState::IDLE; }
bool filling() { return fill == FillState::FILLING; }
bool busy() { return pumpBusy() || filling(); }

String statusText() {
  if (!act || !haveLevels) return "";
  if (suspended) return "RELAY TEST";
  if (sensorFault()) return "FAULT: SENSORS";
  unsigned long now = millis();
  bool pumping = pump != PumpState::IDLE;
  String p = "";
  if (pump == PumpState::RUNNING) {
    long left = (long)pumpSeconds - (long)((now - pumpRunStartedAt) / 1000);
    p = String(max(left, 0L)) + "s";
  }
  if (pumping && fill == FillState::FILLING) return "PMP+FIL " + p;
  if (pump == PumpState::OPENING) return "VALVE OPEN";
  if (pump == PumpState::RUNNING) return "PUMP " + p;
  if (pump == PumpState::CLOSING) return "VALVE CLOSE";
  if (fill == FillState::FILLING) {
    unsigned long s = (now - fillStartedAt) / 1000;
    char buf[16];
    snprintf(buf, sizeof(buf), "FILL %lu:%02lu", s / 60, s % 60);
    return buf;
  }
  if (fill == FillState::TIMEOUT) return "FILL TIMEOUT";
  return "";
}

bool levelsKnown() { return haveLevels; }
bool bottomWet() { return lowWet; }
bool topWet() { return highWet; }
bool suspendedNow() { return suspended; }
const char *fillStateName() {
  return fill == FillState::FILLING ? "filling" : fill == FillState::TIMEOUT ? "timeout" : "idle";
}
const char *pumpStateName() {
  switch (pump) {
    case PumpState::OPENING: return "opening";
    case PumpState::RUNNING: return "running";
    case PumpState::CLOSING: return "closing";
    default: return "idle";
  }
}
int pumpSecondsLeft() {
  if (pump != PumpState::RUNNING) return -1;
  long left = (long)pumpSeconds - (long)((millis() - pumpRunStartedAt) / 1000);
  return (int)max(left, 0L);
}

int lastRunSeconds() { return lastRunSec; }
float lastRunKg() { return lastRunKgVal; }
bool lastRunStoppedDry() { return lastRunDry; }

} // namespace Water
