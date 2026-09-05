#pragma once
#include <Arduino.h>

// Wraps WiFiManager: connects with saved Wi-Fi credentials, or opens a
// "PlantAutomation-Setup" access point with a captive portal if none are
// saved yet. The portal also collects the backend URL and device key
// issued when the unit was paired from the web app, so nothing needs to
// be hardcoded or reflashed to onboard a unit.
namespace WifiSetup {

// Blocks until connected (or the portal completes). Fills in the two
// out-params from whatever the operator entered (or what was cached).
void begin(String &backendUrl, String &deviceKey);

// Call once in setup(): holding the BOOT button for 3s wipes saved Wi-Fi
// and pairing details, so the unit can be re-paired without reflashing.
void checkForFactoryReset();

} // namespace WifiSetup
