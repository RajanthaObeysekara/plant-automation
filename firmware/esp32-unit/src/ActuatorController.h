#pragma once

// Drives this room's misting line as a pump+valve pair — the valve is
// never opened without its own pump. Feed/fungicide dosing hardware lives
// on the (not yet built) farm controller, not here — see Config.h.
class ActuatorController {
public:
  void begin();
  void startWaterLine();
  void stopWaterLine();
  void allOff();
};
