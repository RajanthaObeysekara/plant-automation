#pragma once
#include "DeviceConfig.h"

// Persists the last-synced config — trigger thresholds, the 7-day plan,
// pairing details — to NVS flash, so a power cycle or a stretch offline
// doesn't reset the unit to defaults or lose the plan it was working from.
namespace LocalCache {

void save(const DeviceConfig &cfg);
DeviceConfig load();

void saveBackendUrl(const String &url);
String loadBackendUrl();

void saveDeviceKey(const String &key);
String loadDeviceKey();

} // namespace LocalCache
