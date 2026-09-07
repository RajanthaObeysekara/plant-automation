// Real-data tank visualization — fill height and color come from the actual
// low/full sensor booleans and live activity string (see App.jsx's socket
// telemetry/status handlers), not a decorative fake animation. There is no
// continuous 0-100% level in the real hardware (only two discrete sensor
// points), so this deliberately renders 3 honest levels rather than
// implying precision the sensors don't have.
const ACTIVITY_META = {
  overflow: { fill: 'var(--crit)', label: 'Overflow — check tank', pulse: true },
  dechlorinating: { fill: 'var(--warn)', label: 'Dechlorinating — misting held', pulse: false },
  filling: { fill: 'var(--water)', label: 'Filling…', pulse: true },
  misting: { fill: 'var(--water)', label: 'Misting from this tank', pulse: false },
};

export default function WaterTank({ waterLow, waterFull, activity, compact }) {
  const known = waterLow !== undefined && waterLow !== null;
  // 3 honest levels: at/below low mark, between low and full, at/above full mark.
  const levelFrac = !known ? 0.5 : waterFull ? 0.88 : waterLow ? 0.16 : 0.55;

  const meta = ACTIVITY_META[activity];
  const fillColor = meta ? meta.fill : (known ? 'var(--water)' : 'var(--faint)');
  const label = meta ? meta.label
    : !known ? 'No sensor data yet'
    : waterLow ? 'Low — due for a fill' : 'OK';

  const W = 120, H = 140;
  const bodyTop = 18, bodyBottom = 128, bodyLeft = 14, bodyRight = 106;
  const bodyH = bodyBottom - bodyTop;
  const waterY = bodyBottom - levelFrac * bodyH;
  const clipId = `tankClip-${compact ? 'sm' : 'lg'}-${activity || 'x'}-${waterLow}-${waterFull}`;

  return (
    <div className={`tank-widget ${compact ? 'compact' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={compact ? 64 : 108} height={compact ? 74 : 126} role="img" aria-label={`Water tank: ${label}`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={bodyLeft} y={bodyTop} width={bodyRight - bodyLeft} height={bodyH} rx="4" />
          </clipPath>
        </defs>

        {/* mesh lid — loose, never sealed (chlorine off-gas) */}
        <line x1={bodyLeft - 4} y1={bodyTop} x2={bodyRight + 4} y2={bodyTop} stroke="var(--line-strong)" strokeWidth="2" strokeDasharray="3 2" />

        {/* tank body outline */}
        <rect x={bodyLeft} y={bodyTop} width={bodyRight - bodyLeft} height={bodyH} rx="4"
          fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.5" />

        {/* animated water fill, clipped to the tank body */}
        <g clipPath={`url(#${clipId})`}>
          <rect x={bodyLeft} y={waterY} width={bodyRight - bodyLeft} height={bodyBottom - waterY}
            fill={fillColor} opacity="0.55" />
          <path className="tank-wave" fill={fillColor} opacity="0.85"
            d={`M${bodyLeft - 40},${waterY} a40,6 0 1,0 80,0 a40,6 0 1,0 80,0 a40,6 0 1,0 80,0 V${H} H${bodyLeft - 40} Z`} />
        </g>

        {/* low/full sensor marks */}
        <line x1={bodyRight + 2} y1={bodyBottom - 0.16 * bodyH} x2={bodyRight + 8} y2={bodyBottom - 0.16 * bodyH} stroke="var(--muted)" strokeWidth="1.5" />
        <line x1={bodyRight + 2} y1={bodyBottom - 0.88 * bodyH} x2={bodyRight + 8} y2={bodyBottom - 0.88 * bodyH} stroke="var(--muted)" strokeWidth="1.5" />

        {activity === 'overflow' && (
          <circle cx={bodyRight - 6} cy={bodyTop + 6} r="4" fill="var(--crit)" className="tank-alert-dot" />
        )}
      </svg>
      {!compact && <div className="tank-label" style={{ color: fillColor }}>{label}</div>}
    </div>
  );
}
