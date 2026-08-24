export interface ScoreParts {
  ourHealth: number;
  theirHealth: number;
  ourModifier: number;
  theirModifier: number;
}

const SEGMENTS: Array<{ key: keyof ScoreParts; color: string; label: string }> = [
  { key: 'ourHealth', color: 'var(--neon-cyan)', label: 'our HP' },
  { key: 'ourModifier', color: 'var(--neon-yellow)', label: 'our mods' },
  { key: 'theirHealth', color: 'var(--neon-pink)', label: 'their HP' },
  { key: 'theirModifier', color: 'var(--neon-purple)', label: 'their mods' },
];

export function ScoreBar({
  score,
  maxAbs,
  parts,
  label,
}: {
  score: number;
  maxAbs: number;
  parts?: Partial<ScoreParts>;
  label: string;
}) {
  const span = Math.max(maxAbs, 0.01);
  const width = (Math.abs(score) / span) * 100;
  const pos = score >= 0;
  const mag = {
    ourHealth: Math.abs(parts?.ourHealth ?? 0),
    ourModifier: Math.abs(parts?.ourModifier ?? 0),
    theirHealth: Math.abs(parts?.theirHealth ?? 0),
    theirModifier: Math.abs(parts?.theirModifier ?? 0),
  };
  const sum = mag.ourHealth + mag.ourModifier + mag.theirHealth + mag.theirModifier;
  return (
    <div
      className="choice-track score-stack"
      role="meter"
      aria-label={label}
      aria-valuemin={-span}
      aria-valuemax={span}
      aria-valuenow={Number(score.toFixed(3))}
    >
      <div
        className="score-stack-inner"
        style={{
          width: `${width}%`,
          marginLeft: pos ? 0 : `${100 - width}%`,
        }}
      >
        {sum > 0 ? SEGMENTS.map((seg) => {
          const pct = (mag[seg.key] / sum) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.key}
              className="score-seg"
              title={`${seg.label} ${parts?.[seg.key]?.toFixed(2) ?? 0}`}
              style={{ width: `${pct}%`, background: seg.color }}
            />
          );
        }) : (
          <div className="score-seg" style={{ width: '100%', background: pos ? 'var(--neon-cyan)' : 'var(--neon-pink)' }} />
        )}
      </div>
    </div>
  );
}
