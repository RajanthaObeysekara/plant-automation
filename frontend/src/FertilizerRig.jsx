// Visualizes the automated fertigation pipeline: concentrate is mixed into
// batch water, stirred for a uniform mix, run through the inline filter,
// then dosed out to the nozzles. Driven by the same live `activity` string
// as everything else (see App.jsx's socket status handler) — not decorative.
const STAGES = [
  { key: 'mixing', label: 'Mix' },
  { key: 'stirring', label: 'Stir' },
  { key: 'filtering', label: 'Filter' },
  { key: 'feeding', label: 'Nozzles' },
];

export default function FertilizerRig({ activity, doseMl, mixRatioMlPerL, batchWaterL, compact }) {
  const activeIndex = STAGES.findIndex((s) => s.key === activity);
  const running = activeIndex !== -1;
  const label = running ? `${STAGES[activeIndex].label === 'Nozzles' ? 'Dosing' : STAGES[activeIndex].label + 'ring'}…` : 'Idle';
  const concentrateMl = mixRatioMlPerL && batchWaterL ? Math.round(mixRatioMlPerL * batchWaterL) : null;

  const W = 220, H = 46;
  const step = (W - 48) / (STAGES.length - 1);
  const cx = (i) => 24 + i * step;
  const cy = H / 2;

  return (
    <div className={`fert-rig ${compact ? 'compact' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} width={compact ? 140 : 220} height={compact ? 30 : 46} role="img" aria-label={`Fertigation system: ${label}`}>
        <line x1={cx(0)} y1={cy} x2={cx(STAGES.length - 1)} y2={cy} stroke="var(--line-strong)" strokeWidth="2" />
        {running && activeIndex > 0 && (
          <line x1={cx(0)} y1={cy} x2={cx(activeIndex)} y2={cy} stroke="var(--fert)" strokeWidth="2" />
        )}
        {STAGES.map((s, i) => {
          const active = i === activeIndex;
          const passed = running && i < activeIndex;
          return (
            <g key={s.key}>
              <circle cx={cx(i)} cy={cy} r={active ? 8 : 6}
                fill={active || passed ? 'var(--fert)' : 'var(--surface)'}
                stroke={active || passed ? 'var(--fert)' : 'var(--line-strong)'} strokeWidth="1.5"
                className={active ? 'fert-node-active' : ''} />
            </g>
          );
        })}
      </svg>
      <div className="fert-rig-stages">
        {STAGES.map((s, i) => (
          <span key={s.key} className={i === activeIndex ? 'active' : ''}>{s.label}</span>
        ))}
      </div>
      {!compact && (
        <div className="fert-rig-label" style={{ color: running ? 'var(--fert-ink)' : 'var(--muted)' }}>
          {label}
          {running && doseMl ? ` — dosing ${doseMl} mL` : ''}
          {!running && concentrateMl ? ` — next mix: ${concentrateMl} mL in ${batchWaterL} L` : ''}
        </div>
      )}
    </div>
  );
}
