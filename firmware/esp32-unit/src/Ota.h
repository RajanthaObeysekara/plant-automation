#pragma once
#include <Arduino.h>
#include <functional>

class DisplayDriver;
class CloudClient;

// Over-the-air firmware updates from GitHub Releases (see
// .github/workflows/firmware.yml, which builds, signs and publishes
// firmware.bin + manifest.json on every version tag).
//
// Trust comes from the signature, not the download channel: CI signs
// "<version>\n<sha256 of firmware.bin>" with a private ECDSA P-256 key that
// only exists in GitHub Secrets; this board holds only the public key
// (OtaPublicKey.h). A file that isn't signed by that key, doesn't match its
// hash, or isn't newer than what's running is rejected - so TLS certificate
// checks aren't needed for safety, and GitHub rotating its certificates can
// never break updates.
//
// Safety: the image is written to the inactive OTA slot, so a failed or
// interrupted download never touches the running firmware. After a reboot
// into a new image it stays "pending" until confirmOk() runs; if it
// crashes first, or never gets healthy within OTA_GIVE_UP_AFTER_MS, the
// bootloader goes back to the previous image and that version is
// remembered as bad and skipped.
namespace Ota {
  // Call early in setup(): handles a pending-verify image and a rollback
  // that just happened. Returns a note for the boot splash ("" if none).
  String begin();
  // Call every loop(). `idle` = safe to update now (no misting, pumps off).
  // `prepare` runs right before the download (put outputs in a safe state).
  void loop(bool wifiUp, bool idle, DisplayDriver &oled, CloudClient &cloud,
            const std::function<void()> &prepare);
  // Ask for a check on the next loop() (dashboard/serial command).
  // force=true also lets a dev build (0.0.0-dev) install a release.
  void requestCheck(bool force);
  const char *version();
}
