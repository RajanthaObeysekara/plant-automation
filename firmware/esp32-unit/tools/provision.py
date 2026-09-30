"""Store a board's WiFi/MQTT credentials and identity in its NVS over USB.

The firmware is published publicly (OTA), so none of this is compiled in -
see src/Secrets.h. Values come from ../secrets.local.json (git-ignored):

    {"boards": {"room1": {"port": "/dev/cu.usbserial-0001", "wifi_ssid": "...",
                          "wifi_pass": "...", "mqtt_user": "...", "mqtt_pass": "...",
                          "device_key": "...", "has_tank": "1"}}}

    python3 tools/provision.py room1          # write, verify, reboot
    python3 tools/provision.py room1 --show   # just print what's stored (masked)

Needs pyserial. Only needed once per board (and after a factory reset);
the settings survive every OTA update.
"""
import json, os, sys, time
import serial

HERE = os.path.dirname(os.path.abspath(__file__))
KEYS = ["wifi_ssid", "wifi_pass", "mqtt_user", "mqtt_pass", "device_key", "has_scale",
        "mqtt_host", "mqtt_port", "has_tank", "ota_url"]

def send(ser, line, expect=None, timeout=4.0):
    ser.write((line + "\n").encode())
    end, out = time.time() + timeout, []
    while time.time() < end:
        l = ser.readline().decode("utf-8", "replace").rstrip()
        if l:
            out.append(l)
            if expect and expect in l:
                return out
    return out

def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    name, show_only = sys.argv[1], "--show" in sys.argv
    cfg = json.load(open(os.path.join(HERE, "..", "secrets.local.json")))["boards"][name]
    ser = serial.Serial()
    ser.port, ser.baudrate, ser.timeout = cfg["port"], 115200, 0.2
    ser.dtr = ser.rts = False
    ser.open()
    time.sleep(3)          # opening the port may reset the board; let it boot to its serial loop
    ser.reset_input_buffer()
    if not show_only:
        for k in KEYS:
            if k in cfg:
                r = send(ser, f"secret set {k} {cfg[k]}", expect="[secret]")
                ok = any(f"[secret] ok {k}" in l for l in r)
                print(f"  {k:<10} {'ok' if ok else 'NO REPLY - is the new firmware flashed?'}")
                if not ok:
                    sys.exit(1)
    for l in send(ser, "secret show", expect="[secret] complete"):
        if l.startswith("[secret]"):
            print(" ", l)
    if not show_only:
        send(ser, "reboot", expect="rebooting", timeout=2)
        print(f"{name}: provisioned, rebooting")

if __name__ == "__main__":
    main()
