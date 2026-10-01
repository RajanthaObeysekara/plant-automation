"""Room controller main PCB (v2) — 190 x 130 mm, 2 layers, all through-hole.

Everything plugs into this one board: ESP32 DevKitC-38, DM0054 OLED, the
74HC595 module (outputs 1-16 used), HX711 module and rain-sensor comparator module
(all on sockets), plus screw terminals for the field wiring, 5V and 12V
inputs, a fused 12V distribution (1 pump + 6 valves) and a 2x10 ribbon
header to the MD0293 16-channel relay board.

The board hangs component-side UP under the enclosure lid on 15mm
standoffs, so the OLED sits right under the lid window; the relay board
sits on the enclosure floor, linked by the ribbon.

Module outlines/pin positions marked ASSUMED come from published
dimensions, not measurements — see MODULE_ASSUMPTIONS and re-run once the
real modules are measured. Pin assignments mirror
firmware/esp32-unit/src/Config.h; board position/holes are shared with
hardware/enclosure/generate.py (PCB_* constants there).

    python3 generate_pcb.py   -> ./out/
"""
import os, uuid, csv
from reportlab.lib.pagesizes import A4, A3, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

BW, BH = 190.0, 130.0   # y = 0 is the BACK edge, y = BH the FRONT (USB) edge
P = 2.54

# Published/typical sizes used until the real modules are measured.
MODULE_ASSUMPTIONS = [
    ("ESP32 DevKitC-38 (ESP32-32U)", "55 x 28 mm, pin rows 25.4 mm apart"),
    ("DM0054 0.95in OLED (SSD1331)", "30.7 x 27.3 mm, 7-pin row 2 mm in from the top edge, screen centre 14 mm below the pins"),
    ("74HC595 x3 module (LD* pins)", "70 x 30 mm: 6-pin input row on the left edge, 6-pin cascade row on the right edge, 24 outputs in one row along the front edge"),
    ("HX711 module (MD0020)", "34 x 21 mm: 4-pin GND/DT/SCK/VCC row and 6-pin E+/E-/A-/A+/B-/B+ row, 29 mm apart"),
    ("Rain comparator (MD0019)", "30 x 16 mm: 4-pin VCC/GND/DO/AO row and 2-pin plate row, 25 mm apart"),
    ("MD0293 16-ch relay board", "180 x 90 x 20 mm, 5V, low-level trigger; inputs via 2x10 ribbon (IN1-16, 5V, GND)"),
]

RELAY_NETS = [f"RLY_IN{i}" for i in range(1, 17)]
VALVE_NETS = [f"V{i}_12V" for i in range(1, 7)]
nets = (["", "GND", "+3V3", "+5V", "5V_IN", "LED5_K",
         "+12V", "GND12", "LED12_K", "PUMP_12V"] + VALVE_NETS +
        ["DHT1_DATA", "DHT2_DATA", "FLOAT_LOW", "FLOAT_HIGH",
         "OLED_SCLK", "OLED_MOSI", "OLED_RST", "OLED_DC", "OLED_CS",
         "SR_EN", "SR_DATA", "SR_LATCH", "SR_CLK",
         "HX_DT", "HX_SCK", "LC_EP", "LC_EM", "LC_AM", "LC_AP",
         "RAIN_DO", "RAIN_AO", "RAIN_P1", "RAIN_P2",
         "SPARE_IO36", "SPARE_IO39"] + RELAY_NETS)
NET = {n: i for i, n in enumerate(nets)}
HIGH_CURRENT = ["+12V", "GND12", "PUMP_12V"] + VALVE_NETS
POWER = ["+5V", "5V_IN", "GND", "+3V3"]

# 38-pin ESP32 DevKitC (ESP32-32U clone), viewed from the top, antenna to
# the back, USB to the front edge.
ESP_LEFT = [("3V3", "+3V3"), ("EN", None), ("VP", "SPARE_IO36"), ("VN", "SPARE_IO39"),
            ("34", "RAIN_AO"), ("35", "HX_DT"), ("32", "SR_DATA"), ("33", "OLED_RST"),
            ("25", "SR_LATCH"), ("26", "SR_EN"), ("27", "OLED_CS"), ("14", "OLED_DC"),
            ("12", None), ("GND", "GND"), ("13", "HX_SCK"), ("D2", None), ("D3", None),
            ("CMD", None), ("5V", "+5V")]
ESP_RIGHT = [("GND", "GND"), ("23", "OLED_MOSI"), ("22", "SR_CLK"), ("TX", None), ("RX", None),
             ("21", "DHT2_DATA"), ("GND", "GND"), ("19", "FLOAT_LOW"), ("18", "OLED_SCLK"),
             ("5", None), ("17", "RAIN_DO"), ("16", "FLOAT_HIGH"), ("4", "DHT1_DATA"),
             ("0", None), ("2", None), ("15", None), ("D1", None), ("D0", None), ("CLK", None)]
ESP_X = 30.0                       # USB centre, from the PCB's left edge
ESP_TOP_Y = BH - 5.5 - 18 * P      # last pin 5.5 mm from the front edge

OLED_CX, OLED_SCREEN_Y = 80.0, 98.0   # screen centre (lid window goes here)
MOUNT_HOLES = [(4, 4), (BW - 4, 4), (4, BH - 4), (BW - 4, BH - 4), (95, 74)]

def tid():
    return str(uuid.uuid4())

class FP:
    def __init__(self, ref, value, x, y, kind):
        self.ref, self.value, self.x, self.y, self.kind = ref, value, x, y, kind
        self.pads, self.silk, self.labels, self.circles = [], [], [], []
        self.ref_at = (0, -2.4)

    def pad(self, num, dx, dy, net, shape="circle", size=1.7, drill=1.0):
        self.pads.append((str(num), dx, dy, net, shape, size, drill))

    def box(self, x0, y0, x1, y1):
        self.silk += [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]

    def to_sexpr(self):
        o = [f'  (footprint "PlantCtl:{self.kind}" (layer "F.Cu") (tedit 0) (tstamp {tid()})',
             f'    (at {self.x:.3f} {self.y:.3f})',
             '    (attr through_hole)',
             f'    (fp_text reference "{self.ref}" (at {self.ref_at[0]:.3f} {self.ref_at[1]:.3f}) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))) (tstamp {tid()}))',
             f'    (fp_text value "{self.value}" (at 0 -4) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))) (tstamp {tid()}))']
        for (x1, y1, x2, y2) in self.silk:
            o.append(f'    (fp_line (start {x1:.3f} {y1:.3f}) (end {x2:.3f} {y2:.3f}) (layer "F.SilkS") (width 0.12) (tstamp {tid()}))')
        for (cx, cy, r) in self.circles:
            o.append(f'    (fp_circle (center {cx:.3f} {cy:.3f}) (end {cx + r:.3f} {cy:.3f}) (layer "F.SilkS") (width 0.12) (fill none) (tstamp {tid()}))')
        for (tx, ty, s) in self.labels:
            o.append(f'    (fp_text user "{s}" (at {tx:.3f} {ty:.3f}) (layer "F.SilkS") (effects (font (size 0.8 0.8) (thickness 0.12))) (tstamp {tid()}))')
        for num, dx, dy, net, shape, size, drill in self.pads:
            if shape == "np":
                o.append(f'    (pad "" np_thru_hole circle (at {dx:.3f} {dy:.3f}) (size {size} {size}) (drill {drill}) (layers *.Cu *.Mask) (tstamp {tid()}))')
                continue
            netpart = f' (net {NET[net]} "{net}")' if net else ""
            o.append(f'    (pad "{num}" thru_hole {shape} (at {dx:.3f} {dy:.3f}) (size {size} {size}) (drill {drill}) (layers *.Cu *.Mask){netpart} (tstamp {tid()}))')
        o.append('  )')
        return "\n".join(o)

def row(ref, value, x, y, pins, horizontal=False, labels_side=1, kind="PinSocket"):
    """1xN 2.54mm socket/header; pins = [(label, net)]."""
    f = FP(ref, value, x, y, f"{kind}_1x{len(pins):02d}_P2.54mm")
    L = (len(pins) - 1) * P
    for i, (lab, net) in enumerate(pins):
        dx, dy = (i * P, 0) if horizontal else (0, i * P)
        f.pad(i + 1, dx, dy, net, "rect" if i == 0 else "circle")
        if lab:
            f.labels.append((dx, -2.3 * labels_side, lab) if horizontal else (labels_side * (1.7 + 0.33 * len(lab)), dy, lab))
    if horizontal:
        f.box(-1.27, -1.27, L + 1.27, 1.27); f.ref_at = (-3.6, 0)
    else:
        f.box(-1.27, -1.27, 1.27, L + 1.27); f.ref_at = (0, -2.4)
    return f

def terminal(ref, value, x, y, pins, pitch=5.0, size=2.6, drill=1.3):
    """KF301-5.0 screw terminal (5.0mm pitch, LCSC C474881 2P / C474882 3P),
    wire entry toward the back (y=0) edge. 4-pos = two 2P blocks side by side."""
    f = FP(ref, value, x, y, f"TerminalBlock_1x{len(pins):02d}_P{pitch:.2f}mm")
    for i, (lab, net) in enumerate(pins):
        f.pad(i + 1, i * pitch, 0, net, "rect" if i == 0 else "circle", size, drill)
        f.labels.append((i * pitch, 5.0, lab))
    L = (len(pins) - 1) * pitch
    f.box(-pitch / 2, -4.2, L + pitch / 2, 3.6)
    f.labels.append((L / 2, -3.2, value))
    f.ref_at = (L / 2, -5.3)
    return f

def two_pin(ref, value, x, y, pitch, net1, net2, kind, drill=0.8, size=1.6, body=None, label=True):
    f = FP(ref, value, x, y, kind)
    f.pad(1, 0, 0, net1, "rect", size, drill)
    f.pad(2, pitch, 0, net2, "circle", size, drill)
    if body == "axial":
        f.box(1.6, -1.1, pitch - 1.6, 1.1)
    elif body == "radial":
        f.circles.append((pitch / 2, 0, 4.1)); f.labels.append((-2.2, 0, "+"))
    elif body == "led":
        f.circles.append((pitch / 2, 0, 1.9)); f.labels.append((-1.6, 0, "+"))
    elif body == "fuse":
        f.box(-2.5, -3.2, pitch + 2.5, 3.2)
    else:
        f.silk += [(-0.8, -1.4, pitch + 0.8, -1.4), (-0.8, 1.4, pitch + 0.8, 1.4)]
    if label:
        f.labels.append((pitch / 2, 2.6 if body not in ("radial", "fuse") else 5.0, value))
    f.ref_at = (pitch / 2, -2.4 if body not in ("radial", "fuse") else -4.6)
    return f

def fuse_clips(ref, value, x, y, net1, net2):
    """Pair of 5x20mm fuse clips (LCSC C3130, 2 legs 4.8mm apart each),
    clip centres 20.5mm apart along the fuse. VERIFY against the C3130 datasheet."""
    f = FP(ref, value, x, y, "Fuseholder_Clip-5x20mm_P20.50x4.80mm")
    for k, (cx, net) in enumerate(((0.0, net1), (20.5, net2))):
        f.pad(2 * k + 1, cx, -2.4, net, "rect" if k == 0 else "circle", 2.4, 1.3)
        f.pad(2 * k + 2, cx, 2.4, net, "circle", 2.4, 1.3)
    f.box(-3.0, -4.2, 23.5, 4.2)
    f.labels.append((10.25, 5.4, value))
    f.ref_at = (10.25, -5.4)
    return f

def idc_2x10(ref, x, y):
    """2x10 2.54mm box header, vertical: pin 1 top-left, odd pins left column."""
    f = FP(ref, "RELAY BOARD 2x10", x, y, "IDC_BoxHeader_2x10_P2.54mm")
    names = [f"IN{i}" for i in range(1, 17)] + ["5V", "5V", "GND", "GND"]
    netl = RELAY_NETS + ["+5V", "+5V", "GND", "GND"]
    for i in range(20):
        col, r = i % 2, i // 2
        f.pad(i + 1, col * P, r * P, netl[i], "rect" if i == 0 else "circle")
        f.labels.append((-4.4 - 0.3 * len(names[i]) if col == 0 else P + 4.4 + 0.3 * len(names[i]), r * P, names[i]))
    f.box(-3.2, -5.3, P + 3.2, 9 * P + 5.3)
    f.silk += [(-3.2, 4 * P - 2.2, -2.2, 4 * P - 2.2), (-2.2, 4 * P - 2.2, -2.2, 5 * P + 2.2), (-2.2, 5 * P + 2.2, -3.2, 5 * P + 2.2)]
    f.ref_at = (P / 2, -6.4)
    return f

def mount_hole(ref, x, y):
    f = FP(ref, "M3", x, y, "MountingHole_3.2mm_M3")
    f.pad("", 0, 0, None, "np", 3.2, 3.2)
    f.circles.append((0, 0, 3.0))
    f.ref_at = (0, 4.6)
    return f

fps, outlines = [], []   # outlines: (x0, y0, x1, y1, label) module bodies on silkscreen

# ---- ESP32 ----
for ref, dx, pins, side in (("U1A", -12.7, ESP_LEFT, 1), ("U1B", 12.7, ESP_RIGHT, -1)):
    f = row(ref, "ESP32 socket 1x19", ESP_X + dx, ESP_TOP_Y, pins, labels_side=side)
    fps.append(f)
outlines.append((ESP_X - 14, ESP_TOP_Y - 4.8, ESP_X + 14, BH - 1, "ESP32 DevKitC-38  (USB to front edge)"))

# ---- OLED: 7-pin row, screen centre 14mm in front of it ----
oled_row_y = OLED_SCREEN_Y - 14
fps.append(row("U2", "OLED DM0054", OLED_CX - 3 * P, oled_row_y,
               [("GND", "GND"), ("VCC", "+3V3"), ("SCL", "OLED_SCLK"), ("SDA", "OLED_MOSI"),
                ("RES", "OLED_RST"), ("DC", "OLED_DC"), ("CS", "OLED_CS")], horizontal=True))
outlines.append((OLED_CX - 15.35, oled_row_y - 2, OLED_CX + 15.35, oled_row_y + 25.3, "OLED (ASSUMED 30.7x27.3)"))
outlines.append((OLED_CX - 11.1, OLED_SCREEN_Y - 7.7, OLED_CX + 11.1, OLED_SCREEN_Y + 7.7, "screen"))

# ---- 74HC595 module: body 60..130 x 38..68 ----
SRX, SRY = 60.0, 38.0
fps.append(row("U3A", "595 IN", SRX + 2.54, SRY + 3.65,
               [("LDEN", "SR_EN"), ("GND", "GND"), ("VCC", "+3V3"), ("LDSI", "SR_DATA"),
                ("LDSRT", "SR_LATCH"), ("LDSCK", "SR_CLK")], labels_side=1))
fps.append(row("U3B", "595 CASCADE (NC)", SRX + 67.46, SRY + 3.65, [("", None)] * 6))
# The module has 24 outputs (3 chips); only Q0-Q15 are used - pins 17-24
# of this socket are mechanical only (no net).
fps.append(row("U3C", "595 OUTPUTS (1-16 USED)", SRX + 5.79, SRY + 27.46,
               [(str(i + 1) if i % 4 == 0 else "", RELAY_NETS[i] if i < 16 else None) for i in range(24)], horizontal=True))
outlines.append((SRX, SRY, SRX + 70, SRY + 30, "74HC595 x3 MODULE (ASSUMED 70x30)"))

# ---- Relay ribbon header ----
fps.append(idc_2x10("J20", 150.0, 42.0))

# ---- HX711 module: body 109.5..143.5 x 79.5..100.5 ----
fps.append(row("U4A", "HX711 LOGIC", 112.0, 86.19,
               [("GND", "GND"), ("DT", "HX_DT"), ("SCK", "HX_SCK"), ("VCC", "+3V3")], labels_side=1))
fps.append(row("U4B", "HX711 BRIDGE", 141.0, 83.65,
               [("E+", "LC_EP"), ("E-", "LC_EM"), ("A-", "LC_AM"), ("A+", "LC_AP"), ("B-", None), ("B+", None)], labels_side=-1))
outlines.append((109.5, 79.5, 143.5, 100.5, "HX711 (ASSUMED 34x21)"))

# ---- Rain module: body 109.5..139.5 x 102..118 ----
fps.append(row("U5A", "RAIN LOGIC", 112.0, 106.19,
               [("VCC", "+3V3"), ("GND", "GND"), ("DO", "RAIN_DO"), ("AO", "RAIN_AO")], labels_side=1))
fps.append(row("U5B", "RAIN PLATE", 137.0, 108.73, [("P1", "RAIN_P1"), ("P2", "RAIN_P2")], labels_side=-1))
outlines.append((109.5, 102.0, 139.5, 118.0, "RAIN MODULE (ASSUMED 30x16)"))

# ---- Screw terminals: back edge row (field wiring + power) ----
TY = 8.0
fps += [
    terminal("J1", "DHT22-1", 12, TY, [("3V3", "+3V3"), ("DAT", "DHT1_DATA"), ("GND", "GND")]),
    terminal("J2", "DHT22-2", 30, TY, [("3V3", "+3V3"), ("DAT", "DHT2_DATA"), ("GND", "GND")]),
    terminal("J3", "FLOAT L", 48, TY, [("IO19", "FLOAT_LOW"), ("GND", "GND")]),
    terminal("J4", "FLOAT H", 60, TY, [("IO16", "FLOAT_HIGH"), ("GND", "GND")]),
    terminal("J5", "5V IN", 74, TY, [("+5V", "5V_IN"), ("GND", "GND")]),
    terminal("J6", "12V IN", 86, TY, [("+12", "+12V"), ("0V", "GND12")]),
    terminal("J7", "PUMP", 100, TY, [("+12", "PUMP_12V"), ("0V", "GND12")]),
]
for i in range(6):
    fps.append(terminal(f"J{8 + i}", f"VALVE {i + 1}", 112 + 12 * i, TY, [("+12", VALVE_NETS[i]), ("0V", "GND12")]))
# front edge: load cell + rain plate
fps.append(terminal("J14", "LOAD CELL", 150, BH - 8, [("E+", "LC_EP"), ("E-", "LC_EM"), ("A-", "LC_AM"), ("A+", "LC_AP")]))
fps.append(terminal("J15", "RAIN", 172, BH - 8, [("P1", "RAIN_P1"), ("P2", "RAIN_P2")]))
fps.append(row("J16", "SPARE IN", 61.5, 112.5, [("3V3", "+3V3"), ("GND", "GND"), ("36", "SPARE_IO36"), ("39", "SPARE_IO39")], labels_side=-1, kind="PinHeader"))

# ---- Power protection, indicators, fuses ----
fps += [
    two_pin("F1", "PTC 3A", 70, 19, 5.1, "5V_IN", "+5V", "Fuse_PTC_Radial_P5.10mm", drill=0.9),
    two_pin("D3", "LED 5V", 78, 19, 2.54, "+5V", "LED5_K", "LED_D3.0mm", body="led", label=False),
    two_pin("R4", "1k", 70, 33, 10.16, "LED5_K", "GND", "R_Axial_P10.16mm", body="axial"),
    two_pin("D1", "P6KE6.8A", 70, 26, 12.7, "+5V", "GND", "D_DO-15_P12.70mm", drill=1.0, size=2.0, body="axial"),
    two_pin("D4", "LED 12V", 86, 19, 2.54, "+12V", "LED12_K", "LED_D3.0mm", body="led", label=False),
    two_pin("R5", "2.2k", 86, 25, 10.16, "LED12_K", "GND12", "R_Axial_P10.16mm", body="axial"),
    two_pin("D2", "P6KE18A", 84, 33, 12.7, "+12V", "GND12", "D_DO-15_P12.70mm", drill=1.0, size=2.0, body="axial"),
    fuse_clips("F2", "PUMP FUSE 10A 5x20", 101, 28, "+12V", "PUMP_12V"),
]
for i in range(6):
    fps.append(two_pin(f"F{3 + i}", "PTC 1.1A", 112 + 12 * i, 19, 5.1, "+12V", VALVE_NETS[i], "Fuse_PTC_Radial_P5.10mm", drill=0.9))

# ---- Pull-ups and decoupling (next to the ESP32) ----
fps += [
    two_pin("R1", "10k", 50, 77, 10.16, "DHT1_DATA", "+3V3", "R_Axial_P10.16mm", body="axial"),
    two_pin("R2", "10k", 50, 83.5, 10.16, "DHT2_DATA", "+3V3", "R_Axial_P10.16mm", body="axial"),
    two_pin("R3", "10k", 50, 90, 10.16, "SR_EN", "+3V3", "R_Axial_P10.16mm", body="axial"),
    two_pin("C2", "100nF", 50, 96.5, 5.08, "+3V3", "GND", "C_Disc_P5.08mm"),
    two_pin("C3", "100nF", 50, 103, 5.08, "+5V", "GND", "C_Disc_P5.08mm"),
    two_pin("C1", "470uF 10V", 50, 112, 3.5, "+5V", "GND", "CP_Radial_D8.0mm_P3.50mm", drill=0.9, size=1.8, body="radial"),
]
fps += [mount_hole(f"H{i + 1}", x, y) for i, (x, y) in enumerate(MOUNT_HOLES)]

def write_kicad(path):
    o = ['(kicad_pcb (version 20211014) (generator pcbnew)',
         '  (general (thickness 1.6))',
         '  (paper "A3")',
         '  (layers',
         '    (0 "F.Cu" signal) (31 "B.Cu" signal)',
         '    (32 "B.Adhes" user "B.Adhesive") (33 "F.Adhes" user "F.Adhesive")',
         '    (34 "B.Paste" user) (35 "F.Paste" user)',
         '    (36 "B.SilkS" user "B.Silkscreen") (37 "F.SilkS" user "F.Silkscreen")',
         '    (38 "B.Mask" user) (39 "F.Mask" user)',
         '    (40 "Dwgs.User" user "User.Drawings") (41 "Cmts.User" user "User.Comments")',
         '    (44 "Edge.Cuts" user) (45 "Margin" user)',
         '    (46 "B.CrtYd" user "B.Courtyard") (47 "F.CrtYd" user "F.Courtyard")',
         '    (48 "B.Fab" user) (49 "F.Fab" user)',
         '  )',
         '  (setup (pad_to_mask_clearance 0))']
    for i, n in enumerate(nets):
        o.append(f'  (net {i} "{n}")')
    for f in fps:
        o.append(f.to_sexpr())
    def line(x1, y1, x2, y2, layer, w):
        o.append(f'  (gr_line (start {x1:.2f} {y1:.2f}) (end {x2:.2f} {y2:.2f}) (layer "{layer}") (width {w}) (tstamp {tid()}))')
    def text(x, y, s, size=1.0, layer="F.SilkS"):
        o.append(f'  (gr_text "{s}" (at {x:.2f} {y:.2f}) (layer "{layer}") (tstamp {tid()}) (effects (font (size {size} {size}) (thickness 0.15))))')
    for (x1, y1, x2, y2) in [(0, 0, BW, 0), (BW, 0, BW, BH), (BW, BH, 0, BH), (0, BH, 0, 0)]:
        line(x1, y1, x2, y2, "Edge.Cuts", 0.1)
    for (x0, y0, x1, y1, lab) in outlines:
        for (a, b, c_, d) in [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]:
            line(a, b, c_, d, "F.SilkS", 0.15)
        text((x0 + x1) / 2, y1 - 1.6 if lab != "screen" else (y0 + y1) / 2, lab, 0.9)
    # 12V zone boundary: everything behind this line on the right is the isolated 12V side
    line(83, 14.5, 83, 36.5, "F.SilkS", 0.3); line(83, 36.5, BW - 1, 36.5, "F.SilkS", 0.3)
    text(165, 34.5, "12V SIDE - GND12 isolated from logic GND", 1.0)
    text(166, 74.5, "PLANT AUTOMATION ROOM CTRL v2", 1.2)
    o.append(')')
    open(path, "w").write("\n".join(o) + "\n")

def check_sexpr(path):
    depth, instr = 0, False
    for ch in open(path).read():
        if ch == '"':
            instr = not instr
        elif not instr:
            depth += (ch == '(') - (ch == ')')
            assert depth >= 0, "unbalanced )"
    assert depth == 0 and not instr, "unbalanced file"

def check_overlaps():
    """Pad-to-pad clearance across different footprints (catches placement collisions)."""
    pads = [(f.ref, f.x + dx, f.y + dy, size / 2, net) for f in fps for (_n, dx, dy, net, _s, size, _d) in f.pads]
    bad = []
    for i in range(len(pads)):
        for j in range(i + 1, len(pads)):
            a, b = pads[i], pads[j]
            if a[0] == b[0]:
                continue
            gap = ((a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5 - a[3] - b[3]
            if gap < 0.4:
                bad.append((a[0], b[0], round(gap, 2)))
    for (x, y) in MOUNT_HOLES:     # standoff hex ~5.5mm across
        for p in pads:
            if p[0].startswith("H"):
                continue
            gap = ((p[1] - x) ** 2 + (p[2] - y) ** 2) ** 0.5 - 2.9 - p[3]
            if gap < 0.3:
                bad.append(("standoff", p[0], round(gap, 2)))
    return bad

def write_tables(out):
    with open(os.path.join(out, "netlist.csv"), "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["net", "ref", "pin"])
        for n in nets[1:]:
            for f in fps:
                for num, _dx, _dy, net, *_ in f.pads:
                    if net == n:
                        w.writerow([n, f.ref, num])
    # (refs, part, qty, LCSC code). Every code checked against its lcsc.com listing - see bom_pics.py.
    bom = [("U1A,U1B", "Female header 1x19 2.54mm, 8.5mm tall (ESP32)", 2, "C319202"),
           ("U2", "Female header 1x7 2.54mm (OLED)", 1, "C9811 (cut from 1x40)"),
           ("U3A,U3B", "Female header 1x6 2.54mm (595 in/cascade)", 2, "C9811 (cut from 1x40)"),
           ("U3C", "Female header 1x24 2.54mm (595 outputs)", 1, "C9811 (cut from 1x40)"),
           ("U4A,U5A", "Female header 1x4 2.54mm", 2, "C9811 (cut from 1x40)"),
           ("U4B", "Female header 1x6 2.54mm (HX711 bridge)", 1, "C9811 (cut from 1x40)"),
           ("U5B", "Female header 1x2 2.54mm (rain plate)", 1, "C9811 (cut from 1x40)"),
           ("J1,J2", "Screw terminal KF301-5.0-3P", 2, "C474882"),
           ("J3-J13,J15", "Screw terminal KF301-5.0-2P (17A)", 12, "C474881"),
           ("J14", "Screw terminal 4-pos = 2x KF301-5.0-2P side by side", 2, "C474881"),
           ("J20", "Box header 2x10 2.54mm (IDC)", 1, "C3405"),
           ("(cable)", "Relay cable: 2x10 IDC plug for J20 + 30cm 20-way 1.27mm ribbon + Dupont female ends", 1, "C2977597 (plug); ribbon/Dupont locally"),
           ("J16", "Male pin header 1x4 2.54mm (spare inputs)", 1, "C2337 (cut from 1x40)"),
           ("F1", "PTC resettable fuse, radial, 3A hold, >=6V", 1, "C369115"),
           ("F2", "5x20mm fuse clip (2 per fuse) + 10A slow-blow 5x20 fuse", 2, "C3130"),
           ("F3-F8", "PTC resettable fuse, radial, 1.1A hold, >=16V", 6, "C369100"),
           ("D1", "TVS P6KE6.8A DO-15 (5V rail)", 1, "C20623822"),
           ("D2", "TVS P6KE18A DO-15 (12V rail)", 1, "C284087"),
           ("D3,D4", "LED 3mm green (5V) / red (12V)", 2, "C20613324 green / C20613323 red"),
           ("R1-R3", "Resistor 10k 1/4W axial", 3, "C58673"),
           ("R4", "Resistor 1k 1/4W axial", 1, "C58674"),
           ("R5", "Resistor 2.2k 1/4W axial", 1, "C58682"),
           ("C1", "Electrolytic 470uF 10V, 8x11.5mm, 3.5mm pitch", 1, "C530584"),
           ("C2,C3", "Ceramic 100nF 50V, 5.08mm pitch", 2, "C5291296"),
           ("(off-board)", "1N4007 flyback diode, one across each pump/valve coil", 7, "C2457"),
           ("H1-H5", "M3 x 15 standoff (lid to PCB) + M3 x 6 screws", 5, "hardware store")]
    with open(os.path.join(out, "bom.csv"), "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["refs", "part", "qty", "LCSC / EasyEDA"]); w.writerows(bom)
    return bom

def write_preview(path, bom):
    c = canvas.Canvas(path, pagesize=landscape(A3))
    pw, ph = landscape(A3)
    s = 1.75
    ox, oy = 15 * mm, ph - 22 * mm
    X = lambda x: ox + x * mm * s
    Y = lambda y: oy - y * mm * s
    c.setFont("Helvetica-Bold", 13)
    c.drawString(15 * mm, ph - 14 * mm, f"Room controller main PCB v2 - {BW:g} x {BH:g} mm, 2-layer, component side (faces the lid)  -  drawn {s} : 1")
    c.setFillColorRGB(0.13, 0.4, 0.22); c.rect(X(0), Y(BH), BW * mm * s, BH * mm * s, fill=1, stroke=0)
    c.setFillColorRGB(0.35, 0.22, 0.13); c.setFillAlpha(0.35)
    c.rect(X(83), Y(36.5), (BW - 1 - 83) * mm * s, (36.5 - 0.5) * mm * s, fill=1, stroke=0); c.setFillAlpha(1)
    c.setStrokeColorRGB(1, 1, 1); c.setFillColorRGB(1, 1, 1)
    c.setLineWidth(0.8); c.setDash(3, 2)
    for (x0, y0, x1, y1, lab) in outlines:
        c.rect(X(x0), Y(y1), (x1 - x0) * mm * s, (y1 - y0) * mm * s)
        c.setFont("Helvetica-Oblique", 6); c.drawCentredString(X((x0 + x1) / 2), Y(y1 - 1.6) if lab != "screen" else Y((y0 + y1) / 2), lab)
    c.setDash(); c.setLineWidth(0.5)
    for f in fps:
        for (x1, y1, x2, y2) in f.silk:
            c.line(X(f.x + x1), Y(f.y + y1), X(f.x + x2), Y(f.y + y2))
        for (cx, cy, r) in f.circles:
            c.circle(X(f.x + cx), Y(f.y + cy), r * mm * s)
        c.setFont("Helvetica-Bold", 6); c.drawCentredString(X(f.x + f.ref_at[0]), Y(f.y + f.ref_at[1]) - 2, f.ref)
        c.setFont("Helvetica", 4.2)
        for (tx, ty, lab) in f.labels:
            c.drawCentredString(X(f.x + tx), Y(f.y + ty) - 1.4, lab)
    for f in fps:
        for num, dx, dy, net, shape, size, drill in f.pads:
            hc = net in HIGH_CURRENT
            c.setFillColorRGB(0.95, 0.55, 0.2) if hc else c.setFillColorRGB(0.85, 0.7, 0.3)
            if shape == "rect":
                c.rect(X(f.x + dx) - size / 2 * mm * s, Y(f.y + dy) - size / 2 * mm * s, size * mm * s, size * mm * s, fill=1, stroke=0)
            elif shape != "np":
                c.circle(X(f.x + dx), Y(f.y + dy), size / 2 * mm * s, fill=1, stroke=0)
            c.setFillColorRGB(1, 1, 1) if shape == "np" else c.setFillColorRGB(0.1, 0.1, 0.1)
            c.circle(X(f.x + dx), Y(f.y + dy), drill / 2 * mm * s, fill=1, stroke=0)
    c.setFillColorRGB(1, 1, 1); c.setFont("Helvetica-Bold", 7)
    c.drawCentredString(X(ESP_X), Y(BH) + 3, "USB - FRONT EDGE")
    c.drawCentredString(X(BW / 2), Y(0) - 8, "BACK EDGE - field wiring terminals")
    # right column: assumptions + BOM
    c.setFillColorRGB(0, 0, 0)
    tx, ty = 15 * mm, Y(BH) - 12 * mm
    c.setFont("Helvetica-Bold", 9); c.drawString(tx, ty, "ASSUMED module sizes (replace with measurements):"); ty -= 4.6 * mm
    c.setFont("Helvetica", 7.4)
    for name, d in MODULE_ASSUMPTIONS:
        c.drawString(tx, ty, f"- {name}: {d}"); ty -= 3.8 * mm
    ty -= 2 * mm
    c.setFont("Helvetica-Bold", 9); c.drawString(tx, ty, "Relay ribbon J20 (2x10):"); ty -= 4.6 * mm
    c.setFont("Helvetica", 7.4)
    c.drawString(tx, ty, "pins 1-16 = IN1-IN16 (74HC595 Q0-Q15), 17-18 = +5V (relay VCC & JD-VCC), 19-20 = GND.  Low level = relay ON."); ty -= 3.8 * mm
    c.drawString(tx, ty, "Firmware: pump relay = IN2 (Q1), valve relay = IN3 (Q2) - see Config.h SR_OUT_*."); ty -= 3.8 * mm
    bx, by = pw / 2 + 25 * mm, Y(BH) - 12 * mm
    c.setFont("Helvetica-Bold", 9); c.drawString(bx, by, "Bill of materials"); by -= 4.6 * mm
    c.setFont("Helvetica", 7.2)
    for refs, part, q, code in bom:
        c.drawString(bx, by, f"{q} x {refs}: {part}"[:78]); c.drawString(bx + 118 * mm, by, code[:40]); by -= 3.6 * mm
    c.showPage(); c.save()

def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out, exist_ok=True)
    for old in ("plant-room-controller.kicad_pcb",):
        if os.path.exists(os.path.join(out, old)):
            os.remove(os.path.join(out, old))
    pcb = os.path.join(out, "plant-room-controller-v2.kicad_pcb")
    write_kicad(pcb); check_sexpr(pcb)
    bom = write_tables(out)
    write_preview(os.path.join(out, "pcb-v2-preview-and-bom.pdf"), bom)
    single = [n for n in nets[1:] if sum(p[3] == n for f in fps for p in f.pads) < 2]
    print("footprints:", len(fps), "| pads:", sum(len(f.pads) for f in fps), "| nets:", len(nets) - 1)
    print("single-pad nets:", single)
    print("clearance problems:", check_overlaps())

if __name__ == "__main__":
    main()
