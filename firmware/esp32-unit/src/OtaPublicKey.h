#pragma once
// Public half of the OTA signing key (ECDSA P-256). Safe to publish: it can
// only VERIFY signatures. The private half lives only in GitHub Secrets
// (OTA_SIGNING_KEY) and ~/.plant-automation/ota_signing_key.pem on the
// maintainer's machine - never in this repo. Replacing this key means every
// board must receive one firmware signed with the OLD key that contains
// the NEW public key before the old key is retired.
static const char OTA_PUBLIC_KEY_PEM[] =
  "-----BEGIN PUBLIC KEY-----\n"
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE24R5VUJcbPl9qm7Ct9Y8UckFaX5v\n"
  "JQkQ5LHRL9Rf1E87n9flaz3bmzZgXFXTC2fzVCzFtVevABEluOm9ZxxorQ==\n"
  "-----END PUBLIC KEY-----\n";
