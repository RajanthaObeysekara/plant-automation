#include "WifiSetup.h"
#include <WiFiManager.h>
#include "Config.h"
#include "LocalCache.h"

void WifiSetup::checkForFactoryReset() {
  pinMode(PIN_WIFI_RESET_BUTTON, INPUT_PULLUP);
  if (digitalRead(PIN_WIFI_RESET_BUTTON) != LOW) return;

  Serial.println("[wifi] boot button held — hold for 3s to reset pairing...");
  unsigned long start = millis();
  while (digitalRead(PIN_WIFI_RESET_BUTTON) == LOW) {
    if (millis() - start > 3000) {
      Serial.println("[wifi] resetting Wi-Fi + pairing, restarting");
      WiFiManager wm;
      wm.resetSettings();
      LocalCache::saveBackendUrl("");
      LocalCache::saveDeviceKey("");
      ESP.restart();
    }
    delay(50);
  }
}

void WifiSetup::begin(String &backendUrl, String &deviceKey) {
  String cachedUrl = LocalCache::loadBackendUrl();
  String cachedKey = LocalCache::loadDeviceKey();

  WiFiManager wm;
  WiFiManagerParameter paramBackend("backend", "Backend URL (http://host:4000)", cachedUrl.c_str(), 96);
  WiFiManagerParameter paramKey("devicekey", "Device key (from the web app)", cachedKey.c_str(), 64);
  wm.addParameter(&paramBackend);
  wm.addParameter(&paramKey);

  wm.setConfigPortalTimeout(300); // 5 minutes, then reboot and retry rather than hang forever

  bool connected = wm.autoConnect(WIFI_PORTAL_NAME);
  if (!connected) {
    Serial.println("[wifi] setup portal timed out — restarting to try again");
    ESP.restart();
  }

  backendUrl = String(paramBackend.getValue());
  deviceKey = String(paramKey.getValue());
  backendUrl.trim();
  deviceKey.trim();

  if (backendUrl.length() > 0) LocalCache::saveBackendUrl(backendUrl);
  if (deviceKey.length() > 0) LocalCache::saveDeviceKey(deviceKey);

  if (backendUrl.length() == 0) backendUrl = cachedUrl;
  if (deviceKey.length() == 0) deviceKey = cachedKey;

  Serial.printf("[wifi] connected, IP=%s\n", WiFi.localIP().toString().c_str());
}
