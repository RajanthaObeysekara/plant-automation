import { useEffect, useState } from 'react';
import { api } from './api';

// Live view of the room's water rig, laid out like the plumbing:
//
//   mains -> [input valve] -> BUCKET (on the scale, top + bottom floats)
//   output <- [pump] <- [output valve] <- BUCKET
//
// Fed by plant/device/water snapshots (backend: deviceIngest.ingestWater)
// pushed live as `room_water`, plus GET /rooms/:id/water on mount.

const STALE_MS = 3 * 60 * 1000; // board heartbeats every 60s

function Valve({ x, y, open, label }) {
  const c = open ? 'var(--good)' : 'var(--line-strong)';
  return (
    <g transform={`translate(${x} ${y})`}>
      <polygon points="0,-26 34,0 0,26 -34,0" fill="var(--surface-sunken)" stroke={c} strokeWidth="2" />
      <text y="-2" textAnchor="middle" className="rig-label">{label}</text>
      <text y="13" textAnchor="middle" className="rig-state" fill={c}>{open ? 'OPEN' : 'CLOSED'}</text>
    </g>
  );
}

function Pipe({ d, flowing, reverse }) {
  return (
    <g>
      <path d={d} className="rig-pipe" />
      {flowing && <path d={d} className={`rig-flow ${reverse ? 'rig-flow--rev' : ''}`} />}
    </g>
  );
}

export default function WaterRig({ room, socket }) {
  const [w, setW] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    api.water(room.id).then((s) => { if (alive && s) setW(s); }).catch(() => {});
    function onWater(s) { if (s.roomId === room.id) setW(s); }
    socket.on('room_water', onWater);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; socket.off('room_water', onWater); clearInterval(t); };
  }, [socket, room.id]);

  if (!w) {
    return (
      <div className="card">
        <h3>Water rig</h3>
        <p className="muted small">No water-rig report from this room's controller yet. Boards with tank sensors send one on every change and every minute (firmware v1.0.9+).</p>
      </div>
    );
  }

  const age = now - new Date(w.receivedAt).getTime();
  const stale = age > STALE_MS;
  // Pump countdown keeps ticking locally between snapshots.
  const left = w.pumpState === 'running' && w.pumpSecondsLeft >= 0
    ? Math.max(0, w.pumpSecondsLeft - Math.floor(age / 1000)) : null;
  const alarm = /FAULT|TIMEOUT/.test(w.status);
  const level = !w.levelsKnown ? null : w.topWet ? 0.9 : w.bottomWet ? 0.55 : 0.14;
  const levelText = !w.levelsKnown ? 'levels unknown'
    : w.topWet && !w.bottomWet ? 'sensor fault' : w.topWet ? 'full' : w.bottomWet ? 'between marks' : 'below low mark';

  // Bucket geometry (trapezoid, wider at the top like the drawing)
  const top = 70, bot = 228, tl = 470, tr = 610, bl = 500, br = 580;
  const waterY = level == null ? bot : bot - (bot - top) * level;
  const edgeAt = (y) => { const k = (y - top) / (bot - top); return [tl + (bl - tl) * k, tr + (br - tr) * k]; };
  const [wl, wr] = edgeAt(waterY);

  return (
    <div className={`card water-rig ${stale ? 'water-rig--stale' : ''}`}>
      <div className="water-rig-head">
        <h3>Water rig</h3>
        <span className={`rig-pill ${alarm ? 'rig-pill--alarm' : w.status ? 'rig-pill--active' : ''}`}>
          {w.relayTest ? 'RELAY TEST - water control paused' : w.status || 'Idle'}
          {left != null ? ` (${left}s left)` : ''}
        </span>
        <span className="muted small">{stale ? 'no report for ' : 'updated '}{Math.round(age / 1000)}s ago{w.fw ? ` · fw ${w.fw}` : ''}</span>
      </div>
      <svg viewBox="0 0 820 300" className="rig-svg" role="img" aria-label="Water rig diagram">
        {/* input line: mains -> input valve -> bucket */}
        <text x="70" y="70" className="rig-label" textAnchor="middle">Mains water</text>
        <Pipe d="M 40 100 L 300 100" flowing={w.inputValve} />
        <Pipe d="M 368 100 L 520 100" flowing={w.inputValve} />
        <Valve x={334} y={100} open={w.inputValve} label="Input valve" />

        {/* bucket */}
        <path d={`M ${tl} ${top} L ${bl} ${bot} L ${br} ${bot} L ${tr} ${top}`} className="rig-bucket" />
        {level != null && (
          <path d={`M ${wl} ${waterY} L ${bl} ${bot} L ${br} ${bot} L ${wr} ${waterY} Z`} className="rig-water" />
        )}
        <text x={(tl + tr) / 2} y={top - 12} textAnchor="middle" className="rig-label">Bucket · {levelText}</text>
        {/* level sensors */}
        <circle cx={tr - 10} cy={top + 22} r="7" fill={w.topWet ? 'var(--good)' : 'var(--surface-sunken)'} stroke="var(--line-strong)" />
        <text x={tr + 6} y={top + 26} className="rig-label">Top sensor {w.topWet ? 'wet' : 'dry'}</text>
        <circle cx={br - 6} cy={bot - 22} r="7" fill={w.bottomWet ? 'var(--good)' : 'var(--warn)'} stroke="var(--line-strong)" />
        <text x={br + 10} y={bot - 18} className="rig-label">Bottom sensor {w.bottomWet ? 'wet' : 'dry'}</text>

        {/* scale */}
        <rect x="485" y={bot + 6} width="110" height="30" rx="4" className="rig-scale" />
        <text x="540" y={bot + 26} textAnchor="middle" className="rig-weight">
          {w.weightKg != null ? `${w.weightKg.toFixed(1)} kg` : 'no scale'}
        </text>

        {/* output line: bucket -> output valve -> pump -> output */}
        <Pipe d={`M ${bl + 6} ${bot - 8} L 390 ${bot - 8}`} flowing={w.outputValve} reverse />
        <Valve x={356} y={bot - 8} open={w.outputValve} label="Output valve" />
        <Pipe d={`M 322 ${bot - 8} L 225 ${bot - 8}`} flowing={w.pump} reverse />
        <g transform={`translate(190 ${bot - 8})`}>
          <circle r="32" fill="var(--surface-sunken)" stroke={w.pump ? 'var(--water)' : 'var(--line-strong)'} strokeWidth="2" />
          <g className={w.pump ? 'rig-impeller rig-impeller--on' : 'rig-impeller'}>
            <path d="M0 -20 L5 0 L0 20 L-5 0 Z" fill={w.pump ? 'var(--water)' : 'var(--faint)'} />
            <path d="M-20 0 L0 5 L20 0 L0 -5 Z" fill={w.pump ? 'var(--water)' : 'var(--faint)'} />
          </g>
          <text y="48" textAnchor="middle" className="rig-label">Pump {w.pump ? 'ON' : 'off'}</text>
        </g>
        <Pipe d={`M 158 ${bot - 8} L 30 ${bot - 8}`} flowing={w.pump} reverse />
        <text x="40" y={bot - 20} className="rig-label">Output</text>
      </svg>
      <div className="rig-legend muted small">
        Refill: opens below the bottom sensor, closes at the top · Pump: output valve opens first, pump stops first ·
        Dry-run guard stops the pump if water drops below the bottom sensor.
      </div>
    </div>
  );
}
