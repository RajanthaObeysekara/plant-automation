#pragma once
#include <Arduino.h>
#include <vector>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include "DeviceConfig.h"

// One buffered Serial line, batched up and shipped to the dashboard's
// Device Console — see RemoteLog.h for how these get collected.
struct RemoteLogLine {
  String level;
  String message;
};

// Talks to the backend over MQTT (a cloud broker — see MQTT_HOST in
// Config.h), not HTTP. A router on this unit's own WiFi network blocks it
// from reaching a LAN-local backend directly (client/AP isolation); a
// cloud broker sidesteps that since both ends just make normal outbound
// internet connections to it. Also genuinely two-way: config and commands
// arrive the instant the backend publishes them (backend/src/mqtt.js),
// not on this device's next poll.
//
// Topics (all under plant/device/, matching backend/src/mqtt.js):
//   telemetry, status, events, logs   — published here, body carries deviceKey
//   <deviceKey>/config_request        — published here, prompts a fresh config
//   <deviceKey>/config                — subscribed, retained, backend's answer
//   <deviceKey>/commands               — subscribed, pushed the instant one is queued
class CloudClient {
public:
  void begin(const String &deviceKey);
  // Call once per loop() iteration — services the MQTT client (keepalive,
  // incoming messages, reconnects). Without this, nothing here works.
  void loop();

  // Publishes a config_request, then waits (servicing the MQTT client) up
  // to a few seconds for the backend's retained answer to arrive on the
  // <deviceKey>/config topic — turns the pub/sub round trip back into the
  // same synchronous call syncConfig() in main.cpp already expects. Costs
  // a real message each call, so main.cpp only calls this at boot and as
  // an infrequent fallback — see pollPushedConfig() below for the normal,
  // message-free path.
  bool fetchConfig(DeviceConfig &out, bool isBoot);
  // Zero-cost, call every loop() iteration: true (with `out` filled in)
  // the instant the backend proactively re-publishes this device's config
  // (e.g. a Pause/Resume/schedule change) — the device is already
  // subscribed to that topic, so this is a locally-buffered flag check,
  // no network round trip. Returns false, leaving `out` untouched, most of
  // the time. Independent of fetchConfig()'s own request/response pair.
  bool pollPushedConfig(DeviceConfig &out);
  // tankSensorsValid/waterLow/waterHigh: this unit is bench-wired with the
  // farm's tank float switches too (no dedicated farm controller exists
  // yet) — when valid, the backend updates that farm's own water_low/
  // water_full fields and pushes the dashboard's existing tank widget,
  // same as if a real farm device had reported it (see deviceIngest.js).
  bool postTelemetry(float humidity, float tempC, bool raining, int scheduleVersion,
                      bool sensor1Valid = false, float humidity1 = 0, float tempC1 = 0,
                      bool sensor2Valid = false, float humidity2 = 0, float tempC2 = 0,
                      bool tankSensorsValid = false, bool waterLow = false, bool waterHigh = false);
  bool postMistEvent(int durationSeconds, float volumeMl, float humidity, float tempC);
  bool postMistSkipped(const String &reason);
  bool postFungicideReminder(const String &lastSprayedDate);
  bool postFeedReminder(const String &date, int doseMl);
  bool postStatus(const String &activity);
  // Drains whatever commands have arrived (pushed) since the last call —
  // no network round trip here, they've already been received in the
  // background by loop().
  std::vector<String> pollCommands();
  bool postLogs(const RemoteLogLine *lines, int count);

  bool connected() { return _mqtt.connected(); }
  // Drops the broker session and stays offline until resume() — used
  // around an OTA download so two TLS sessions never compete for heap.
  void pause() { _paused = true; _mqtt.disconnect(); }
  void resume() { _paused = false; }

private:
  String _deviceKey;
  String _host;
  bool _paused = false;
  WiFiClientSecure _secureClient;
  PubSubClient _mqtt;
  unsigned long _lastConnectAttempt = 0;
  unsigned long _connectedAt = 0;
  // Backs off exponentially on connections that die quickly (capped) so a
  // broker that keeps closing the session — see the long comment in
  // CloudClient.cpp — can't turn into a tight reconnect storm that hammers
  // the broker and floods the serial UART. Only resets once a connection
  // actually stays up a while, not just on a "successful" connect() call.
  unsigned long _reconnectIntervalMs = 3000UL;

  bool _configReceived = false; // consumed by fetchConfig()'s own wait loop
  bool _configDirty = false;    // consumed by pollPushedConfig() — tracked independently so the two never interfere
  String _configJson;
  std::vector<String> _pendingCommands;

  bool ensureConnected();
  bool publish(const char *topic, const String &body);
  bool parseConfigJson(const String &json, DeviceConfig &out);
  void handleMessage(char *topic, uint8_t *payload, unsigned int length);
  static void staticCallback(char *topic, uint8_t *payload, unsigned int length);
};
