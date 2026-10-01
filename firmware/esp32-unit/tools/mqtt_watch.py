"""Live view of one board's MQTT traffic (logs, telemetry, events, status,
and the config/commands sent to it), straight from the broker - no USB.

    python3 tools/mqtt_watch.py room1

Broker login and device keys come from ../secrets.local.json (git-ignored).
Needs paho-mqtt.
"""
import json, os, ssl, sys, time
import paho.mqtt.client as mqtt

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
BROKER = ("d9fd015cce0745229fd10077daa3f527.s1.eu.hivemq.cloud", 8883)
C = {"info": "\033[0m", "warn": "\033[33m", "error": "\033[31m", "dim": "\033[90m",
     "tele": "\033[36m", "evt": "\033[35m", "in": "\033[32m", "end": "\033[0m"}

def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "room1"
    boards = json.load(open(os.path.join(HERE, "..", "secrets.local.json")))["boards"]
    me = boards[name]
    key = me["device_key"]
    stamp = lambda: time.strftime("%H:%M:%S")

    def show(color, tag, text):
        print(f"{C['dim']}{stamp()}{C['end']} {color}{tag:<9} {text}{C['end']}", flush=True)

    def on_connect(c, u, flags, rc, props=None):
        show(C["dim"], "broker", f"connected - watching {name} ({key[:8]}...)  Ctrl-C to quit")
        c.subscribe("plant/device/#")

    def on_msg(c, u, m):
        topic = m.topic
        try:
            body = json.loads(m.payload)
        except Exception:
            body = None
        to_me = topic.startswith(f"plant/device/{key}/")
        from_me = isinstance(body, dict) and body.get("deviceKey") == key
        if not (to_me or from_me):
            return
        kind = topic.rsplit("/", 1)[-1]
        if kind == "logs" and isinstance(body, dict):
            for l in body.get("logs") or body.get("lines") or []:   # firmware sends {"logs": [...]}
                lvl = l.get("level", "info") if isinstance(l, dict) else "info"
                msg = l.get("message", "") if isinstance(l, dict) else str(l)
                show(C.get(lvl, C["info"]), f"log/{lvl}", msg)
        elif kind == "telemetry" and isinstance(body, dict):
            parts = []
            if "humidity" in body: parts.append(f"RH {body['humidity']}%")
            if "tempC" in body: parts.append(f"T {body['tempC']}C")
            if "raining" in body: parts.append("RAIN" if body["raining"] else "dry")
            for k in ("waterLow", "waterHigh"):
                if k in body: parts.append(f"{k}={body[k]}")
            show(C["tele"], "telemetry", "  ".join(parts) or json.dumps(body)[:150])
        elif kind in ("events", "status"):
            b = {k: v for k, v in (body or {}).items() if k != "deviceKey"}
            show(C["evt"], kind, json.dumps(b)[:160])
        elif to_me:   # config / commands pushed TO the board
            txt = json.dumps(body)[:160] if body is not None else m.payload[:160].decode("utf-8", "replace")
            show(C["in"], "-> " + kind, txt)
        else:
            show(C["dim"], kind, json.dumps(body)[:160])

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"mac-watch-{name}-{os.getpid()}")
    c.username_pw_set(me["mqtt_user"], me["mqtt_pass"])
    c.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    c.on_connect, c.on_message = on_connect, on_msg
    c.connect(*BROKER)
    try:
        c.loop_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
