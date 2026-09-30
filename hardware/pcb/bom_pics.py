"""Illustrated BOM: pulls each part's photo, price and stock from the LCSC
store (EasyEDA/JLCPCB's parts store) and lays them out in a PDF.

    python3 bom_pics.py   -> out/bom pics.pdf   (images cached in bom-images/)
"""
import json, os, subprocess
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

HERE = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(HERE, "bom-images")

# (LCSC code, qty, what it is on the board)
PARTS = [
    ("C319202", 2, "U1A, U1B - ESP32 sockets (female 1x19)"),
    ("C9811", 2, "U2-U5 - module sockets, cut from female 1x40 strips (59 pins)"),
    ("C2337", 1, "J16, J21 - spare-pin headers, cut from male 1x40"),
    ("C474881", 14, "J3-J13, J15 + 2 for the 4-way J14 - 2-pos screw terminals"),
    ("C474882", 2, "J1, J2 - DHT22 3-pos screw terminals"),
    ("C3405", 1, "J20 - 2x10 box header for the relay-board ribbon"),
    ("C2977597", 1, "Relay cable - 2x10 IDC plug for J20 (clamp onto 20-way 1.27mm ribbon)"),
    ("C3130", 2, "F2 - pump fuse clips (one pair per 5x20 fuse)"),
    ("C369115", 1, "F1 - 5V resettable fuse, 3A"),
    ("C369100", 6, "F3-F8 - valve resettable fuses, 1.1A"),
    ("C20623822", 1, "D1 - 5V surge protection TVS"),
    ("C284087", 1, "D2 - 12V surge protection TVS"),
    ("C20613324", 1, "D3 - 5V power LED (green, 3mm)"),
    ("C20613323", 1, "D4 - 12V power LED (red, 3mm)"),
    ("C58673", 3, "R1-R3 - 10k pull-ups (DHT22 x2, shift-register enable)"),
    ("C58674", 1, "R4 - 1k, green LED resistor"),
    ("C58682", 1, "R5 - 2.2k, red LED resistor"),
    ("C530584", 1, "C1 - 470uF bulk capacitor on 5V"),
    ("C5291296", 2, "C2, C3 - 100nF decoupling"),
    ("C2457", 7, "Off-board - 1N4007 flyback diode across each pump/valve coil"),
]

def fetch(code):
    raw = subprocess.run(["curl", "-sL", "-m", "20", "-A", "Mozilla/5.0",
                          f"https://wmsc.lcsc.com/ftps/wm/product/detail?productCode={code}"],
                         capture_output=True, text=True).stdout
    r = json.loads(raw)["result"]
    img = None
    imgs = r.get("productImages") or []
    if imgs:
        img = os.path.join(IMG, f"{code}.jpg")
        if not os.path.exists(img):
            subprocess.run(["curl", "-sL", "-m", "30", "-A", "Mozilla/5.0", "-o", img, imgs[0]], check=True)
    ladder = r.get("productPriceList") or []
    unit = ladder[0]["usdPrice"] if ladder else None
    clean = lambda t: (t or "").replace("℃", "°C")   # Helvetica has no ℃ glyph
    return {"model": r["productModel"], "brand": r["brandNameEn"], "desc": clean(r.get("productIntroEn") or r["productNameEn"]),
            "pkg": r.get("encapStandard") or "", "stock": r.get("stockNumber"), "unit": unit,
            "min": ladder[0]["ladder"] if ladder else 1, "img": img}

def wrap(s, n):
    out, cur = [], ""
    for w in s.split():
        if len(cur) + len(w) + 1 > n:
            out.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    return out + ([cur] if cur else [])

def main():
    os.makedirs(IMG, exist_ok=True)
    rows = [(code, qty, use, fetch(code)) for code, qty, use in PARTS]
    path = os.path.join(HERE, "out", "bom pics.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    c.setTitle("Room controller PCB - parts with photos")
    pw, ph = A4
    per_page, row_h = 6, 40 * mm
    total = 0.0
    pages = (len(rows) + per_page - 1) // per_page
    for pi in range(pages):
        c.setFont("Helvetica-Bold", 14)
        c.drawString(15 * mm, ph - 16 * mm, "Room controller PCB v2 - parts from the LCSC / EasyEDA store")
        c.setFont("Helvetica", 8)
        c.drawString(15 * mm, ph - 21 * mm, "Photos, prices and stock pulled live from lcsc.com. Order by the C-number (it is the same part in EasyEDA and JLCPCB).")
        y = ph - 30 * mm
        for code, qty, use, d in rows[pi * per_page:(pi + 1) * per_page]:
            c.setStrokeColorRGB(0.8, 0.8, 0.8); c.setLineWidth(0.5)
            c.rect(15 * mm, y - row_h, pw - 30 * mm, row_h - 2 * mm)
            if d["img"]:
                c.drawImage(d["img"], 17 * mm, y - row_h + 1 * mm, 34 * mm, 34 * mm, preserveAspectRatio=True, mask="auto")
            tx = 56 * mm
            c.setFillColorRGB(0, 0, 0)
            c.setFont("Helvetica-Bold", 12); c.drawString(tx, y - 7 * mm, code)
            c.setFont("Helvetica-Bold", 9); c.drawString(tx + 26 * mm, y - 7 * mm, f"{d['model']}  ({d['brand']})"[:70])
            c.setFont("Helvetica", 8.5)
            c.setFillColorRGB(0.1, 0.35, 0.15); c.drawString(tx, y - 12.5 * mm, use[:95]); c.setFillColorRGB(0, 0, 0)
            ly = y - 17.5 * mm
            for line in wrap(d["desc"], 105)[:2]:
                c.drawString(tx, ly, line); ly -= 4 * mm
            if d["pkg"]:
                c.drawString(tx, ly, f"Package: {d['pkg']}"[:100]); ly -= 4 * mm
            buy = max(qty, d["min"])
            cost = (d["unit"] or 0) * buy
            total += cost
            c.setFont("Helvetica-Bold", 9)
            c.drawString(tx, y - row_h + 3.5 * mm, f"Need {qty}   |   buy {buy} (min {d['min']})   |   ${d['unit']} each  =  ${cost:.2f}   |   stock {d['stock']:,}")
            y -= row_h
        if pi == pages - 1:
            c.setFont("Helvetica-Bold", 11)
            c.drawString(15 * mm, y - 8 * mm, f"Estimated parts total: ${total:.2f} (at LCSC minimum-order quantities, before shipping)")
            c.setFont("Helvetica", 8.5)
            for i, line in enumerate([
                "Buy locally: 10A slow-blow 5x20mm fuse, 5x M3 x 15 standoffs + M3 screws, 30cm of 20-way 1.27mm grey ribbon cable,",
                "20 Dupont female crimp terminals + 1-pin housings for the relay end (or simply 20 female-female Dupont jumpers, 20cm).",
                "Check the C3130 fuse clip spacing (board uses 20.5 mm between clips) against its datasheet before ordering the PCB."]):
                c.drawString(15 * mm, y - 14 * mm - i * 4.2 * mm, line)
        c.setFont("Helvetica", 7.5)
        c.drawRightString(pw - 15 * mm, 10 * mm, f"Page {pi + 1}/{pages}")
        c.showPage()
    c.save()
    print(f"{len(rows)} parts, total ${total:.2f} -> {path}")

if __name__ == "__main__":
    main()
