// Real-data tank visualization — 3 discrete float-switch states (FULL/MID/
// LOW), never an interpolated percentage the actual hardware can't report.
// Matches the approved design pass: a rectangular vessel with dashed
// threshold lines and a filled rect that only ever snaps to one of the 3
// real boundaries, plus an explicit "3 float switches, no interpolated %"
// caption so nobody mistakes the fill height for a continuous reading.
const ACTIVITY_META = {
  overflow: { fill: 'var(--crit)', label: 'Overflow — check tank' },
  dechlorinating: { fill: 'var(--warn)', label: null }, // shown separately as a countdown line, not the tank color
  filling: { fill: 'var(--water)', label: 'Filling' },
};

export default function WaterTank({ waterLow, waterFull, activity, dechlorLeftLabel, compact }) {
  const known = waterLow !== undefined && waterLow !== null;
  const level = !known ? 'unknown' : waterFull ? 'full' : waterLow ? 'mid' : 'low';
  const meta = ACTIVITY_META[activity];
  const fillColor = meta && meta.fill !== undefined ? meta.fill : (known ? 'var(--water)' : 'var(--faint)');

  const W = 90, H = 130;
  const bodyX = 10, bodyY = 14, bodyW = 70, bodyH = 106;
  const lineFull = bodyY + bodyH * 0.24;
  const lineMid = bodyY + bodyH * 0.47;
  const lineLow = bodyY + bodyH * 0.78;
  // Fill only ever snaps to a real boundary: full → to the FULL line, mid →
  // to the MID line, low → a thin sliver at the bottom (never truly empty
  // in the UI, since "low" still means the low switch is wet), unknown →
  // nothing drawn.
  const fillTop = level === 'full' ? lineFull : level === 'mid' ? lineMid : level === 'low' ? bodyY + bodyH - 10 : null;

  const statusLabel = meta?.label
    ?? (level === 'full' ? 'Full' : level === 'mid' ? 'Mid' : level === 'low' ? 'Low — due for a fill' : 'No sensor data');

  return (
    <div className={`tank-widget ${compact ? 'compact' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={compact ? 46 : 82} height={compact ? 66 : 120} role="img" aria-label={`Water tank: ${statusLabel}`}>
        <rect x={bodyX} y={bodyY} width={bodyW} height={bodyH} rx="7" fill="var(--bg)" stroke="var(--line-strong)" />
        {fillTop != null && (
          <>
            <rect x={bodyX + 4} y={fillTop} width={bodyW - 8} height={bodyY + bodyH - fillTop - 4} rx="4"
              fill={fillColor} opacity="0.35" />
            <rect x={bodyX + 4} y={fillTop} width={bodyW - 8} height="4" fill={fillColor} className="tank-ripple" />
          </>
        )}
        <line x1={bodyX} y1={lineFull} x2={bodyX + bodyW} y2={lineFull} stroke="var(--line-strong)" strokeDasharray="3 3" />
        <line x1={bodyX} y1={lineMid} x2={bodyX + bodyW} y2={lineMid} stroke="var(--line-strong)" strokeDasharray="3 3" />
        <line x1={bodyX} y1={lineLow} x2={bodyX + bodyW} y2={lineLow} stroke="var(--line-strong)" strokeDasharray="3 3" />
        <rect x={W / 2 - 7} y="2" width="14" height="12" fill="var(--line-strong)" />
        {activity === 'overflow' && <circle cx={bodyX + bodyW - 6} cy={bodyY + 6} r="4" fill="var(--crit)" className="tank-alert-dot" />}
      </svg>
      {!compact && (
        <div className="tank-legend">
          <div className="tank-legend-row"><span className={`tank-dot ${level === 'full' ? 'on' : ''}`} />FULL{level === 'full' ? ' — open' : ' — closed'}</div>
          <div className="tank-legend-row"><span className={`tank-dot ${level === 'mid' || level === 'full' ? 'on' : ''}`} />MID{level === 'full' ? ' — open' : level === 'mid' ? ' — closed' : ''}</div>
          <div className="tank-legend-row"><span className={`tank-dot ${level !== 'unknown' ? 'on' : ''}`} />LOW{level === 'low' ? ' — closed' : ''}</div>
          <div className="tank-legend-note">3 FLOAT SWITCHES.<br />NO INTERPOLATED %.</div>
        </div>
      )}
      {!compact && <div className="tank-label" style={{ color: fillColor }}>{statusLabel}{dechlorLeftLabel ? ` · dechlor ${dechlorLeftLabel}` : ''}</div>}
    </div>
  );
}
