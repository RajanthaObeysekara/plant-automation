export default function Sparkline({ points, min, max, color = 'var(--accent)' }) {
  if (!points || points.length < 2) return <div className="sparkline-empty">not enough data yet</div>;

  const w = 240;
  const h = 48;
  const lo = min ?? Math.min(...points);
  const hi = max ?? Math.max(...points);
  const span = hi - lo || 1;

  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((v - lo) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last = coords[coords.length - 1].split(',');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="sparkline" role="img" aria-label="recent trend">
      <polyline points={coords.join(' ')} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />
    </svg>
  );
}
