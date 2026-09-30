"""Room controller enclosure — glued plastic-sheet box.

Generates laser-cut files (per-panel SVG, one nested SVG + DXF sheet) and a
dimensioned PDF drawing set from a single parametric model. Change T (sheet
thickness) or the interior size and re-run: every panel, hole and drawing
follows.

    python3 generate.py            -> ./out/

Construction: butt-jointed panels, solvent-glued. Front/back walls span the
full width; the two side walls fit between them; all four walls stand on
the base. The lid is removable — 4x M3 screws into nut-backed gussets glued
into the top inside corners.

The main PCB (hardware/pcb) hangs component-side up under the lid on M3
standoffs so its OLED sits right under the lid window; the MD0293 relay
board sits on the base, linked by a 20-way ribbon. PCB size, hole
positions and OLED position are imported from hardware/pcb/generate_pcb.py
so the two designs can't drift apart.
"""
import math, os, sys
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

# ---------------- parameters (mm) ----------------
T = 3.0                    # sheet thickness
IW, ID, IH = 250.0, 200.0, 70.0   # interior width (x), depth (y), height (z)
W, D = IW + 2 * T, ID + 2 * T     # base / lid outer size
GAP = 6.0                  # spacing between parts on the nested sheet

PG9, PG7 = 15.2, 12.5      # cable gland hole diameters
M3, M2 = 3.4, 2.2

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pcb"))
import generate_pcb as pcb  # noqa: E402

# ---- main PCB, hanging under the lid (component side up, facing the lid) ----
STANDOFF = 15.0            # lid underside to PCB top; tallest part (ESP32 on sockets) is ~13.3
PCB_W, PCB_D = pcb.BW, pcb.BH
PCB_LX = T + 22            # PCB left edge, lid/base x (clear of the front-left corner gusset)
PCB_FY = T + 2             # PCB front edge, lid/base y (2mm behind the front wall, for USB)
PCB_TOP_Z = IH - STANDOFF  # PCB top surface above the base's top face

def pcb_to_box(px, py):
    """PCB coords (y=0 back edge) -> lid/base coords (y=0 front edge)."""
    return PCB_LX + px, PCB_FY + (PCB_D - py)

USB_X = PCB_LX + pcb.ESP_X
USB_Z = PCB_TOP_Z + 8.5 + 1.6 + 1.5   # socket + ESP32 board + half the micro-USB
OLED_X, OLED_Y = pcb_to_box(pcb.OLED_CX, pcb.OLED_SCREEN_Y)

# ---- MD0293 relay board on the base (180 x 90; holes ASSUMED 172 x 82 c/c) ----
RLY_X0, RLY_Y0, RLY_W, RLY_D = T + 35, T + 92, 180.0, 90.0
RLY_HOLES = [(RLY_X0 + dx, RLY_Y0 + dy) for dx in (4, 176) for dy in (4, 86)]

# Glands sit low (30mm): below the PCB, above the relay board's back edge zone.
GLAND_Z = 30.0

# ---------------- geometry primitives ----------------
class Part:
    def __init__(self, name, w, h, qty=1, note=""):
        self.name, self.w, self.h, self.qty, self.note = name, w, h, qty, note
        self.outline = [(0, 0), (w, 0), (w, h), (0, h)]
        self.cuts = []      # ('circle', cx, cy, d, label) | ('slot', cx, cy, w, h, r, label)
        self.engrave = []   # ('rect', x, y, w, h) | ('text', x, y, size, s)
        self.extra_rows = []  # cut-outs that are part of the outline (notches), for the schedule only

    def hole(self, cx, cy, d, label=""):
        self.cuts.append(('circle', cx, cy, d, label))

    def slot(self, cx, cy, w, h, r, label=""):
        self.cuts.append(('slot', cx, cy, w, h, r, label))

    def text(self, x, y, s, size=4):
        self.engrave.append(('text', x, y, size, s))

    def zone(self, x, y, w, h, label):
        self.engrave.append(('rect', x, y, w, h))
        self.engrave.append(('text', x + w / 2, y + h / 2 - 1.5, 3.5, label))


def rounded_rect_path(cx, cy, w, h, r):
    """Closed polyline (list of points) for a rounded rectangle, CCW."""
    r = min(r, w / 2, h / 2)
    pts = []
    corners = [(cx + w / 2 - r, cy - h / 2 + r, -90), (cx + w / 2 - r, cy + h / 2 - r, 0),
               (cx - w / 2 + r, cy + h / 2 - r, 90), (cx - w / 2 + r, cy - h / 2 + r, 180)]
    for ox, oy, a0 in corners:
        for i in range(9):
            a = math.radians(a0 + i * 90 / 8)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts

# ---------------- the parts ----------------
parts = []

base = Part("BASE", W, D, note="Inside face up. y=0 is the FRONT edge. Relay board holes are ASSUMED - lay the board on its outline and check before drilling.")
for x, y in RLY_HOLES:
    base.hole(x, y, M3, "RELAY BOARD")
base.zone(RLY_X0, RLY_Y0, RLY_W, RLY_D, "MD0293 16-CH RELAY BOARD 180x90 (relay terminals to the BACK)")
for x in (T + 60, T + IW - 60):             # optional wall/shelf fixing
    base.hole(x, T + 50, 4.5, "FIX")
base.text(W / 2, 1.2 + T, "FRONT", 3)
parts.append(base)

lid = Part("LID", W, D, note="Outside face up. y=0 is the FRONT edge. The main PCB hangs under it on 5x M3 x 15 standoffs.")
lid.slot(OLED_X, OLED_Y, 24.0, 17.0, 2.0, "OLED WINDOW")
for px, py in pcb.MOUNT_HOLES:
    lid.hole(*pcb_to_box(px, py), M3, "PCB STANDOFF")
for x in (T + 7, W - T - 7):
    for y in (T + 7, D - T - 7):
        lid.hole(x, y, M3, "LID SCREW")
lid.text(OLED_X, OLED_Y - 15, "PLANT AUTOMATION", 4)
lid.text(W / 2, 1.2 + T, "FRONT", 3)
parts.append(lid)

front = Part("FRONT WALL", W, IH, note="Viewed from OUTSIDE. y=0 is the bottom edge (sits on the base). The USB notch opens at the top edge - the lid closes it.")
NOTCH_W, NOTCH_D = 14.0, IH - (USB_Z - 5.5)
front.outline = [(0, 0), (W, 0), (W, IH), (USB_X + NOTCH_W / 2, IH), (USB_X + NOTCH_W / 2, IH - NOTCH_D),
                 (USB_X - NOTCH_W / 2, IH - NOTCH_D), (USB_X - NOTCH_W / 2, IH), (0, IH)]
front.text(USB_X, IH - NOTCH_D - 6, "USB", 3)
front.extra_rows.append(("N1", USB_X, IH - NOTCH_D / 2, f"{NOTCH_W:g} x {NOTCH_D:.1f} notch", "USB (open at top)"))
parts.append(front)

back = Part("BACK WALL", W, IH, note="Viewed from OUTSIDE. y=0 is the bottom edge. Valve glands take 3 cables each - use multi-hole gland inserts or a 6-core cable.")
for i, lab in enumerate(["12V IN", "5V IN", "PUMP", "VALVES 1-3", "VALVES 4-6"]):
    x = W - (T + 38 + i * 45)       # mirrored: viewed from behind
    back.hole(x, GLAND_Z, PG9, "PG9")
    back.text(x, GLAND_Z - 14, lab, 3)
parts.append(back)

left = Part("LEFT SIDE", ID, IH, note="Viewed from OUTSIDE. Fits between front and back walls; right-hand end is the FRONT.")
for i, lab in enumerate(["DHT22-1", "DHT22-2", "RAIN", "FLOAT LOW", "FLOAT HIGH", "LOAD CELL"]):
    x = ID - (22 + i * 31)
    left.hole(x, GLAND_Z, PG7, "PG7")
    left.text(x, GLAND_Z - 12, lab, 2.6)
parts.append(left)

right = Part("RIGHT SIDE", ID, IH, note="Viewed from OUTSIDE. Vent slots: low row draws air in, high row lets heat out.")
for z in (12, IH - 12):
    for i in range(8):
        right.slot(30 + i * 20, z, 3.0, 12.0, 1.5, "VENT")
parts.append(right)

gusset = Part("GUSSET", 20, 20, qty=8,
              note="Glue 2 stacked per top inside corner, flush with the wall tops; M3 nut under the lower one.")
gusset.outline = [(0, 0), (20, 0), (0, 20)]
gusset.hole(7, 7, M3, "M3")
parts.append(gusset)

# ---------------- nested layout ----------------
def layout():
    placed, x, y, row_h = [], GAP, GAP, 0
    sheet_w = 2 * W + 3 * GAP
    items = [p for p in parts for _ in range(p.qty)]
    for p in items:
        if x + p.w + GAP > sheet_w:
            x, y, row_h = GAP, y + row_h + GAP, 0
        placed.append((p, x, y))
        x += p.w + GAP
        row_h = max(row_h, p.h)
    return placed, sheet_w, y + row_h + GAP

# ---------------- SVG ----------------
CUT, ENG = "#ff0000", "#0000ff"

def svg_part(p, ox, oy, sheet_h):
    """SVG elements for one part; SVG y runs down, drawing y runs up."""
    Y = lambda y: sheet_h - (oy + y)
    out = []
    pts = " ".join(f"{ox + x:.3f},{Y(y):.3f}" for x, y in p.outline)
    out.append(f'<polygon points="{pts}" fill="none" stroke="{CUT}" stroke-width="0.1"/>')
    for c in p.cuts:
        if c[0] == 'circle':
            _, cx, cy, d, _l = c
            out.append(f'<circle cx="{ox + cx:.3f}" cy="{Y(cy):.3f}" r="{d / 2:.3f}" fill="none" stroke="{CUT}" stroke-width="0.1"/>')
        else:
            _, cx, cy, w, h, r, _l = c
            pts = " ".join(f"{ox + x:.3f},{Y(y):.3f}" for x, y in rounded_rect_path(cx, cy, w, h, r))
            out.append(f'<polygon points="{pts}" fill="none" stroke="{CUT}" stroke-width="0.1"/>')
    for e in p.engrave:
        if e[0] == 'rect':
            _, x, y, w, h = e
            out.append(f'<rect x="{ox + x:.3f}" y="{Y(y + h):.3f}" width="{w:.3f}" height="{h:.3f}" fill="none" stroke="{ENG}" stroke-width="0.1" stroke-dasharray="2,1"/>')
        else:
            _, x, y, size, s = e
            out.append(f'<text x="{ox + x:.3f}" y="{Y(y):.3f}" font-family="Arial" font-size="{size}" text-anchor="middle" fill="{ENG}">{s}</text>')
    return out

def write_svg(path, w, h, elements):
    with open(path, "w") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.2f}mm" height="{h:.2f}mm" viewBox="0 0 {w:.2f} {h:.2f}">\n')
        f.write("<!-- RED = cut through, BLUE = engrave/score only. 1 unit = 1 mm. -->\n")
        f.write("\n".join(elements))
        f.write("\n</svg>\n")

# ---------------- DXF (R12, mm) ----------------
def dxf_entities(p, ox, oy):
    e = []
    def poly(points, layer):
        pts = points + [points[0]]
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            e.append(f"0\nLINE\n8\n{layer}\n10\n{ox + x1:.4f}\n20\n{oy + y1:.4f}\n11\n{ox + x2:.4f}\n21\n{oy + y2:.4f}\n")
    poly(p.outline, "CUT")
    for c in p.cuts:
        if c[0] == 'circle':
            _, cx, cy, d, _l = c
            e.append(f"0\nCIRCLE\n8\nCUT\n10\n{ox + cx:.4f}\n20\n{oy + cy:.4f}\n40\n{d / 2:.4f}\n")
        else:
            _, cx, cy, w, h, r, _l = c
            poly(rounded_rect_path(cx, cy, w, h, r), "CUT")
    for en in p.engrave:
        if en[0] == 'rect':
            _, x, y, w, h = en
            poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], "ENGRAVE")
        else:
            _, x, y, size, s = en
            e.append(f"0\nTEXT\n8\nENGRAVE\n10\n{ox + x:.4f}\n20\n{oy + y:.4f}\n40\n{size:.2f}\n1\n{s}\n72\n1\n11\n{ox + x:.4f}\n21\n{oy + y:.4f}\n")
    return e

def write_dxf(path, placed):
    with open(path, "w") as f:
        f.write("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n")
        f.write("0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n"
                "0\nLAYER\n2\nCUT\n70\n0\n62\n1\n6\nCONTINUOUS\n"
                "0\nLAYER\n2\nENGRAVE\n70\n0\n62\n5\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n")
        f.write("0\nSECTION\n2\nENTITIES\n")
        for p, ox, oy in placed:
            f.write("".join(dxf_entities(p, ox, oy)))
        f.write("0\nENDSEC\n0\nEOF\n")

# ---------------- PDF drawing set ----------------
def dim_h(c, x1, x2, y, txt, s):
    c.setLineWidth(0.3); c.line(x1, y, x2, y)
    for x in (x1, x2):
        c.line(x, y - 1.5 * mm, x, y + 1.5 * mm)
    c.setFont("Helvetica", 7); c.drawCentredString((x1 + x2) / 2, y + 1.2 * mm, txt)

def dim_v(c, x, y1, y2, txt):
    c.setLineWidth(0.3); c.line(x, y1, x, y2)
    for y in (y1, y2):
        c.line(x - 1.5 * mm, y, x + 1.5 * mm, y)
    c.saveState(); c.translate(x - 1.2 * mm, (y1 + y2) / 2); c.rotate(90)
    c.setFont("Helvetica", 7); c.drawCentredString(0, 0, txt); c.restoreState()

def title_block(c, pw, title, sheet, total):
    c.setLineWidth(0.8); c.rect(8 * mm, 8 * mm, pw - 16 * mm, A4[0] - 16 * mm)
    c.setFont("Helvetica-Bold", 11); c.drawString(12 * mm, 13 * mm, title)
    c.setFont("Helvetica", 7.5)
    c.drawString(12 * mm, 9.8 * mm, f"Plant Automation room controller enclosure  |  {T:g} mm plastic sheet, glued butt joints  |  all dimensions mm, origin = lower-left of the view")
    c.drawRightString(pw - 12 * mm, 13 * mm, f"Sheet {sheet}/{total}")

def panel_page(c, p, sheet, total):
    pw, ph = landscape(A4)
    title_block(c, pw, f"{p.name}  -  {p.w:g} x {p.h:g} mm" + (f"  (qty {p.qty})" if p.qty > 1 else ""), sheet, total)
    area_w, area_h = pw * 0.52, ph - 50 * mm
    s = min(area_w / (p.w * mm), area_h / (p.h * mm), 1.0)
    ox, oy = 25 * mm, 32 * mm
    X = lambda x: ox + x * mm * s
    Yp = lambda y: oy + y * mm * s
    c.setStrokeColorRGB(0, 0, 0); c.setLineWidth(0.9)
    pts = p.outline + [p.outline[0]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        c.line(X(x1), Yp(y1), X(x2), Yp(y2))
    c.setLineWidth(0.6)
    rows = []
    for i, cut in enumerate(p.cuts):
        if cut[0] == 'circle':
            _, cx, cy, d, lab = cut
            c.circle(X(cx), Yp(cy), d / 2 * mm * s)
            rows.append((f"C{i + 1}", cx, cy, f"dia {d:g}", lab))
        else:
            _, cx, cy, w, h, r, lab = cut
            path = rounded_rect_path(cx, cy, w, h, r) + [rounded_rect_path(cx, cy, w, h, r)[0]]
            for (x1, y1), (x2, y2) in zip(path, path[1:]):
                c.line(X(x1), Yp(y1), X(x2), Yp(y2))
            rows.append((f"C{i + 1}", cx, cy, f"{w:g} x {h:g} R{r:g}", lab))
        c.setFont("Helvetica", 5.5); c.drawString(X(cx) + 1.5 * mm, Yp(cy) + 1.5 * mm, f"C{i + 1}")
    c.setStrokeColorRGB(0.2, 0.3, 0.9); c.setFillColorRGB(0.2, 0.3, 0.9); c.setDash(2, 1.5)
    for e in p.engrave:
        if e[0] == 'rect':
            _, x, y, w, h = e; c.rect(X(x), Yp(y), w * mm * s, h * mm * s)
    c.setDash()
    for e in p.engrave:
        if e[0] == 'text':
            _, x, y, size, txt = e; c.setFont("Helvetica", max(4.5, size * s * 2.2)); c.drawCentredString(X(x), Yp(y), txt)
    c.setStrokeColorRGB(0, 0, 0); c.setFillColorRGB(0, 0, 0)
    dim_h(c, X(0), X(p.w), Yp(p.h) + 6 * mm, f"{p.w:g}", s)
    dim_v(c, X(0) - 7 * mm, Yp(0), Yp(p.h), f"{p.h:g}")
    # hole schedule
    tx, ty = pw * 0.64, ph - 26 * mm
    c.setFont("Helvetica-Bold", 8.5); c.drawString(tx, ty, "Cut-out schedule (centre coordinates)")
    c.setFont("Helvetica-Bold", 7); ty -= 6 * mm
    for colx, h in zip((0, 10, 24, 38, 64), ("ID", "X", "Y", "SIZE", "PURPOSE")):
        c.drawString(tx + colx * mm, ty, h)
    c.setFont("Helvetica", 7)
    for r in rows:
        ty -= 4.3 * mm
        for colx, v in zip((0, 10, 24, 38, 64), (r[0], f"{r[1]:.1f}", f"{r[2]:.1f}", r[3], r[4])):
            c.drawString(tx + colx * mm, ty, v)
    for r in p.extra_rows:
        ty -= 4.3 * mm
        for colx, v in zip((0, 10, 24, 38, 64), (r[0], f"{r[1]:.1f}", f"{r[2]:.1f}", r[3], r[4])):
            c.drawString(tx + colx * mm, ty, v)
    if not rows and not p.extra_rows:
        ty -= 4.3 * mm; c.drawString(tx, ty, "No cut-outs.")
    ty -= 9 * mm
    c.setFont("Helvetica-Oblique", 7.5)
    for line in wrap(p.note, 70):
        c.drawString(tx, ty, line); ty -= 4 * mm
    c.drawString(tx, ty - 2 * mm, f"Drawn at {s:.2f} : 1 - use the numbers, not a ruler on the print.")
    c.showPage()

def wrap(s, n):
    words, lines, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > n:
            lines.append(cur); cur = w
        else:
            cur = (cur + " " + w).strip()
    return lines + ([cur] if cur else [])

def assembly_page(c, sheet, total):
    pw, ph = landscape(A4)
    title_block(c, pw, f"ASSEMBLY  -  outer box {W:g} x {D:g} x {IH + 2 * T:g} mm", sheet, total)
    # exploded isometric sketch
    def iso(x, y, z):
        k = 0.36
        return (x - y) * k * mm, (x + y) * k * 0.5 * mm + z * k * mm
    def box(x0, y0, z0, dx, dy, dz, fill, alpha=1.0):
        c.setFillColorRGB(*fill); c.setFillAlpha(alpha); c.setStrokeColorRGB(0.1, 0.1, 0.1); c.setLineWidth(0.5)
        faces = [[(x0, y0, z0 + dz), (x0 + dx, y0, z0 + dz), (x0 + dx, y0 + dy, z0 + dz), (x0, y0 + dy, z0 + dz)],
                 [(x0, y0, z0), (x0 + dx, y0, z0), (x0 + dx, y0, z0 + dz), (x0, y0, z0 + dz)],
                 [(x0, y0, z0), (x0, y0 + dy, z0), (x0, y0 + dy, z0 + dz), (x0, y0, z0 + dz)]]
        for f in faces:
            p = c.beginPath(); pts = [iso(*v) for v in f]
            p.moveTo(*pts[0]); [p.lineTo(*q) for q in pts[1:]]; p.close(); c.drawPath(p, fill=1)
        c.setFillAlpha(1)
    c.saveState(); c.translate(200 * mm, 40 * mm)
    box(0, 0, 0, W, D, T, (0.85, 0.85, 0.85))                         # base
    box(0, D - T, T, W, T, IH, (0.75, 0.82, 0.9))                      # back
    box(0, T, T, T, ID, IH, (0.75, 0.82, 0.9))                         # left side
    box(RLY_X0, RLY_Y0, T + 6, RLY_W, RLY_D, 20, (0.35, 0.5, 0.8))    # relay board
    box(PCB_LX, PCB_FY, T + IH + 45 - STANDOFF - 1.6, PCB_W, PCB_D, 1.6, (0.3, 0.6, 0.35))  # PCB under the lid
    box(W - T, T, T, T, ID, IH, (0.8, 0.87, 0.95), 0.35)               # right side (see-through)
    box(0, 0, T, W, T, IH, (0.8, 0.87, 0.95), 0.35)                    # front (see-through)
    box(0, 0, T + IH + 45, W, D, T, (0.9, 0.9, 0.9))                   # lid, exploded up
    c.restoreState()
    tx, ty = 12 * mm, ph - 26 * mm
    steps = [
        "1. Cut all parts (RED lines cut through, BLUE lines engrave or just mark). Peel the protective film only where you glue.",
        f"2. Check each part against its drawing sheet. Sheet thickness must be {T:g} mm - thicker sheet changes every size.",
        "3. Fit cable glands, the relay-board standoffs (base) and the 5 PCB standoffs (lid) BEFORE gluing - easier flat.",
        "4. Glue FRONT and BACK walls onto the base (walls stand ON the base, flush with its edges). Use a square to hold 90 deg.",
        "5. Glue LEFT and RIGHT sides between the front and back walls, also standing on the base.",
        "   Acrylic: solvent cement (Weld-On 4 / dichloromethane) with a needle bottle, capillary into the joint.",
        "   PVC / ABS sheet: PVC cement. Polycarbonate or unknown plastic: 2-part epoxy. Avoid superglue - it fogs and cracks.",
        "6. Glue 2 stacked gussets into each top inside corner, top face flush with the wall tops; M3 nut glued under each hole.",
        "7. Let it cure 24 h before mounting boards. Run a thin fillet of glue/silicone along the inside base joints for strength.",
        f"8. Relay board on 4x M3 x 6 standoffs on the base. Main PCB hangs under the lid on 5x M3 x {STANDOFF:g} standoffs, parts facing up.",
        "9. Plug the 20-way ribbon (PCB J20 -> relay inputs) before closing. Lid: 4x M3 x 10 screws into the gusset nuts.",
        "10. Field wiring: flip the lid over on the bench (PCB facing you), land wires on the terminals, leave ~150 mm slack loops.",
    ]
    c.setFont("Helvetica-Bold", 9); c.drawString(tx, ty, "Assembly steps"); ty -= 6 * mm
    c.setFont("Helvetica", 7.6)
    for s_ in steps:
        c.drawString(tx, ty, s_); ty -= 4.6 * mm
    ty -= 3 * mm
    c.setFont("Helvetica-Bold", 9); c.drawString(tx, ty, "Parts list"); ty -= 6 * mm
    c.setFont("Helvetica", 7.6)
    bom = [f"{p.qty} x {p.name}  {p.w:g} x {p.h:g} mm" for p in parts] + [
        "5 x PG9 cable gland (hole 15.2)   6 x PG7 cable gland (hole 12.5)",
        f"5 x M3 x {STANDOFF:g} standoff + 10 x M3 x 6 screw (PCB to lid)   4 x M3 x 6 standoff + 8 x M3 x 6 screw (relay)",
        "4 x M3 x 10 screw + 4 x M3 nut (lid)   20-way IDC ribbon ~150 mm   solvent cement / epoxy",
    ]
    for b in bom:
        c.drawString(tx, ty, b); ty -= 4.3 * mm
    c.showPage()

def section_page(c, sheet, total):
    """Side section (looking from the left): every height that matters."""
    pw, ph = landscape(A4)
    title_block(c, pw, "SECTION A-A  -  heights and clearances (side view from the left, front to the LEFT)", sheet, total)
    s = 0.95
    ox, oy = 28 * mm, 45 * mm
    X = lambda y: ox + y * mm * s
    Z = lambda z: oy + z * mm * s
    def rect(y0, z0, y1, z1, fill, label=None, lab_dy=0):
        c.setFillColorRGB(*fill); c.setStrokeColorRGB(0.15, 0.15, 0.15); c.setLineWidth(0.5)
        c.rect(X(y0), Z(z0), (y1 - y0) * mm * s, (z1 - z0) * mm * s, fill=1)
        if label:
            c.setFillColorRGB(0, 0, 0); c.setFont("Helvetica", 6.5)
            c.drawCentredString(X((y0 + y1) / 2), Z((z0 + z1) / 2) - 2 + lab_dy, label)
    grey, wall = (0.85, 0.85, 0.85), (0.75, 0.82, 0.9)
    lid_z = T + IH
    pcb_top = T + PCB_TOP_Z
    esp_y0, esp_y1 = sorted(pcb_to_box(0, pcb.ESP_TOP_Y - 4.8)[1:] + pcb_to_box(0, pcb.BH - 1)[1:])
    oled_y0, oled_y1 = sorted([pcb_to_box(0, pcb.OLED_SCREEN_Y - 16)[1], pcb_to_box(0, pcb.OLED_SCREEN_Y + 11.3)[1]])
    rect(0, 0, D, T, grey, "BASE")
    rect(0, T, T, lid_z, wall)
    rect(D - T, T, D, lid_z, wall)
    rect(0, lid_z, D, lid_z + T, grey, "LID")
    c.setFillColorRGB(1, 1, 1); c.rect(X(OLED_Y - 8.5), Z(lid_z) - 0.3, 17 * mm * s, T * mm * s + 0.6, fill=1, stroke=0)
    rect(RLY_Y0, T, RLY_Y0 + 3, T + 6, (0.6, 0.6, 0.6)); rect(RLY_Y0 + RLY_D - 3, T, RLY_Y0 + RLY_D, T + 6, (0.6, 0.6, 0.6))
    rect(RLY_Y0, T + 6, RLY_Y0 + RLY_D, T + 26, (0.35, 0.5, 0.8), "MD0293 RELAY BOARD (20 tall)")
    rect(PCB_FY, pcb_top - 1.6, PCB_FY + PCB_D, pcb_top, (0.3, 0.6, 0.35))
    for py in sorted({y for _x, y in pcb.MOUNT_HOLES}):
        yy = pcb_to_box(0, py)[1]
        rect(yy - 2.75, pcb_top, yy + 2.75, lid_z, (0.8, 0.7, 0.3))
    rect(esp_y0, pcb_top, esp_y1, pcb_top + 13.3, (0.25, 0.25, 0.3))
    rect(oled_y0, pcb_top, oled_y1, pcb_top + 11.6, (0.15, 0.15, 0.2))
    rect(D - T - 10, T + GLAND_Z - 10, D - T, T + GLAND_Z + 10, (0.5, 0.5, 0.5))
    c.setFillColorRGB(0, 0, 0); c.setFont("Helvetica", 7)
    notes = [
        (X(D) + 6 * mm, Z(lid_z), f"lid underside  z = {IH:g}"),
        (X(D) + 6 * mm, Z(pcb_top), f"PCB top  z = {PCB_TOP_Z:g}   ({STANDOFF:g} mm standoffs from the lid)"),
        (X(D) + 6 * mm, Z(pcb_top - 1.6) - 9, f"PCB underside z = {PCB_TOP_Z - 1.6:g} - solder tails ~2 mm below"),
        (X(D) + 6 * mm, Z(T + 26), f"relay board top  z = 26  (~{PCB_TOP_Z - 1.6 - 2 - 26:g} mm clear to PCB)"),
        (X(D) + 6 * mm, Z(T + GLAND_Z), f"back/left glands  z = {GLAND_Z:g}"),
        (X(D) + 6 * mm, Z(0), "base top  z = 0"),
    ]
    for x_, y_, t_ in notes:
        c.drawString(x_, y_ - 2, t_)
        c.setDash(1, 2); c.line(X(D) + 1 * mm, y_, x_ - 1 * mm, y_); c.setDash()
    c.setFont("Helvetica", 7)
    c.drawString(X(0), Z(lid_z + T) + 12 * mm, "Dark blocks under the lid: ESP32 on sockets (13.3 tall, front) and OLED (11.6 tall, under the window). Gold: M3 standoffs.")
    c.drawString(X(0), Z(lid_z + T) + 8 * mm, f"OLED glass ~{STANDOFF - 11.6:.1f} mm below the lid window  |  ESP32 top clears the lid by ~{STANDOFF - 13.3:.1f} mm  |  USB notch in the front wall at z = {USB_Z:.1f}")
    c.drawString(X(0), Z(lid_z + T) + 4 * mm, "Tallest parts on the PCB (verify on your modules): ESP32 on 8.5 mm sockets 13.3 | 74HC595 module on sockets ~14.6 | fuse holder ~12 | terminals ~10")
    c.setFont("Helvetica-Bold", 7); c.drawString(X(0), Z(0) - 7 * mm, "FRONT"); c.drawRightString(X(D), Z(0) - 7 * mm, "BACK")
    c.showPage()

def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "out"); os.makedirs(os.path.join(out, "panels"), exist_ok=True)
    for p in parts:
        write_svg(os.path.join(out, "panels", p.name.lower().replace(" ", "-") + ".svg"),
                  p.w + 2, p.h + 2, svg_part(p, 1, 1, p.h + 2))
    placed, sw, sh = layout()
    els = []
    for p, ox, oy in placed:
        els += svg_part(p, ox, oy, sh)
    write_svg(os.path.join(out, "laser-sheet-all-parts.svg"), sw, sh, els)
    write_dxf(os.path.join(out, "laser-sheet-all-parts.dxf"), placed)
    c = canvas.Canvas(os.path.join(out, "enclosure-drawings.pdf"), pagesize=landscape(A4))
    c.setTitle("Room controller enclosure - drawings")
    total = len(parts) + 2
    assembly_page(c, 1, total)
    section_page(c, 2, total)
    for i, p in enumerate(parts):
        panel_page(c, p, i + 3, total)
    c.save()
    print(f"sheet {sw:.0f} x {sh:.0f} mm, outer box {W:g} x {D:g} x {IH + 2 * T:g} mm -> {out}")

if __name__ == "__main__":
    main()
