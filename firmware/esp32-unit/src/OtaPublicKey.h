#pragma once
// Public half of the OTA signing key (ECDSA P-256). Safe to publish: it can
// only VERIFY signatures. The private half lives only in GitHub Secrets
// (OTA_SIGNING_KEY) and ~/.plant-automation/ota_signing_key.pem on the
// maintainer's machine - never in this repo. Replacing this key means every
// board must receive one firmware signed with the OLD key that contains
// the NEW public key before the old key is retired.
static const char OTA_PUBLIC_KEY_PEM[] =
  "-----BEGIN PUBLIC KEY-----\n"
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyzY4WAvYQtpx1EsLCMxGkTk09O/T\n"
  "4LzUapQVWeue5bKzrgl5ULo/MyYvTEluIrixderIgSo/kjnn1BAIQOXX5Q==\n"
  "-----END PUBLIC KEY-----\n";
