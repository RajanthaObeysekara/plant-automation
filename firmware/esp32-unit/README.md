# ESP32 unit firmware

Real firmware for the 38-pin ESP32 dev board, implementing the exact same
protocol as `device-simulator/` (see `backend/src/routes/device.js`):
poll-based REST sync over HTTP(S), a bearer device key, and a local rule
engine that keeps misting on its last-synced config if the backend or
Wi-Fi drops. Flash this to real hardware once the [open items](../../plant-automation-architecture.html#open-items)
hardware swap (DC-rated relay board) is done.

## Wiring

| Signal | ESP32 pin | Notes |
|---|---|---|
| OLED SDA | GPIO 21 | I2C, address `0x3C` |
| OLED SCL | GPIO 22 | |
| DHT22 data | GPIO 4 | needs a 10kΩ pull-up to 3.3V if your module doesn't have one built in |
| Rain sensor digital out | GPIO 16 | polarity varies by board — see `RAIN_ACTIVE_HIGH` in `src/Config.h` |
| Relay CH1 — water pump | GPIO 25 | |
| Relay CH2 — water valve | GPIO 26 | |
| Relay CH3 — fert pump | GPIO 27 | |
| Relay CH4 — fert valve | GPIO 33 | |
| Boot button | GPIO 0 | built into most devkits — hold 3s at power-on to reset pairing |

Relay module logic level defaults to **active-low** (`RELAY_ACTIVE_LOW` in
`src/Config.h`) since that's what most cheap 4-channel boards use — flip it
if yours energizes on HIGH instead. The valve on each line opens slightly
*before* its pump starts, and closes slightly *after* it stops, so the pump
never dead-heads against a closed valve.

**This firmware assumes the DC-rated relay swap from the architecture
doc's open items — do not wire the OMRON SSR currently in the cart to
these outputs.**

## Build & flash

Needs [PlatformIO](https://platformio.org/) (CLI or the VS Code
extension). From this directory:

```bash
pio run                 # compile
pio run -t upload       # flash over USB
pio device monitor      # watch serial logs at 115200 baud
```

## First-time pairing

1. In the web app, go to a room and click **+ Unit** to pair one — this
   generates a device key shown once.
2. Power the ESP32. If it has no saved Wi-Fi, it opens a Wi-Fi access
   point named **`PlantAutomation-Setup`** — connect to it from a phone
   and a captive portal should open (or browse to `192.168.4.1`).
3. Pick your real Wi-Fi network and enter its password, plus:
   - **Backend URL** — `http://<your-computer's-LAN-IP>:4000` for local
     testing against the Docker stack, or `https://<app>.up.railway.app`
     once deployed. Find your LAN IP with `ipconfig` (Windows) and make
     sure port 4000 isn't blocked by the firewall for other devices on
     the network.
   - **Device key** — paste the one from step 1.
4. Save. The unit reboots, connects, and starts syncing — it should show
   up as **online** on the dashboard within a minute.

To re-pair a unit (new Wi-Fi, new device key), hold the boot button for
3 seconds at power-on — this wipes the saved Wi-Fi and pairing and
reopens the setup portal.

## Known simplifications (flagged, not hidden)

- **TLS**: HTTPS requests skip certificate validation (`setInsecure()`).
  Fine for local testing; pin Railway's CA before relying on this for
  anything you'd call secure.
- **Wi-Fi drop mid-run**: there's no active reconnect-and-resume logic
  beyond what WiFiManager/the ESP32 core does automatically. A mist or
  feed cycle already in progress finishes on its own regardless (the
  relays are driven from local state, not from an open connection).
- **DHT22 read failures** are logged and simply skipped for that cycle
  rather than retried immediately — the sensor is polled again next
  cycle, one minute later.
