#include "DisplayDriver.h"
#include <SPI.h>
#include <string.h>
#include <WiFi.h>
#include <time.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1331.h>
#include "Config.h"

// Bench-tested on this exact board: the hardware SPI peripheral hung/reset
// on any real pixel-data write (command-only bytes during begin() were
// fine — only actual pixel bursts failed), while software (bit-banged) SPI
// on the same pins works reliably, just slower. Hence the 5-pin
// (cs, dc, mosi, sclk, rst) software-SPI constructor here, not the 3-pin
// hardware-SPI one.
static Adafruit_SSD1331 display(PIN_OLED_CS, PIN_OLED_DC, PIN_OLED_MOSI, PIN_OLED_SCLK, PIN_OLED_RST);

#define W OLED_WIDTH
#define H OLED_HEIGHT
#define BAR_H 10
#define CONTENT_Y BAR_H

// ---------- theme colors (RGB565) — restrained, functional palette ----------
#define C_BG      0x0000
#define C_INK     0xFFFF
#define C_MUTED   0x8410
#define C_DATA    0x4D9F  // the one accent used for every live reading — a
                           // single consistent "this is a value" color reads
                           // as more industrial than a rainbow per-metric
#define C_OK      0x2669
#define C_WARN    0xFD40
#define C_CRIT    0xF800
#define C_LINE    0x2104

// ---------- small drawing helpers ----------
static void centerText(const char *s, int y, uint16_t color, uint8_t size = 1) {
  int16_t x1, y1; uint16_t tw, th;
  display.setTextSize(size);
  display.getTextBounds(s, 0, 0, &x1, &y1, &tw, &th);
  int x = (W - (int)tw) / 2;
  if (x < 0) x = 0;
  display.setCursor(x, y);
  display.setTextColor(color);
  display.print(s);
}

// ---------- persistent status bar: wifi icon, clock, sensor dots ----------
static int wifiSignalLevel() {
  int rssi = WiFi.RSSI();
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  if (rssi >= -85) return 1;
  return 0;
}
static void drawWifiIcon(int x, int y, bool connected, int level) {
  for (int i = 0; i < 4; i++) {
    int bh = 2 + i * 2;
    int bx = x + i * 3;
    int by = y + 8 - bh;
    uint16_t c = (connected && i < level) ? C_DATA : C_MUTED;
    display.fillRect(bx, by, 2, bh, c);
  }
}
static void drawStatusBar(const Reading &r) {
  static int lastLevel = -99;
  static bool lastConnected = false;
  static int lastHH = -1, lastMin = -1;
  static bool lastS1 = false, lastS2 = false;
  static bool firstDraw = true;

  bool connected = WiFi.status() == WL_CONNECTED;
  int level = connected ? wifiSignalLevel() : -1;
  if (firstDraw || connected != lastConnected || level != lastLevel) {
    lastConnected = connected; lastLevel = level;
    display.fillRect(0, 0, 15, BAR_H, C_BG);
    drawWifiIcon(2, 0, connected, level);
  }

  struct tm ti;
  // The clock keeps running through WiFi dropouts once it has been set
  // (see TimeSync) — no need to be connected to show it.
  bool haveTime = time(nullptr) > 1700000000 && getLocalTime(&ti, 5);
  int hh = haveTime ? ti.tm_hour : -1;
  int mn = haveTime ? ti.tm_min : -1;
  if (firstDraw || hh != lastHH || mn != lastMin) {
    lastHH = hh; lastMin = mn;
    display.fillRect(17, 0, 34, BAR_H, C_BG);
    char buf[6];
    if (haveTime) snprintf(buf, sizeof(buf), "%02d:%02d", hh, mn);
    else strcpy(buf, "--:--");
    display.setTextColor(C_INK);
    display.setTextSize(1);
    display.setCursor(17, 1);
    display.print(buf);
  }

  if (firstDraw || r.sensor1Valid != lastS1 || r.sensor2Valid != lastS2) {
    lastS1 = r.sensor1Valid; lastS2 = r.sensor2Valid;
    display.fillRect(76, 0, 20, BAR_H, C_BG);
    display.fillCircle(81, 5, 3, r.sensor1Valid ? C_OK : C_CRIT);
    display.fillCircle(91, 5, 3, r.sensor2Valid ? C_OK : C_CRIT);
  }

  firstDraw = false;
}

bool DisplayDriver::begin() {
  display.begin();
  display.setTextWrap(false);
  display.fillScreen(C_BG);
  return true;
}

// ---------- boot / pairing / connecting screens (each shown once) ----------
void DisplayDriver::showBootSplash(const char *version, const String &note) {
  display.fillScreen(C_BG);
  centerText("PLANT AUTOMATION", 14, C_INK);
  display.drawFastHLine(18, 26, W - 36, C_LINE);
  centerText("ROOM CONTROLLER", 32, C_MUTED);
  String v = String("fw ") + version;
  centerText(v.c_str(), 44, C_DATA);
  if (note.length()) centerText(note.c_str(), 54, C_OK);
}

void DisplayDriver::showNotProvisioned() {
  display.fillScreen(C_BG);
  centerText("NOT SET UP", 6, C_WARN);
  centerText("No WiFi / MQTT", 20, C_INK);
  centerText("settings stored.", 30, C_INK);
  centerText("Connect USB and", 44, C_MUTED);
  centerText("run provision.py", 54, C_MUTED);
}

void DisplayDriver::showUpdate(const String &title, const String &line1, const String &line2, int pct, bool error) {
  // Drawn in place each call (progress ticks many times a second), so only
  // the first call of a stage clears the whole panel.
  static String lastTitle = "";
  if (title != lastTitle) {
    lastTitle = title;
    display.fillScreen(C_BG);
    display.fillRect(0, 0, W, 11, error ? C_CRIT : C_DATA);
    display.setTextSize(1);
    display.setTextColor(C_BG);
    int16_t x1, y1; uint16_t tw, th;
    display.getTextBounds(title.c_str(), 0, 0, &x1, &y1, &tw, &th);
    display.setCursor((W - (int)tw) / 2, 2);
    display.print(title);
  }
  display.fillRect(0, 16, W, 20, C_BG);
  centerText(line1.c_str(), 17, C_INK);
  centerText(line2.c_str(), 27, error ? C_CRIT : C_MUTED);
  if (pct >= 0) {
    const int bx = 4, by = 42, bw = W - 8, bh = 9;
    display.drawRect(bx, by, bw, bh, C_LINE);
    display.fillRect(bx + 1, by + 1, (bw - 2) * min(pct, 100) / 100, bh - 2, C_OK);
    display.fillRect(0, 54, W, 8, C_BG);
    String p = String(pct) + "%";
    centerText(p.c_str(), 54, C_INK);
  }
}

void DisplayDriver::showConnecting(const String &ssid) {
  String shown = ssid;
  const int budget = 15; // 90px / 6px-per-char at size 1
  if ((int)shown.length() > budget) shown = shown.substring(0, budget - 2) + "..";

  display.fillScreen(C_BG);
  centerText("CONNECTING", 16, C_DATA);
  centerText(shown.c_str(), 30, C_INK);
}

// ---------- persistent industrial readout: identity/humidity/temp/water/status ----------
// Drawn once (labels, dividers), then only the small value regions are
// erased+redrawn on change — no full-screen clears here, which is what
// caused visible flicker in an earlier version of this display.
#define ROW_IDENTITY_Y 12
#define ROW_HUMIDITY_Y 24
#define ROW_TEMP_Y     33
#define ROW_WATER_Y    42
#define ROW_STATUS_Y   53
#define ROW_OUTPUTS_Y  62 // 2px-tall dot strip on the last two pixel rows, below the status text

static void drawStaticChrome() {
  display.fillScreen(C_BG);
  display.drawFastHLine(0, 21, W, C_LINE);

  display.setTextColor(C_MUTED);
  display.setTextSize(1);
  display.setCursor(4, ROW_HUMIDITY_Y);
  display.print("HUMIDITY");
  display.setCursor(4, ROW_TEMP_Y);
  display.print("TEMP");
  display.setCursor(4, ROW_WATER_Y);
  display.print("WATER");

  display.drawFastHLine(0, 51, W, C_LINE);
}

// Plain lowercase ASCII farm/room identity — replaces an earlier pre-baked
// Sinhala bitmap of the farm name. Redrawn only when it actually changes
// (empty until the first config sync completes), same erase-old/draw-new
// pattern as the value rows below. Truncated the same way showConnecting()
// truncates an oversized SSID — this budget (96px / 6px-per-char = 16
// chars) is a hard display limit, not a style choice.
static void drawIdentity(const String &identity) {
  static String last = "\x01";
  if (identity == last) return;
  last = identity;
  display.fillRect(0, ROW_IDENTITY_Y, W, 8, C_BG);
  String shown = identity;
  const int budget = 16;
  if ((int)shown.length() > budget) shown = shown.substring(0, budget - 2) + "..";
  centerText(shown.c_str(), ROW_IDENTITY_Y, C_MUTED);
}

static void drawRightValue(int y, const String &value, uint16_t color, int *lastWidth) {
  int vw = (int)value.length() * 6;
  int eraseW = vw > *lastWidth ? vw : *lastWidth;
  display.fillRect(W - 4 - eraseW, y, eraseW, 8, C_BG);
  display.setTextColor(color);
  display.setCursor(W - 4 - vw, y);
  display.print(value);
  *lastWidth = vw;
}

void DisplayDriver::update(const Reading &r, const String &activity, bool paused, const String &note,
                            const String &identity, const String &tankState, uint32_t outputsOn) {
  static bool chromeDrawn = false;
  if (!chromeDrawn) {
    chromeDrawn = true;
    drawStaticChrome();
  }

  drawStatusBar(r);
  drawIdentity(identity);

  static String lastHumStr = "\x01", lastTempStr = "\x01", lastWaterStr = "\x01"; // impossible starting value forces the first draw
  static int lastHumW = 0, lastTempW = 0, lastWaterW = 0;

  String humStr = r.valid ? String(r.humidity, 1) + "%" : "--%";
  if (humStr != lastHumStr) {
    lastHumStr = humStr;
    drawRightValue(ROW_HUMIDITY_Y, humStr, r.valid ? C_DATA : C_CRIT, &lastHumW);
  }

  String tempStr = r.valid ? String(r.tempC, 1) + "C" : "--C";
  if (tempStr != lastTempStr) {
    lastTempStr = tempStr;
    drawRightValue(ROW_TEMP_Y, tempStr, r.valid ? C_DATA : C_CRIT, &lastTempW);
  }

  // Unified tank state from all three bench-test sensors — see
  // tankStateLabel() in main.cpp. "" until all three have reported.
  bool anyPresent = tankState.length() > 0;
  String waterStr = anyPresent ? tankState : "--";
  uint16_t waterColor = C_DATA;
  if (tankState == "EMPTY") waterColor = C_WARN;
  else if (tankState == "FULL") waterColor = C_OK;
  else if (tankState == "FAULT") waterColor = C_CRIT;
  else if (!anyPresent) waterColor = C_MUTED;
  if (waterStr != lastWaterStr) {
    lastWaterStr = waterStr;
    drawRightValue(ROW_WATER_Y, waterStr, waterColor, &lastWaterW);
  }

  static String lastStatusStr = "\x01";
  String statusStr;
  uint16_t statusColor;
  if (note.length()) {
    statusStr = note;
    statusColor = C_WARN;
  } else if (paused) {
    statusStr = "PAUSED";
    statusColor = C_WARN;
  } else if (activity == "misting") {
    statusStr = "MISTING";
    statusColor = C_DATA;
  } else {
    statusStr = "IDLE";
    statusColor = C_OK;
  }
  // Rain (MD0019 YL-83/FC-37), bottom-right corner, same row as the status
  // word on the left. Only drawn while actually raining (blank otherwise)
  // rather than a permanent label — some status notes (e.g. "TANK NOT
  // READY", "MIST REQUESTED") already run close to the full 96px width, so
  // reserving the corner unconditionally risks the two colliding.
  static String lastRainStr = "\x01";
  static int lastRainW = 0;
  String rainStr = r.raining ? "RAIN" : "";

  bool statusChanged = statusStr != lastStatusStr;
  if (statusChanged) {
    lastStatusStr = statusStr;
    display.fillRect(0, ROW_STATUS_Y, W, 8, C_BG);
    display.setTextColor(statusColor);
    display.setCursor(4, ROW_STATUS_Y);
    display.print(statusStr);
    lastRainW = 0; // the fillRect above just erased it too — force a redraw below even if rainStr itself hasn't changed
  }
  if (statusChanged || rainStr != lastRainStr) {
    lastRainStr = rainStr;
    drawRightValue(ROW_STATUS_Y, rainStr, C_DATA, &lastRainW);
  }

  // Shift register outputs: 24 dots x 4px pitch = exactly the 96px width.
  // Only dots whose state changed are redrawn.
  static bool outputsDrawn = false;
  static uint32_t lastOutputs = 0;
  uint32_t changed = outputsDrawn ? (outputsOn ^ lastOutputs) : 0xFFFFFFFFUL;
  for (int i = 0; i < SR_OUTPUT_COUNT; i++) {
    if (!((changed >> i) & 1UL)) continue;
    display.fillRect(i * 4 + 1, ROW_OUTPUTS_Y, 2, 2, ((outputsOn >> i) & 1UL) ? C_OK : C_CRIT);
  }
  outputsDrawn = true;
  lastOutputs = outputsOn;
}
