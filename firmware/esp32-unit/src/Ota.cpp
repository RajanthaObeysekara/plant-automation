#include "Ota.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <memory>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_ota_ops.h>
#include <mbedtls/md.h>
#include <mbedtls/pk.h>
#include <mbedtls/base64.h>
#include "Config.h"
#include "Secrets.h"
#include "DisplayDriver.h"
#include "CloudClient.h"
#include "RemoteLog.h"
#include "OtaPublicKey.h"

// The Arduino core marks every freshly booted image valid by itself unless
// this returns true - which would disable rollback. We confirm it
// ourselves once the new firmware has proven healthy (Ota::loop).
extern "C" bool verifyRollbackLater() { return true; }

namespace {
const char *NS = "ota";
bool pendingVerify = false;
bool checkRequested = false;
bool forceRequested = false;
unsigned long nextCheckAt = OTA_FIRST_CHECK_DELAY_MS;

const char *runningVersion() {
  return strlen(FW_VERSION) ? FW_VERSION : FW_VERSION_DEV;
}

void log(const char *level, const String &msg) {
  Serial.println("[ota] " + msg);
  RemoteLog::add(level, "ota: " + msg);
}

// "1.4.2" -> comparable triple; anything unparsable counts as 0.0.0.
void parseVersion(const String &v, int out[3]) {
  out[0] = out[1] = out[2] = 0;
  sscanf(v.c_str(), "%d.%d.%d", &out[0], &out[1], &out[2]);
}
bool isNewer(const String &candidate, const String &current) {
  int a[3], b[3];
  parseVersion(candidate, a); parseVersion(current, b);
  for (int i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] > b[i];
  return false;
}

String toHex(const uint8_t *d, size_t n) {
  static const char *h = "0123456789abcdef";
  String s; s.reserve(n * 2);
  for (size_t i = 0; i < n; i++) { s += h[d[i] >> 4]; s += h[d[i] & 15]; }
  return s;
}

// ECDSA P-256 over SHA-256("<version>\n<sha256hex>"), signature base64(DER).
bool signatureValid(const String &version, const String &shaHex, const String &sigB64) {
  uint8_t sig[128]; size_t sigLen = 0;
  if (mbedtls_base64_decode(sig, sizeof(sig), &sigLen, (const uint8_t *)sigB64.c_str(), sigB64.length()) != 0) return false;
  String payload = version + "\n" + shaHex;
  uint8_t hash[32];
  mbedtls_md(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), (const uint8_t *)payload.c_str(), payload.length(), hash);
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = mbedtls_pk_parse_public_key(&pk, (const uint8_t *)OTA_PUBLIC_KEY_PEM, strlen(OTA_PUBLIC_KEY_PEM) + 1) == 0 &&
            mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, hash, sizeof(hash), sig, sigLen) == 0;
  mbedtls_pk_free(&pk);
  return ok;
}

bool httpBegin(HTTPClient &http, WiFiClientSecure &tls, WiFiClient &plain, const String &url) {
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS); // GitHub: /latest/ -> tag -> release-assets host
  http.setTimeout(15000);
  if (url.startsWith("https://")) {
    tls.setInsecure(); // authenticity comes from the signature - see Ota.h
    return http.begin(tls, url);
  }
  return http.begin(plain, url);
}

struct Manifest { String version, url, sha256, sig; int size = 0; };

bool fetchManifest(Manifest &m) {
  String url = Secrets::get("ota_url", OTA_MANIFEST_URL);
  WiFiClientSecure tls; WiFiClient plain; HTTPClient http;
  if (!httpBegin(http, tls, plain, url)) return false;
  int code = http.GET();
  if (code != 200) { log("warn", "manifest HTTP " + String(code)); http.end(); return false; }
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();
  if (err) { log("warn", "manifest unreadable"); return false; }
  m.version = doc["version"] | ""; m.url = doc["url"] | ""; m.sha256 = doc["sha256"] | "";
  m.sig = doc["sig"] | ""; m.size = doc["size"] | 0;
  return m.version.length() && m.url.length() && m.sha256.length() == 64 && m.sig.length() && m.size > 0;
}

// Download straight into the inactive OTA slot, hashing as it streams.
bool install(const Manifest &m, DisplayDriver &oled) {
  String head = String(runningVersion()) + " -> " + m.version;
  oled.showUpdate("DOWNLOADING", head, String(m.size / 1024) + " KB", 0);
  if (!Update.begin(m.size, U_FLASH)) {
    oled.showUpdate("UPDATE FAILED", "no space", "kept " + String(runningVersion()), -1, true);
    log("error", String("Update.begin failed: ") + Update.errorString());
    return false;
  }
  mbedtls_md_context_t md;
  mbedtls_md_init(&md);
  mbedtls_md_setup(&md, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&md);

  // Heap, not static: only needed during an install, so it shouldn't hold
  // 2KB of RAM for the device's whole uptime.
  std::unique_ptr<uint8_t[]> bufOwner(new uint8_t[2048]);
  uint8_t *buf = bufOwner.get();
  const size_t bufSize = 2048;
  int done = 0, lastPct = -1;
  bool writeError = false;

  // Each attempt continues where the last one stopped (Range request), so a
  // flaky link only costs the bytes in flight, not the whole download.
  for (int attempt = 1; attempt <= OTA_DOWNLOAD_ATTEMPTS && done < m.size && !writeError; attempt++) {
    if (attempt > 1) {
      log("warn", "download interrupted at " + String(done / 1024) + " KB - resuming (" + String(attempt) + "/" + String(OTA_DOWNLOAD_ATTEMPTS) + ")");
      oled.showUpdate("DOWNLOADING", head, "reconnecting " + String(attempt) + "/" + String(OTA_DOWNLOAD_ATTEMPTS), lastPct);
      delay(3000);
    }
    WiFiClientSecure tls; WiFiClient plain; HTTPClient http;
    if (!httpBegin(http, tls, plain, m.url)) continue;
    if (done > 0) http.addHeader("Range", "bytes=" + String(done) + "-");
    int code = http.GET();
    if (!((done == 0 && code == 200) || (done > 0 && code == 206))) {
      log("warn", "download HTTP " + String(code));
      http.end();
      continue;
    }
    WiFiClient *stream = http.getStreamPtr();
    unsigned long lastByteAt = millis();
    while (done < m.size && millis() - lastByteAt < OTA_STALL_MS) {
      size_t avail = stream->available();
      if (!avail) {
        if (!stream->connected()) break;
        delay(2);
        continue;
      }
      int n = stream->readBytes(buf, min(avail, bufSize));
      if (n <= 0) continue;
      lastByteAt = millis();
      mbedtls_md_update(&md, buf, n);
      if (Update.write(buf, n) != (size_t)n) { writeError = true; break; }
      done += n;
      int pct = (int)((int64_t)done * 100 / m.size);
      if (pct != lastPct) {
        lastPct = pct;
        oled.showUpdate("DOWNLOADING", head, String(done / 1024) + " / " + String(m.size / 1024) + " KB", pct);
      }
    }
    http.end();
  }
  uint8_t hash[32];
  mbedtls_md_finish(&md, hash);
  mbedtls_md_free(&md);

  auto fail = [&](const String &why) {
    Update.abort();
    oled.showUpdate("UPDATE FAILED", why, "kept " + String(runningVersion()), -1, true);
    log("error", "rejected v" + m.version + ": " + why);
    return false;
  };
  if (writeError) return fail("flash write error");
  if (done != m.size) return fail("download incomplete");
  oled.showUpdate("VERIFYING", head, "checking signature", 100);
  if (toHex(hash, 32) != m.sha256) return fail("checksum mismatch");
  if (!signatureValid(m.version, m.sha256, m.sig)) return fail("bad signature");
  if (!Update.end(true)) return fail(String("image invalid: ") + Update.errorString());

  Preferences p; p.begin(NS, false); p.putString("trying", m.version); p.end();
  oled.showUpdate("INSTALLED", head, "restarting...", 100);
  log("info", "installed v" + m.version + ", restarting");
  return true;
}
} // namespace

namespace Ota {

const char *version() { return runningVersion(); }

String begin() {
  Preferences p; p.begin(NS, false);
  String trying = p.isKey("trying") ? p.getString("trying", "") : "";
  String note = "";
  if (trying.length()) {
    if (trying == runningVersion()) {
      note = "UPDATED";   // confirmation still pending - see loop()
    } else {
      // We restarted into something other than the image we installed:
      // the bootloader rolled back. Never offer that version again.
      p.putString("bad", trying);
      p.remove("trying");
      note = "UPDATE ROLLED BACK";
      log("error", "v" + trying + " failed to start - rolled back to v" + String(runningVersion()));
    }
  }
  p.end();
  esp_ota_img_states_t st;
  if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY) {
    pendingVerify = true;
  }
  Serial.printf("[ota] running v%s%s\n", runningVersion(), pendingVerify ? " (new image, awaiting confirmation)" : "");
  return note;
}

void requestCheck(bool force) {
  checkRequested = true;
  forceRequested = force;
}

void loop(bool wifiUp, bool idle, DisplayDriver &oled, CloudClient &cloud, const std::function<void()> &prepare) {
  unsigned long now = millis();

  // New image: confirm once it has run healthily for a while, or give up.
  if (pendingVerify) {
    if (wifiUp && now > OTA_CONFIRM_AFTER_MS) {
      esp_ota_mark_app_valid_cancel_rollback();
      pendingVerify = false;
      Preferences p; p.begin(NS, false); p.remove("trying"); p.end();
      log("info", "v" + String(runningVersion()) + " confirmed healthy");
    } else if (now > OTA_GIVE_UP_AFTER_MS) {
      log("error", "v" + String(runningVersion()) + " never became healthy - rolling back");
      delay(200);
      esp_ota_mark_app_invalid_rollback_and_reboot();
    }
    return; // no new updates until this one is settled
  }

  if (!wifiUp || (!checkRequested && now < nextCheckAt)) return;
  bool force = forceRequested;
  checkRequested = forceRequested = false;
  nextCheckAt = now + OTA_CHECK_INTERVAL_MS;

  Manifest m;
  if (!fetchManifest(m)) {
    nextCheckAt = now + OTA_FAIL_RETRY_MS;
    return;
  }
  String current = runningVersion();
  Preferences p; p.begin(NS, false); String bad = p.isKey("bad") ? p.getString("bad", "") : ""; p.end();
  bool dev = current == FW_VERSION_DEV;
  if (!isNewer(m.version, current) || m.version == bad || (dev && !force)) {
    Serial.printf("[ota] latest release v%s - nothing to do (running v%s%s)\n", m.version.c_str(), current.c_str(),
                  m.version == bad ? ", that version previously failed" : dev && !force ? ", dev build" : "");
    return;
  }
  if (!idle) {
    log("info", "v" + m.version + " available - waiting for pump/valves to go idle");
    nextCheckAt = now + OTA_BUSY_RETRY_MS;
    return;
  }

  log("info", "updating v" + current + " -> v" + m.version);
  oled.showUpdate("UPDATE FOUND", current + " -> " + m.version, "preparing", -1);
  prepare();
  cloud.pause();   // one TLS session at a time
  delay(300);
  bool ok = install(m, oled);
  delay(ok ? 1500 : 6000);
  ESP.restart();   // success: boot the new image; failure: redraw the normal screen cleanly
}

} // namespace Ota
