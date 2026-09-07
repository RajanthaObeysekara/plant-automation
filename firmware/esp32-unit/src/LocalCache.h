#pragma once
#include "DeviceConfig.h"

// Persists the last-synced config (and pairing details) to NVS flash, so a
// power cycle or a stretch offline doesn't reset the unit to defaults.
namespace LocalCache {

void save(const DeviceConfig &cfg);
DeviceConfig load();

void saveBackendUrl(const String &url);
String loadBackendUrl();

void saveDeviceKey(const String &key);
String loadDeviceKey();

// Epoch seconds of the last time the water tank's inlet valve closed after
// a fill — survives a reboot so the dechlorination wait doesn't silently
// reset (and re-permit misting early) on a power blip.
void saveTankFilledAt(unsigned long epochSeconds);
unsigned long loadTankFilledAt();

} // namespace LocalCache
