export interface ScoreParts {
  ourHealth: number;
  theirHealth: number;
  ourModifier: number;
  theirModifier: number;
}

/** |value| of 1 fills origin → edge. Parts are HP/mod deltas already in [-1, 1]. */
export const CHOICE_BAR_DOMAIN = 1;

const SEGMENTS: Array<{ key: keyof ScoreParts; color: string; label: string; flip: boolean }> = [
  { key: 'ourHealth', color: 'var(--neon-cyan)', label: 'our HP', flip: false },
  { key: 'ourModifier', color: 'var(--neon-yellow)', label: 'our mods', flip: false },
  { key: 'theirHealth', color: 'var(--neon-pink)', label: 'their HP', flip: true },
  { key: 'theirModifier', color: 'var(--neon-purple)', label: 'their mods', flip: true },
];

type BarSeg = { key: string; value: number; color: string; label: string };

/** Our-POV signed parts, scaled so their net equals `score` (turn/choice score). */
export function scaledChoiceSegments(score: number, parts?: Partial<ScoreParts>): BarSeg[] {
  const raw: BarSeg[] = SEGMENTS.map((seg) => {
    const v = parts?.[seg.key] ?? 0;
    return { key: seg.key, value: seg.flip ? -v : v, color: seg.color, label: seg.label };
  });
  const net = raw.reduce((s, x) => s + x.value, 0);
  if (Math.abs(net) <= 1e-9) {
    if (Math.abs(score) <= 1e-9) return [];
    return [{
      key: 'score',
      value: score,
      color: score >= 0 ? 'var(--neon-cyan)' : 'var(--neon-pink)',
      label: 'turn score',
    }];
  }
  const k = score / net;
  return raw
    .map((s) => ({ ...s, value: s.value * k }))
    .filter((s) => Math.abs(s.value) > 1e-9);
}

export function ScoreBar({
  score,
  parts,
  label,
}: {
  score: number;
  parts?: Partial<ScoreParts>;
  label: string;
}) {
  const segs = scaledChoiceSegments(score, parts);
  const pos = segs.filter((s) => s.value > 0);
  const neg = segs.filter((s) => s.value < 0);
  const pct = (v: number) => (Math.abs(v) / CHOICE_BAR_DOMAIN) * 50;
  const posPct = Math.min(50, pos.reduce((s, x) => s + pct(x.value), 0));
  const negPct = Math.min(50, neg.reduce((s, x) => s + pct(x.value), 0));
  return (
    <div
      className="choice-track bipolar"
      role="meter"
      aria-label={label}
      aria-valuemin={-CHOICE_BAR_DOMAIN}
      aria-valuemax={CHOICE_BAR_DOMAIN}
      aria-valuenow={Number(score.toFixed(3))}
    >
      <div className="bipolar-mid" />
      {negPct > 0 && (
        <div className="bipolar-arm bipolar-neg" style={{ width: `${negPct}%` }}>
          {neg.map((s) => (
            <div
              key={s.key}
              className="score-seg"
              title={`${s.label} ${s.value.toFixed(2)}`}
              style={{ flex: Math.abs(s.value), background: s.color }}
            />
          ))}
        </div>
      )}
      {posPct > 0 && (
        <div className="bipolar-arm bipolar-pos" style={{ width: `${posPct}%` }}>
          {pos.map((s) => (
            <div
              key={s.key}
              className="score-seg"
              title={`${s.label} ${s.value.toFixed(2)}`}
              style={{ flex: Math.abs(s.value), background: s.color }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
