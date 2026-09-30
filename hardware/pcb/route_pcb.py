"""Grid autorouter for the room controller PCB (2 layers, Manhattan).

Reads the placed board from generate_pcb.py, routes every net on a 0.5mm
grid with A* (bend + via costs, top layer prefers horizontal runs, bottom
prefers vertical), and writes:
  out/plant-room-controller-v2-routed.kicad_pcb   tracks + vias included
  out/pcb-v2-routed.pdf                           top / bottom / both layers

Clearance model: 0.3mm signal tracks on a 0.5mm pitch leave 0.2mm between
neighbouring tracks (JLCPCB minimum is 0.127mm). Wider nets reserve a
(2k+1)-cell-wide corridor; pads keep a 0.35mm halo against other nets.

    python3 route_pcb.py
"""
import heapq, math, os, uuid
from array import array
import generate_pcb as pcb

G = 0.5
NX, NY = int(pcb.BW / G) + 1, int(pcb.BH / G) + 1
NL = 2                       # 0 = F.Cu (top), 1 = B.Cu (bottom)
N = NL * NX * NY
TRACK = 0.3
CLEAR = 0.2
EDGE = 0.6                   # copper keep-back from the board edge
VIA_COST, BEND_COST, OFFDIR_COST = 12.0, 1.0, 2.5

# Corridor half-width in cells, per net: width = TRACK + 2k*G
WIDE = {"+12V": 3, "GND12": 3, "PUMP_12V": 3,
        "+5V": 1, "5V_IN": 1, "GND": 1, "+3V3": 1}
for v in pcb.VALVE_NETS:
    WIDE[v] = 1

def width_of(net):
    return TRACK + 2 * WIDE.get(net, 0) * G

occ = array('i', [0]) * N    # 0 free, >0 net id, -1 obstacle
halo = array('i', [0]) * N   # 0 none, >0 net id, -1 several nets

def cell(l, i, j):
    return (l * NY + j) * NX + i

def mark_halo(idx, n):
    h = halo[idx]
    if h == 0:
        halo[idx] = n
    elif h != n:
        halo[idx] = -1

# ---- obstacles: board edge margin, mounting holes (standoff hex ~5.5mm) ----
for l in range(NL):
    for j in range(NY):
        for i in range(NX):
            x, y = i * G, j * G
            if x < EDGE or y < EDGE or x > pcb.BW - EDGE or y > pcb.BH - EDGE:
                occ[cell(l, i, j)] = -1
            for hx, hy in pcb.MOUNT_HOLES:
                if (x - hx) ** 2 + (y - hy) ** 2 < 3.2 ** 2:
                    occ[cell(l, i, j)] = -1

# ---- pads ----
pads = []   # (ref, pin, x, y, half, shape, net_id)
nc_pads = []  # unconnected pins (ESP32 EN/TX/RX/..., cascade, HX711 B-/B+): copper, but no net
for f in pcb.fps:
    for num, dx, dy, net, shape, size, drill in f.pads:
        if shape == "np":
            continue
        (pads if net else nc_pads).append((f.ref, num, f.x + dx, f.y + dy, size / 2, shape, pcb.NET[net] if net else 0))

def pad_cells(x, y, half, shape, grow=0.0):
    r = half + grow
    out = []
    for j in range(max(0, int((y - r) / G) - 1), min(NY, int((y + r) / G) + 2)):
        for i in range(max(0, int((x - r) / G) - 1), min(NX, int((x + r) / G) + 2)):
            cx, cy = i * G, j * G
            inside = (abs(cx - x) <= r and abs(cy - y) <= r) if shape == "rect" else ((cx - x) ** 2 + (cy - y) ** 2 <= r * r)
            if inside:
                out.append((i, j))
    return out

pad_idx = {}   # pad -> set of cell indices (both layers)
for p in pads:
    ref, num, x, y, half, shape, n = p
    s = set()
    for (i, j) in pad_cells(x, y, half, shape):
        for l in range(NL):
            occ[cell(l, i, j)] = n
            s.add(cell(l, i, j))
    if not s:   # pad smaller than the grid: take the nearest cell
        i, j = round(x / G), round(y / G)
        for l in range(NL):
            occ[cell(l, i, j)] = n
            s.add(cell(l, i, j))
    pad_idx[(ref, num)] = s
    for (i, j) in pad_cells(x, y, half, shape, CLEAR + TRACK / 2):
        for l in range(NL):
            mark_halo(cell(l, i, j), n)

# Unconnected pads are solid obstacles with a clearance halo for every net.
for (ref, num, x, y, half, shape, _n) in nc_pads:
    for (i, j) in pad_cells(x, y, half, shape, CLEAR + TRACK / 2):
        for l in range(NL):
            occ[cell(l, i, j)] = -1

# ---- per-net passability ----
def passable_map(n, k):
    ok = bytearray(N)
    for idx in range(N):
        o, h = occ[idx], halo[idx]
        ok[idx] = 1 if (o == 0 or o == n) and (h == 0 or h == n) else 0
    if k == 0:
        return ok, bytes(ok)
    # erode by k cells (separable min filter) so a (2k+1)-wide corridor fits
    tmp = bytearray(N)
    for l in range(NL):
        for j in range(NY):
            base = (l * NY + j) * NX
            row = ok[base:base + NX]
            for i in range(NX):
                a, b = max(0, i - k), min(NX, i + k + 1)
                tmp[base + i] = 1 if (i - k >= 0 and i + k < NX and all(row[a:b])) else 0
    out = bytearray(N)
    for l in range(NL):
        for i in range(NX):
            col = [tmp[(l * NY + j) * NX + i] for j in range(NY)]
            for j in range(NY):
                a, b = j - k, j + k + 1
                out[(l * NY + j) * NX + i] = 1 if (a >= 0 and b <= NY and all(col[a:b])) else 0
    strict = bytes(out)
    # own pad cells are always enterable (the corridor may be wider than a pad);
    # cells that only pass because of this are drawn thin (see `fits`)
    for idx in range(N):
        if occ[idx] == n:
            out[idx] = 1
    return out, strict

INF = float("inf")

def astar(n, ok, sources, targets, tx, ty):
    """Multi-source A* from `sources` (cell idx) to any cell in `targets`."""
    g = array('f', [INF]) * (4 * N)
    came = {}
    heap = []
    for s in sources:
        for d in range(4):
            g[s * 4 + d] = 0.0
            heapq.heappush(heap, (0.0, 0.0, s * 4 + d))
    tgi, tgj = tx / G, ty / G
    while heap:
        f_, gc, node = heapq.heappop(heap)
        if gc > g[node]:
            continue
        idx, d = divmod(node, 4)
        if idx in targets:
            path, cur = [idx], node
            while cur in came:
                cur = came[cur]
                path.append(cur // 4)
            return path[::-1]
        l, rem = divmod(idx, NX * NY)
        j, i = divmod(rem, NX)
        steps = []
        if i + 1 < NX: steps.append((idx + 1, 0, l == 1))
        if i > 0: steps.append((idx - 1, 1, l == 1))
        if j + 1 < NY: steps.append((idx + NX, 2, l == 0))
        if j > 0: steps.append((idx - NX, 3, l == 0))
        for nidx, nd, off in steps:
            if not ok[nidx]:
                continue
            c = gc + (OFFDIR_COST if off else 1.0) + (BEND_COST if nd != d else 0.0)
            nn = nidx * 4 + nd
            if c < g[nn]:
                g[nn] = c; came[nn] = node
                ni, nj = (nidx % (NX * NY)) % NX, (nidx % (NX * NY)) // NX
                heapq.heappush(heap, (c + 1.2 * (abs(ni - tgi) + abs(nj - tgj)), c, nn))
        # via to the other layer (needs the via's 3x3 footprint free on both)
        other = cell(1 - l, i, j)
        if ok[other] and via_ok(n, i, j):
            c = gc + VIA_COST
            nn = other * 4 + d
            if c < g[nn]:
                g[nn] = c; came[nn] = node
                heapq.heappush(heap, (c + 1.2 * (abs(i - tgi) + abs(j - tgj)), c, nn))
    return None

def via_ok(n, i, j):
    if i < 1 or j < 1 or i >= NX - 1 or j >= NY - 1:
        return False
    for l in range(NL):
        for dj in (-1, 0, 1):
            for di in (-1, 0, 1):
                idx = cell(l, i + di, j + dj)
                o, h = occ[idx], halo[idx]
                if not ((o == 0 or o == n) and (h == 0 or h == n)):
                    return False
    return True

def commit(n, path, k, fits):
    """Mark the path's corridor (and via footprints) as net n."""
    vias = []
    for a, b in zip(path, path[1:]):
        if abs(a - b) == NX * NY:          # layer change
            j, i = divmod(a % (NX * NY), NX)
            vias.append((i, j))
    for idx, fit in zip(path, fits):
        l, rem = divmod(idx, NX * NY)
        j, i = divmod(rem, NX)
        kk = k if fit else 0
        for dj in range(-kk, kk + 1):
            for di in range(-kk, kk + 1):
                if 0 <= i + di < NX and 0 <= j + dj < NY:
                    c = cell(l, i + di, j + dj)
                    if occ[c] == 0:
                        occ[c] = n
    for (i, j) in vias:
        for l in range(NL):
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    c = cell(l, i + di, j + dj)
                    if occ[c] == 0:
                        occ[c] = n
    return vias

# ---- route ----
net_pads = {}
for p in pads:
    net_pads.setdefault(p[6], []).append(p)

order = sorted(net_pads, key=lambda n: (-WIDE.get(pcb.nets[n], 0),
                                        sum(abs(a[2] - b[2]) + abs(a[3] - b[3]) for a in net_pads[n] for b in net_pads[n][:1])))
routes = {}     # net id -> list of (path, vias)
failed = []
for n in order:
    name = pcb.nets[n]
    plist = net_pads[n]
    if len(plist) < 2:
        continue
    k = WIDE.get(name, 0)
    ok, strict = passable_map(n, k)
    connected = [plist[0]]
    tree = set(pad_idx[(plist[0][0], plist[0][1])])
    todo = plist[1:]
    routes[n] = []
    while todo:
        # next pad = nearest to anything already connected
        todo.sort(key=lambda p: min((p[2] - q[2]) ** 2 + (p[3] - q[3]) ** 2 for q in connected))
        p = todo.pop(0)
        targets = pad_idx[(p[0], p[1])]
        if tree & targets:
            connected.append(p); continue
        path = astar(n, ok, tree, targets, p[2], p[3])
        if path is None and k > 0:           # fall back to a thinner corridor
            ok0, strict = passable_map(n, 0)
            path = astar(n, ok0, tree, targets, p[2], p[3])
            if path is not None:
                print(f"  note: {name} to {p[0]}.{p[1]} routed thin")
        if path is None:
            failed.append((name, p[0], p[1])); continue
        fits = [bool(strict[c]) for c in path]
        vias = commit(n, path, k, fits)
        routes[n].append((path, vias, fits))
        tree.update(path)
        for (i, j) in vias:
            tree.add(cell(0, i, j)); tree.add(cell(1, i, j))
        connected.append(p)
        tree |= targets
    print(f"routed {name:<12} pads={len(plist):<3} segments={len(routes[n])}")

# ---- geometry out ----
def to_segments(path, fits, wide_w):
    """Cell path -> straight segments [(width, layer, x1, y1, x2, y2)], one per
    cell step, then merged: collinear steps of equal width on one layer join."""
    pts = []
    for idx in path:
        l, rem = divmod(idx, NX * NY)
        j, i = divmod(rem, NX)
        pts.append((l, i * G, j * G))
    steps = []
    for (a, fa), (b, fb) in zip(zip(pts, fits), zip(pts[1:], fits[1:])):
        if a[0] != b[0]:
            continue   # via
        steps.append((wide_w if (fa and fb) else TRACK, a[0], a[1], a[2], b[1], b[2]))
    segs = []
    for st in steps:
        if segs:
            w, l, x1, y1, x2, y2 = segs[-1]
            if w == st[0] and l == st[1] and (x2, y2) == (st[2], st[3]) and \
               (x2 - x1 == 0) == (st[4] - st[2] == 0) and (y2 - y1 == 0) == (st[5] - st[3] == 0):
                segs[-1] = (w, l, x1, y1, st[4], st[5]); continue
        segs.append(st)
    return segs

all_segs, all_vias = [], []
for n, rl in routes.items():
    w = width_of(pcb.nets[n])
    for path, vias, fits in rl:
        for s in to_segments(path, fits, w):
            all_segs.append((n,) + s)
        for (i, j) in vias:
            all_vias.append((n, i * G, j * G, 1.2 if WIDE.get(pcb.nets[n], 0) >= 3 else 0.8))

def write_routed(path_in, path_out):
    body = open(path_in).read().rstrip()
    assert body.endswith(")")
    extra = []
    for (n, w, l, x1, y1, x2, y2) in all_segs:
        layer = "F.Cu" if l == 0 else "B.Cu"
        extra.append(f'  (segment (start {x1:.3f} {y1:.3f}) (end {x2:.3f} {y2:.3f}) (width {w:.2f}) (layer "{layer}") (net {n}) (tstamp {uuid.uuid4()}))')
    for (n, x, y, size) in all_vias:
        drill = 0.6 if size > 1 else 0.4
        extra.append(f'  (via (at {x:.3f} {y:.3f}) (size {size}) (drill {drill}) (layers "F.Cu" "B.Cu") (net {n}) (tstamp {uuid.uuid4()}))')
    open(path_out, "w").write(body[:-1] + "\n".join(extra) + "\n)\n")

# ---- PDF ----
from reportlab.lib.pagesizes import A3, landscape
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm

def draw_board(c, layers, mirror, title):
    pw, ph = landscape(A3)
    s = 1.95
    ox, oy = 18 * mm, ph - 28 * mm
    X = (lambda x: ox + (pcb.BW - x) * mm * s) if mirror else (lambda x: ox + x * mm * s)
    Y = lambda y: oy - y * mm * s
    c.setFont("Helvetica-Bold", 13); c.drawString(18 * mm, ph - 14 * mm, title)
    c.setFillColorRGB(0.05, 0.22, 0.1); c.rect(X(0) if not mirror else X(pcb.BW), Y(pcb.BH), pcb.BW * mm * s, pcb.BH * mm * s, fill=1, stroke=0)
    colours = {0: (0.85, 0.25, 0.2), 1: (0.25, 0.5, 0.95)}
    for l in layers:
        c.setStrokeColorRGB(*colours[l]); c.setLineCap(1); c.setLineJoin(1)
        c.setStrokeAlpha(0.9 if len(layers) == 1 else 0.75)
        for (n, w, sl, x1, y1, x2, y2) in all_segs:
            if sl == l:
                c.setLineWidth(w * mm * s); c.line(X(x1), Y(y1), X(x2), Y(y2))
    c.setStrokeAlpha(1)
    # pads (through-hole: on both layers)
    for p in pads:
        ref, num, x, y, half, shape, n = p
        c.setFillColorRGB(0.85, 0.7, 0.3)
        if shape == "rect":
            c.rect(X(x) - half * mm * s, Y(y) - half * mm * s, 2 * half * mm * s, 2 * half * mm * s, fill=1, stroke=0)
        else:
            c.circle(X(x), Y(y), half * mm * s, fill=1, stroke=0)
    for f in pcb.fps:
        for num, dx, dy, net, shape, size, drill in f.pads:
            c.setFillColorRGB(1, 1, 1) if shape == "np" else c.setFillColorRGB(0.05, 0.05, 0.05)
            if shape == "np":
                c.setFillColorRGB(0.85, 0.85, 0.85); c.circle(X(f.x + dx), Y(f.y + dy), 3.0 * mm * s, fill=1, stroke=0)
                c.setFillColorRGB(1, 1, 1)
            c.circle(X(f.x + dx), Y(f.y + dy), drill / 2 * mm * s, fill=1, stroke=0)
    for (n, x, y, size) in all_vias:
        c.setFillColorRGB(0.8, 0.8, 0.8); c.circle(X(x), Y(y), size / 2 * mm * s, fill=1, stroke=0)
        c.setFillColorRGB(0.05, 0.05, 0.05); c.circle(X(x), Y(y), (0.3 if size < 1 else 0.3) * mm * s, fill=1, stroke=0)
    # silkscreen (top only, or faint on bottom view)
    if 0 in layers:
        c.setStrokeColorRGB(1, 1, 1); c.setFillColorRGB(1, 1, 1); c.setLineWidth(0.4)
        for f in pcb.fps:
            for (x1, y1, x2, y2) in f.silk:
                c.line(X(f.x + x1), Y(f.y + y1), X(f.x + x2), Y(f.y + y2))
            c.setFont("Helvetica-Bold", 5.5)
            c.drawCentredString(X(f.x + f.ref_at[0]), Y(f.y + f.ref_at[1]) - 2, f.ref)
        c.setDash(3, 2)
        for (x0, y0, x1, y1, lab) in pcb.outlines:
            c.rect(min(X(x0), X(x1)), Y(y1), abs(x1 - x0) * mm * s, (y1 - y0) * mm * s)
        c.setDash()
    c.setFillColorRGB(0, 0, 0); c.setFont("Helvetica", 8)
    c.drawString(18 * mm, 14 * mm, f"{len(all_segs)} track segments, {len(all_vias)} vias.  Red = top copper (F.Cu), blue = bottom copper (B.Cu).  "
                 "Track widths: signals 0.3 mm, 5V/3V3/GND/valves 1.3 mm, 12V/GND12/pump 3.3 mm.  Grid 0.5 mm, clearance >= 0.2 mm.")
    c.drawString(18 * mm, 9 * mm, ("Viewed from the BOTTOM (mirrored left-right)." if mirror else "Viewed from the TOP (component side).")
                 + "  Module sizes are ASSUMED - re-route after measuring.")
    c.showPage()

def drc():
    """Independent geometric check: min copper-to-copper gap between different nets."""
    items = []   # (net, kind, geometry, half-width)
    for (n, w, l, x1, y1, x2, y2) in all_segs:
        items.append((n, l, (x1, y1, x2, y2), w / 2))
    for (n, x, y, size) in all_vias:
        for l in range(NL):
            items.append((n, l, (x, y, x, y), size / 2))
    for (ref, num, x, y, half, shape, n) in pads + nc_pads:
        for l in range(NL):
            if shape == "rect":   # a square pad = a zero-length... no: a segment of length 2h, width 2h, both axes
                items.append((n if n else -hash((ref, num)), l, (x - half, y - half, x + half, y - half), 0.0, "sq", half))
            else:
                items.append((n if n else -hash((ref, num)), l, (x, y, x, y), half))
    def sq_dist(sq, other_geom, other_half):
        # distance from a square pad (centre, half) to a segment, via sampling along the segment
        _n, _l, (x0, y0, _x1, _y1), _z, _t, h = sq
        cx, cy = x0 + h, y0 + h
        x1, y1, x2, y2 = other_geom
        best = 99.0
        steps = max(1, int(math.hypot(x2 - x1, y2 - y1) / 0.05))
        for t in range(steps + 1):
            px, py = x1 + (x2 - x1) * t / steps, y1 + (y2 - y1) * t / steps
            dx, dy = max(abs(px - cx) - h, 0), max(abs(py - cy) - h, 0)
            best = min(best, math.hypot(dx, dy))
        return best - other_half
    def seg_dist(a, b):
        def pt_seg(px, py, x1, y1, x2, y2):
            dx, dy = x2 - x1, y2 - y1
            L = dx * dx + dy * dy
            t = 0 if L == 0 else max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / L))
            return math.hypot(px - x1 - t * dx, py - y1 - t * dy)
        (a1, a2, a3, a4), (b1, b2, b3, b4) = a, b
        # axis-aligned segments never properly cross without touching an endpoint distance of 0 check below
        d = min(pt_seg(a1, a2, b1, b2, b3, b4), pt_seg(a3, a4, b1, b2, b3, b4),
                pt_seg(b1, b2, a1, a2, a3, a4), pt_seg(b3, b4, a1, a2, a3, a4))
        if (a1 == a3) != (b1 == b3):   # one vertical, one horizontal: check crossing
            v, h = (a, b) if a1 == a3 else (b, a)
            if min(h[0], h[2]) <= v[0] <= max(h[0], h[2]) and min(v[1], v[3]) <= h[1] <= max(v[1], v[3]):
                d = 0.0
        return d
    worst, bad = 99.0, []
    B = 6.0   # bucket size (mm) for a spatial hash
    buckets = {}
    for k_, it in enumerate(items):
        x1, y1, x2, y2 = it[2]
        for bx in range(int(min(x1, x2) // B) - 1, int(max(x1, x2) // B) + 2):
            for by in range(int(min(y1, y2) // B) - 1, int(max(y1, y2) // B) + 2):
                buckets.setdefault((it[1], bx, by), []).append(k_)
    seen = set()
    for key, lst in buckets.items():
        for a in range(len(lst)):
            for b in range(a + 1, len(lst)):
                i1, i2 = items[lst[a]], items[lst[b]]
                if i1[0] == i2[0] or (lst[a], lst[b]) in seen:
                    continue
                seen.add((lst[a], lst[b]))
                if len(i1) > 4 and len(i2) > 4:
                    continue   # square pad vs square pad: fixed by placement, checked by the placement generator
                if len(i1) > 4:
                    gap = sq_dist(i1, i2[2], i2[3])
                elif len(i2) > 4:
                    gap = sq_dist(i2, i1[2], i1[3])
                else:
                    gap = seg_dist(i1[2], i2[2]) - i1[3] - i2[3]
                if gap < worst:
                    worst = gap
                if gap < 0.15:
                    bad.append((pcb.nets[i1[0]] if i1[0] > 0 else "NC", pcb.nets[i2[0]] if i2[0] > 0 else "NC", round(gap, 3), i1[2][:2]))
    return worst, bad

def main():
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    src = os.path.join(out, "plant-room-controller-v2.kicad_pcb")
    write_routed(src, os.path.join(out, "plant-room-controller-v2-routed.kicad_pcb"))
    c = canvas.Canvas(os.path.join(out, "pcb-v2-routed.pdf"), pagesize=landscape(A3))
    draw_board(c, [0, 1], False, "Main PCB v2 - fully routed, both layers (top view)")
    draw_board(c, [0], False, "Main PCB v2 - TOP layer (F.Cu) + silkscreen")
    draw_board(c, [1], True, "Main PCB v2 - BOTTOM layer (B.Cu), seen from below")
    c.save()
    print(f"segments={len(all_segs)} vias={len(all_vias)} failed={failed}")
    worst, bad = drc()
    print(f"DRC: minimum copper gap between different nets = {worst:.3f} mm; violations (<0.15mm): {len(bad)}")
    for b in bad[:15]:
        print("   ", b)

if __name__ == "__main__":
    main()
