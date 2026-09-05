#pragma once

// Drives each physical line as a pump+valve pair — a valve is never opened
// without its own pump. The water and feed lines share one fogging
// manifold and never run at once. The fungicide line (optional, opt-in) is
// deliberately separate — it feeds its own coarse nozzle, never the shared
// fine manifold, to avoid clogging it with wettable-powder residue. The
// water inlet is a single valve, not a pump — it opens onto mains/
// rainwater pressure to refill the main tank.
class ActuatorController {
public:
  void begin();
  void startWaterLine();
  void stopWaterLine();
  void startFeedLine();
  void stopFeedLine();
  void startFungicideLine();
  void stopFungicideLine();
  void openWaterInlet();
  void closeWaterInlet();
  void allOff();
};
