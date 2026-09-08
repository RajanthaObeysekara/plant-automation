import { useMemo } from 'react';

// Live animated floor-plan of a farm's plumbing: mains → inlet valve →
// water tank → distribution pump → trunk → each room's branch valve →
// manifold → nozzles; the 2 fertilizer stock tanks → shared dosing pump →
// mixing tank (stirred) → filter → room-select valve bank → whichever
// room's feed cycle is running, joining the trunk the same way; the
// fungicide tank → its own pump/valve → injects into that same trunk main
// and sprays through the regular fogging nozzles (no separate line/nozzle).
// Every element reflects real state from `farm`/`rooms` — nothing here
// animates just for show.
const WATER = 'var(--water)';
const WATER_INK = 'var(--water-ink)';
const FERT = 'var(--fert)';
const FERT_INK = 'var(--fert-ink)';
const WARN = 'var(--warn)';
const CRIT = 'var(--crit)';
const LINE_STRONG = 'var(--line-strong)';
const MUTED = 'var(--muted)';
const SURFACE2 = 'var(--surface-2)';

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Real level from the tank's saved calibration (tare + scale + capacity),
// live off the raw counts the farm device is currently reporting — updates
// on every telemetry tick, including mid-operation (draining while
// dosing, filling while misting, etc). Falls back to the low/full sensor
// 3-state for an uncalibrated water tank, or "unknown" for any other
// uncalibrated tank — never invents precision the sensors don't have.
function tankLevel(tankKey, farm, calibrations) {
  const cal = calibrations.find((c) => c.tank_key === tankKey);
  const raw = farm[`raw_${tankKey}_counts`];
  if (cal?.scale_factor && cal?.tare_raw != null && raw != null) {
    const weightG = (Number(raw) - Number(cal.tare_raw)) / Number(cal.scale_factor);
    const liters = weightG / (1000 * Number(cal.density_g_per_ml || 1));
    if (cal.capacity_l) {
      const capacityG = Number(cal.capacity_l) * 1000 * Number(cal.density_g_per_ml || 1);
      return { frac: clamp(weightG / capacityG, 0, 1), liters, capacityL: Number(cal.capacity_l), calibrated: true };
    }
    return { frac: null, liters, capacityL: null, calibrated: true };
  }
  if (tankKey === 'water') {
    if (farm.water_full) return { frac: 0.88, liters: null, capacityL: null, calibrated: false };
    if (farm.water_low) return { frac: 0.14, liters: null, capacityL: null, calibrated: false };
    return { frac: 0.5, liters: null, capacityL: null, calibrated: false };
  }
  return { frac: 0.5, liters: null, capacityL: null, calibrated: false };
}

function levelLabel(level) {
  if (level.liters != null) {
    const litersTxt = level.liters.toFixed(1);
    return level.capacityL ? `${Math.round(level.frac * 100)}% · ${litersTxt}/${level.capacityL}L` : `${litersTxt}L`;
  }
  if (level.frac != null && level.calibrated === false) return `~${Math.round(level.frac * 100)}%`;
  return '—';
}

function roomMistActive(room) {
  return room.activity === 'misting';
}

export default function FarmPipeline({ farm, rooms, calibrations }) {
  const n = Math.max(rooms.length, 1);
  const W = 860;
  const roomBandH = 150;
  const H = 470 + roomBandH;

  const fertActiveIdx = farm.fert_activity !== 'idle'
    ? rooms.findIndex((r) => r.id === farm.fert_activity_room_id) : -1;
  const fertRunning = farm.fert_activity !== 'idle';
  const mistingCount = rooms.filter(roomMistActive).length;

  const roomW = (W - 40) / n;
  const roomX = (i) => 20 + i * roomW;
  const roomCx = (i) => roomX(i) + roomW / 2;

  const waterLevel = tankLevel('water', farm, calibrations);
  const earlyLevel = tankLevel('fertilizer_early', farm, calibrations);
  const lateLevel = tankLevel('fertilizer_late', farm, calibrations);
  const fungicideLevel = tankLevel('fungicide', farm, calibrations);
  // Stock tanks have no float switch of their own on the real build — this
  // is a general "getting low, go refill it" warning for the operator. The
  // farm controller's own refusal to dose is checked per-batch server-side
  // (skips a feed if the exact concentrate volume needed isn't there), so
  // this can light up before that actually blocks a feed.
  const earlyLow = earlyLevel.frac != null && earlyLevel.frac <= 0.15;
  const lateLow = lateLevel.frac != null && lateLevel.frac <= 0.15;
  const fungicideLow = fungicideLevel.frac != null && fungicideLevel.frac <= 0.15;

  const trunkY = 300;
  const branchY = 340;
  const manifoldY = 390;
  const nozzleY = 430;
  const roomLabelY = 460;

  return (
    <div className="farm-pipeline-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="farm-pipeline-svg" role="img" aria-label="Live plumbing diagram">
        <defs>
          <marker id="fp-arrow-water" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={WATER} />
          </marker>
          <marker id="fp-arrow-fert" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill={FERT} />
          </marker>
        </defs>

        {/* ================= WATER SIDE ================= */}
        <TankBox x={16} y={4} w={110} h={22} label="Mains / Rainwater" stroke={LINE_STRONG} />
        <Pipe x1={71} y1={26} x2={71} y2={54} color={WATER} arrow="fp-arrow-water" />
        <ValveBox x={16} y={56} w={110} h={22} label="Inlet Valve"
          open={farm.tank_activity === 'filling'} color={WATER} openColor={WATER} />
        <Pipe x1={71} y1={78} x2={71} y2={104} color={WATER} arrow="fp-arrow-water" />

        <WaterTankVisual x={0} y={106} w={142} h={72} fill={waterLevel.frac} label={levelLabel(waterLevel)}
          low={!!farm.water_low} full={!!farm.water_full} overflow={!!farm.water_overflow}
          activity={farm.tank_activity} />

        <Pipe x1={71} y1={178} x2={71} y2={204} color={WATER} arrow="fp-arrow-water" />
        <PumpBox x={26} y={206} w={90} h={24} label="Distribution Pump"
          running={farm.tank_activity !== 'dechlorinating' && (mistingCount > 0 || farm.tank_activity === 'filling')} color={WATER} />
        <Pipe x1={71} y1={230} x2={71} y2={trunkY} color={WATER} arrow="fp-arrow-water" />
        <line x1={71} y1={trunkY} x2={W - 20} y2={trunkY} stroke={WATER} strokeWidth="3" />
        <text x={76} y={trunkY - 6} fontSize="9" fill={WATER_INK} fontFamily="var(--font-mono, monospace)">farm trunk main</text>

        {/* ================= FERTILIZER SIDE ================= */}
        <StockTankVisual idKey="early" x={170} y={4} w={100} h={38} color={FERT}
          label="Early Fert. Tank" fill={earlyLevel.frac} sub={levelLabel(earlyLevel)} low={earlyLow} />
        <StockTankVisual idKey="late" x={280} y={4} w={100} h={38} color={FERT}
          label="Late Fert. Tank" fill={lateLevel.frac} sub={levelLabel(lateLevel)} low={lateLow} />

        <ValveBox x={170} y={46} w={100} h={18} label="Valve"
          open={fertRunning && farm.fert_activity_source === 'fertilizer_early'} color={FERT} blocked={earlyLow} />
        <ValveBox x={280} y={46} w={100} h={18} label="Valve"
          open={fertRunning && farm.fert_activity_source === 'fertilizer_late'} color={FERT} blocked={lateLow} />

        <Pipe x1={220} y1={64} x2={220} y2={82} color={FERT}
          flowing={fertRunning && farm.fert_activity_source === 'fertilizer_early'} arrow="fp-arrow-fert" />
        <Pipe x1={330} y1={64} x2={330} y2={82} color={FERT}
          flowing={fertRunning && farm.fert_activity_source === 'fertilizer_late'} arrow="fp-arrow-fert" />
        <line x1={220} y1={82} x2={330} y2={82} stroke={FERT} strokeWidth="2" />
        <Pipe x1={275} y1={82} x2={275} y2={100} color={FERT} flowing={fertRunning} arrow="fp-arrow-fert" />

        <PumpBox x={230} y={102} w={90} h={22} label="Dosing Pump" running={fertRunning} color={FERT} />
        <Pipe x1={275} y1={124} x2={275} y2={150} color={FERT} flowing={fertRunning} arrow="fp-arrow-fert" />

        <MixTankVisual x={220} y={152} w={110} h={44}
          active={farm.fert_activity === 'mixing' || farm.fert_activity === 'stirring'}
          stirring={farm.fert_activity === 'stirring'} />

        <Pipe x1={275} y1={196} x2={275} y2={222} color={FERT}
          flowing={farm.fert_activity === 'filtering' || farm.fert_activity === 'feeding'} arrow="fp-arrow-fert" />
        <ValveBox x={230} y={224} w={90} h={20} label="Inline Filter"
          open={farm.fert_activity === 'filtering' || farm.fert_activity === 'feeding'} color={FERT} />

        <Pipe x1={275} y1={244} x2={275} y2={268} color={FERT} flowing={farm.fert_activity === 'feeding'} arrow="fp-arrow-fert" />
        <TankBox x={200} y={270} w={150} h={26} label="Room-Select Valve Bank"
          sub={fertActiveIdx >= 0 ? `→ ${rooms[fertActiveIdx]?.name}` : 'idle'}
          stroke={FERT} fill={farm.fert_activity === 'feeding' ? 'color-mix(in srgb, var(--fert) 18%, var(--surface))' : undefined} />

        {/* ================= FUNGICIDE (injects into the same trunk main —
             sprayed through the regular fogging nozzles, no separate line) ================= */}
        <StockTankVisual idKey="fungicide" x={400} y={4} w={110} h={38} color={WARN}
          label="Fungicide Tank" fill={fungicideLevel.frac} sub={levelLabel(fungicideLevel)} low={fungicideLow} />
        <ValveBox x={400} y={46} w={110} h={18} label="Pump + Valve" open={false} color={WARN} blocked={fungicideLow} />
        <text x={455} y={76} textAnchor="middle" fontSize="6.6" fill={WARN}>shares water nozzles ↓</text>
        <line x1={455} y1={82} x2={455} y2={trunkY} stroke={WARN} strokeWidth="1.6" strokeDasharray="4 3" />
        <circle cx={455} cy={trunkY} r={3.5} fill={WARN} stroke="var(--surface)" strokeWidth="1" />

        {/* ================= ROOM BRANCHES ================= */}
        {rooms.map((room, i) => {
          const cx = roomCx(i);
          const misting = roomMistActive(room);
          const fedHere = fertActiveIdx === i;
          return (
            <g key={room.id}>
              <Pipe x1={cx} y1={trunkY} x2={cx} y2={branchY} color={WATER} flowing={misting} dashed={!misting} arrow="fp-arrow-water" />
              <ValveBox x={cx - 34} y={branchY} w={68} h={16} label="Branch" open={misting} color={WATER} />

              {fertActiveIdx >= 0 && (
                <Pipe x1={275} y1={296} x2={cx} y2={branchY + 16} color={FERT} dashed flowing={fedHere && farm.fert_activity === 'feeding'} />
              )}

              <Pipe x1={cx} y1={branchY + 16} x2={cx} y2={manifoldY} color={misting ? WATER : LINE_STRONG} flowing={misting} dashed={!misting} arrow={misting ? 'fp-arrow-water' : undefined} />
              <TankBox x={roomX(i) + 4} y={manifoldY} w={roomW - 8} h={20} label={room.name} sub="manifold + filter"
                stroke={fedHere ? FERT : misting ? WATER : LINE_STRONG}
                fill={fedHere ? 'color-mix(in srgb, var(--fert) 12%, var(--surface))' : misting ? 'color-mix(in srgb, var(--water) 10%, var(--surface))' : undefined} />

              <Pipe x1={cx} y1={manifoldY + 20} x2={cx} y2={nozzleY} color={misting ? WATER : LINE_STRONG} dashed={!misting} />
              <NozzleRow cx={cx} y={nozzleY} spraying={misting} color={WATER} />

              <text x={cx} y={roomLabelY} textAnchor="middle" fontSize="9" fill={MUTED}>
                {room.benchCount != null ? `${room.benchCount} bench${room.benchCount === 1 ? '' : 'es'}` : ''}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="farm-pipeline-legend">
        <span><i className="fp-swatch" style={{ background: WATER }} /> water</span>
        <span><i className="fp-swatch" style={{ background: FERT }} /> fertilizer feed</span>
        <span><i className="fp-swatch" style={{ background: WARN }} /> fungicide (manual, shares the water nozzles)</span>
        <span><i className="fp-swatch dashed" /> valve interlocked / not flowing</span>
        <span><i className="fp-swatch" style={{ background: WARN, borderRadius: '50%', width: 8, height: 8 }} /> tank low — refill</span>
      </div>
    </div>
  );
}

function Pipe({ x1, y1, x2, y2, color, dashed, flowing, arrow }) {
  return (
    <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={dashed ? 1.6 : 2.2}
      strokeDasharray={dashed ? '4 3' : undefined}
      className={flowing ? 'fp-pipe-flowing' : ''}
      markerEnd={arrow ? `url(#${arrow})` : undefined} />
  );
}

function TankBox({ x, y, w, h, label, sub, stroke = LINE_STRONG, fill }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill={fill || 'var(--surface)'} stroke={stroke} strokeWidth="1.2" />
      <text x={x + w / 2} y={y + (sub ? h / 2 - 2 : h / 2 + 3)} textAnchor="middle" fontSize="8.6" fontWeight="600" fill="var(--ink)">{label}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 11} textAnchor="middle" fontSize="7.6" fill={MUTED}>{sub}</text>}
    </g>
  );
}

// `blocked` marks a valve that can't usefully open right now because its
// source tank is low — same idea as the branch valve going dashed, but in
// warn color so "closed" and "closed because it's nearly empty" don't look
// the same.
function ValveBox({ x, y, w, h, label, open, color, blocked }) {
  const strokeColor = open ? color : blocked ? WARN : color;
  return (
    <g className={open ? 'fp-valve-open' : ''}>
      <rect x={x} y={y} width={w} height={h} rx={9} fill={open ? color : 'var(--surface)'} fillOpacity={open ? 0.22 : 1}
        stroke={strokeColor} strokeWidth={open ? 1.4 : 1.1} strokeDasharray={open ? undefined : '3 2.5'} strokeOpacity={open ? 1 : 0.75} />
      <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize="7.6" fontWeight="600"
        fill={open ? color : blocked ? WARN : MUTED}>{label}{open ? ' ●' : blocked ? ' ⚠' : ''}</text>
    </g>
  );
}

function PumpBox({ x, y, w, h, label, running, color }) {
  return (
    <g className={running ? 'fp-pump-running' : ''}>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="var(--surface)" stroke={color} strokeWidth="1.4" />
      <circle cx={x + 12} cy={y + h / 2} r={5} fill={running ? color : SURFACE2} stroke={color} strokeWidth="1" className={running ? 'fp-pump-spin' : ''} />
      <text x={x + w / 2 + 6} y={y + h / 2 + 3} textAnchor="middle" fontSize="8" fontWeight="600" fill="var(--ink)">{label}</text>
    </g>
  );
}

function WaterTankVisual({ x, y, w, h, fill, label, low, full, overflow, activity }) {
  const waterY = y + h - fill * h;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--surface)" stroke={WATER} strokeWidth="1.4" />
      <clipPath id="fp-water-clip"><rect x={x + 2} y={y + 2} width={w - 4} height={h - 4} rx={3} /></clipPath>
      <rect className="fp-fill-rect" x={x} y={waterY} width={w} height={h - (waterY - y)} fill={WATER} fillOpacity="0.55" clipPath="url(#fp-water-clip)" />
      <text x={x + w / 2} y={y - 8} textAnchor="middle" fontSize="8.6" fontWeight="600" fill="var(--ink)">Water Tank</text>
      {label && (
        <g>
          <rect x={x + w / 2 - 34} y={y + 6} width={68} height={13} rx={6} fill="var(--surface)" fillOpacity="0.85" stroke={WATER} strokeWidth="0.75" />
          <text x={x + w / 2} y={y + 15.5} textAnchor="middle" fontSize="7.4" fontWeight="700" fill={WATER_INK}>{label}</text>
        </g>
      )}
      {/* limit switches */}
      <LimitSwitch cx={x + w + 10} cy={y + h * 0.18} active={full} color={WATER} label="full" />
      <LimitSwitch cx={x + w + 10} cy={y + h * 0.82} active={low} color={WARN} label="low" />
      <LimitSwitch cx={x + w + 10} cy={y + 6} active={overflow} color={CRIT} label="overflow" pulse />
      {activity === 'dechlorinating' && (
        <g>
          <rect x={x + w / 2 - 44} y={y + h - 16} width={88} height={13} rx={6} fill="var(--surface)" stroke={WARN} strokeWidth="1" />
          <text x={x + w / 2} y={y + h - 6.5} textAnchor="middle" fontSize="7.2" fontWeight="600" fill={WARN}>dechlorinating</text>
        </g>
      )}
    </g>
  );
}

// The 3 stock tanks (early/late fertilizer, fungicide) — same live fill-bar
// idea as the water tank, sized down to fit the top row, plus a single
// "low" limit switch since these are refilled manually rather than
// auto-filled. `fill` of null (never reported / never calibrated) draws an
// empty outline with no liquid rather than guessing a level.
function StockTankVisual({ idKey, x, y, w, h, color, label, fill, sub, low }) {
  const clipId = `fp-stock-clip-${idKey}`;
  const frac = fill == null ? 0 : fill;
  const liquidY = y + h - frac * h;
  const outline = low ? WARN : color;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill="var(--surface)" stroke={outline} strokeWidth={low ? 1.6 : 1.2} />
      {fill != null && (
        <>
          <clipPath id={clipId}><rect x={x + 2} y={y + 2} width={w - 4} height={h - 4} rx={3} /></clipPath>
          <rect className="fp-fill-rect" x={x} y={liquidY} width={w} height={h - (liquidY - y)}
            fill={color} fillOpacity="0.45" clipPath={`url(#${clipId})`} />
        </>
      )}
      <text x={x + w / 2} y={y + h / 2 - 3} textAnchor="middle" fontSize="8.2" fontWeight="600" fill="var(--ink)">{label}</text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 10} textAnchor="middle" fontSize="7.4" fontWeight="700" fill={low ? WARN : color}>{sub}</text>}
      {/* low-stock limit switch — kept inside the tank's own bounding box so
          it never collides with the next tank in this tightly-packed row */}
      {low && <circle cx={x + w - 8} cy={y + 8} r={3.2} fill={WARN} stroke="var(--surface)" strokeWidth="1" className="fp-limit-pulse" />}
    </g>
  );
}

function MixTankVisual({ x, y, w, h, active, stirring }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={4} fill={active ? 'color-mix(in srgb, var(--fert) 16%, var(--surface))' : 'var(--surface)'}
        stroke={FERT} strokeWidth="1.4" />
      <text x={x + w / 2} y={y + h / 2 - 4} textAnchor="middle" fontSize="8.6" fontWeight="600" fill="var(--ink)">Mixing Tank</text>
      <g className={stirring ? 'fp-stir-spin' : ''} style={{ transformOrigin: `${x + w / 2}px ${y + h / 2 + 10}px` }}>
        <line x1={x + w / 2 - 9} y1={y + h / 2 + 10} x2={x + w / 2 + 9} y2={y + h / 2 + 10} stroke={FERT} strokeWidth="2" />
        <line x1={x + w / 2} y1={y + h / 2 + 2} x2={x + w / 2} y2={y + h / 2 + 18} stroke={FERT} strokeWidth="2" />
      </g>
    </g>
  );
}

function LimitSwitch({ cx, cy, active, color, label, pulse }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={4} fill={active ? color : 'var(--surface-2)'} stroke={color} strokeWidth="1"
        className={active && pulse ? 'fp-limit-pulse' : ''} />
      <text x={cx + 7} y={cy + 3} fontSize="7" fill={active ? color : MUTED}>{label}</text>
    </g>
  );
}

function NozzleRow({ cx, y, spraying, color }) {
  return (
    <g>
      <circle cx={cx} cy={y} r={3} fill={color} />
      {spraying && [0, 1, 2].map((i) => (
        <circle key={i} cx={cx} cy={y + 6} r={1.6} fill={color} className="fp-droplet" style={{ animationDelay: `${i * 0.25}s` }} />
      ))}
      <text x={cx} y={y + 22} textAnchor="middle" fontSize="7" fill={MUTED}>nozzles</text>
    </g>
  );
}
