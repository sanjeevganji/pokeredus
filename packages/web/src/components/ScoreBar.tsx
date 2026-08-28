import { displayFraction } from '../lib/live-score';

export interface ScoreParts {
  ourHealth: number;
  theirHealth: number;
  ourModifier: number;
  theirModifier: number;
}

/** |value| of 1 fills origin → edge when no part exceeds that. */
export const CHOICE_BAR_DOMAIN = 1;

export type FieldDir = 'in' | 'out';
export type FieldSide = 'ours' | 'theirs';

export interface FieldSeg {
  key: string;
  side: FieldSide;
  dir: FieldDir;
  color: string;
  value: number;
  label: string;
}

const RED = 'var(--neon-red)';
const GREEN = 'var(--neon-green)';
const YELLOW = 'var(--neon-yellow)';

/** Same origin-centered domain for visual width and ARIA min/max. */
export function scoreBarDomain(score: number, parts?: Partial<ScoreParts>): number {
  const abs = [
    score,
    parts?.ourHealth,
    parts?.theirHealth,
    parts?.ourModifier,
    parts?.theirModifier,
  ].filter((v): v is number => v != null && Number.isFinite(v)).map((v) => Math.abs(v));
  return Math.max(CHOICE_BAR_DOMAIN, ...abs);
}

/** Center origin: damage/debuff inward, heal/buff outward. Left = us, right = them. */
export function fieldBarSegments(parts?: Partial<ScoreParts>): FieldSeg[] {
  const segs: FieldSeg[] = [];
  const push = (
    key: string,
    side: FieldSide,
    raw: number,
    kind: 'hp' | 'mod',
  ) => {
    if (!Number.isFinite(raw) || Math.abs(raw) <= 1e-9) return;
    const hurt = raw < 0;
    segs.push({
      key,
      side,
      dir: hurt ? 'in' : 'out',
      color: kind === 'hp' ? (hurt ? RED : GREEN) : YELLOW,
      value: Math.abs(raw),
      label: kind === 'hp'
        ? (hurt ? `${side} damage` : `${side} heal`)
        : (hurt ? `${side} drop` : `${side} boost`),
    });
  };
  push('ourHealth', 'ours', parts?.ourHealth ?? 0, 'hp');
  push('ourModifier', 'ours', parts?.ourModifier ?? 0, 'mod');
  push('theirHealth', 'theirs', parts?.theirHealth ?? 0, 'hp');
  push('theirModifier', 'theirs', parts?.theirModifier ?? 0, 'mod');
  return segs;
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
  const segs = fieldBarSegments(parts);
  const domain = scoreBarDomain(score, parts);
  const pct = (v: number) => (v / domain) * 50;
  const arm = (side: FieldSide, dir: FieldDir) => segs.filter((s) => s.side === side && s.dir === dir);
  const oursOut = arm('ours', 'out');
  const oursIn = arm('ours', 'in');
  const theirsIn = arm('theirs', 'in');
  const theirsOut = arm('theirs', 'out');
  return (
    <div
      className="choice-track field-bar"
      role="meter"
      aria-label={label}
      aria-valuemin={-domain}
      aria-valuemax={domain}
      aria-valuenow={Number(score.toFixed(3))}
    >
      <div className="field-origin" />
      {oursOut.length > 0 && (
        <div className="field-arm field-ours-out" style={{ width: `${oursOut.reduce((s, x) => s + pct(x.value), 0)}%` }}>
          {oursOut.map((s) => (
            <div key={s.key} className="score-seg" title={`${s.label} ${s.value.toFixed(2)}`} style={{ flex: s.value, background: s.color }} />
          ))}
        </div>
      )}
      {oursIn.length > 0 && (
        <div className="field-arm field-ours-in" style={{ width: `${oursIn.reduce((s, x) => s + pct(x.value), 0)}%` }}>
          {oursIn.map((s) => (
            <div key={s.key} className="score-seg" title={`${s.label} ${s.value.toFixed(2)}`} style={{ flex: s.value, background: s.color }} />
          ))}
        </div>
      )}
      {theirsIn.length > 0 && (
        <div className="field-arm field-theirs-in" style={{ width: `${theirsIn.reduce((s, x) => s + pct(x.value), 0)}%` }}>
          {theirsIn.map((s) => (
            <div key={s.key} className="score-seg" title={`${s.label} ${s.value.toFixed(2)}`} style={{ flex: s.value, background: s.color }} />
          ))}
        </div>
      )}
      {theirsOut.length > 0 && (
        <div className="field-arm field-theirs-out" style={{ width: `${theirsOut.reduce((s, x) => s + pct(x.value), 0)}%` }}>
          {theirsOut.map((s) => (
            <div key={s.key} className="score-seg" title={`${s.label} ${s.value.toFixed(2)}`} style={{ flex: s.value, background: s.color }} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Visual width uses log displayFraction; aria-valuenow stays the raw weight. */
export function PolicyMeter({
  value,
  label,
  opponent,
}: {
  value: number;
  label: string;
  opponent?: boolean;
}) {
  const p = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={`choice-p${opponent ? ' choice-p-opp' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(p.toFixed(4))}
    >
      <div
        className={`choice-p-fill${opponent ? ' choice-p-fill-opp' : ''}`}
        style={{ width: `${displayFraction(p) * 100}%` }}
      />
    </div>
  );
}
