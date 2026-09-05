#include "DisplayDriver.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "Config.h"

static Adafruit_SSD1306 display(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
static bool ready = false;

bool DisplayDriver::begin() {
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  ready = display.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDRESS);
  if (!ready) {
    Serial.println("[display] SSD1306 not found — check I2C wiring/address");
    return false;
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.display();
  return true;
}

void DisplayDriver::showReadings(float humidity, float tempC, bool raining, const String &activity) {
  if (!ready) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);

  if (isnan(humidity) || isnan(tempC)) {
    display.println("sensor read failed");
  } else {
    display.printf("H:%.0f%%  T:%.1fC\n", humidity, tempC);
  }
  display.println(raining ? "Rain: locked out" : "Rain: clear");
  display.print(activity == "idle" ? "Status: idle" : ("Status: " + activity).c_str());

  display.display();
}

void DisplayDriver::showStatus(const String &line1, const String &line2) {
  if (!ready) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(line1);
  display.println(line2);
  display.display();
}
