import { useState } from 'react';
import type { CanonicalSet, LiveField, LiveSlot } from '../lib/games';

const STAT_LABEL: Record<string, string> = {
  atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva',
};

export function prettySpecies(id: string): string {
  if (!id) return '?';
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function actionLabel(id: string, slots?: LiveSlot[]): string {
  if (id.startsWith('move:')) {
    return prettySpecies(id.slice(5).replace(/:tera$/, ''));
  }
  if (id.startsWith('switch:')) {
    const n = Number(id.slice(7));
    const slot = Number.isFinite(n) ? slots?.[n - 1] : undefined;
    if (slot?.revealed && slot.speciesId) return `Switch ${prettySpecies(slot.speciesId)}`;
    return `Switch ${n || id}`;
  }
  return id;
}

export function hkoLabel(n: number | null | undefined): string {
  if (n == null || n < 1) return '—';
  if (n === 1) return 'OHKO';
  if (n <= 3) return `${n}HKO`;
  return '—';
}

export function FieldBadges({ field }: { field?: LiveField }) {
  if (!field) return null;
  const pills: string[] = [];
  if (field.weather) pills.push(field.weather);
  if (field.terrain) pills.push(field.terrain);
  if (field.trickroom) pills.push('TR');
  return (
    <>
      {pills.map((p) => <span key={p} className="status-pill">{p}</span>)}
    </>
  );
}

export function SideFieldBadges({ side }: { side?: LiveField['ours'] }) {
  if (!side) return null;
  const pills: string[] = [];
  const h = side.hazards;
  if (h?.stealthrock) pills.push('SR');
  if (h?.spikes) pills.push(`spikes ${h.spikes}`);
  if (h?.toxicspikes) pills.push(`tspikes ${h.toxicspikes}`);
  if (h?.stickyweb) pills.push('web');
  if (side.reflect) pills.push('Reflect');
  if (side.lightscreen) pills.push('Light Screen');
  if (!pills.length) return null;
  return (
    <div className="side-pills">
      {pills.map((p) => <span key={p} className="status-pill">{p}</span>)}
    </div>
  );
}

export function Sprite({ speciesId }: { speciesId: string }) {
  const [failed, setFailed] = useState(false);
  if (!speciesId || failed) {
    return <div className="sprite sprite-empty" aria-hidden="true" />;
  }
  return (
    <img
      className="sprite"
      alt=""
      width={40}
      height={40}
      src={`https://play.pokemonshowdown.com/sprites/gen5/${speciesId}.png`}
      onError={() => setFailed(true)}
    />
  );
}

function BoostPills({ slot }: { slot: LiveSlot }) {
  if (!slot.revealed || !slot.boosts) return null;
  const bits: string[] = [];
  for (const [k, v] of Object.entries(slot.boosts)) {
    if (!v) continue;
    bits.push(`${v > 0 ? '+' : ''}${v} ${STAT_LABEL[k] ?? k}`);
  }
  for (const m of slot.modifiers ?? []) {
    if (m.name.startsWith('boost:')) continue;
    bits.push(m.name);
  }
  if (!bits.length) return null;
  return (
    <span className="boost-pills" title={bits.join(', ')}>
      {bits.map((b) => <span key={b} className="status-pill">{b}</span>)}
    </span>
  );
}

function provenanceLabel(slot: LiveSlot): string {
  if (!slot.revealed) return '';
  const tera = slot.teraType || slot.assumedSet?.teraType;
  const teraSuffix = tera ? ` · Tera ${tera}` : '';
  if (!slot.setComplete || slot.setSource === 'incomplete') return `Incomplete${teraSuffix}`;
  if (slot.setSource === 'manual') return `Manual assumption${teraSuffix}`;
  if (slot.setSource === 'public') return `Public assumption${teraSuffix}`;
  if (slot.setSource === 'revealed') return `Revealed${teraSuffix}`;
  return `Revealed${teraSuffix}`;
}

function currentRole(slot: LiveSlot): string {
  if (slot.assumedSet?.role) return slot.assumedSet.role;
  const tera = (slot.assumedSet?.teraType || slot.teraType || '').toLowerCase();
  const hit = slot.setOptions?.find((o) =>
    (!tera || o.teraTypes.some((t) => t.toLowerCase() === tera) || (o.set.teraType || '').toLowerCase() === tera)
    && o.compatible,
  ) ?? slot.setOptions?.[0];
  return hit?.role ?? '';
}

function currentTera(slot: LiveSlot): string {
  return slot.assumedSet?.teraType || slot.teraType || '';
}

function SlotRow({
  slot, accent, onEditSet, onAssumeSet,
}: {
  slot: LiveSlot;
  accent: 'cyan' | 'pink';
  onEditSet?: (slot: LiveSlot, opener: HTMLElement) => void;
  onAssumeSet?: (slot: LiveSlot, set: CanonicalSet) => void;
}) {
  const revealed = slot.revealed;
  const max = Math.max(slot.maxHp || 0, 1);
  const ratio = slot.fainted || !revealed ? 0 : Math.max(0, Math.min(1, slot.hp / max));
  const color = !revealed ? 'var(--fg-dim)' : ratio < 0.25 ? 'var(--neon-red)' : ratio < 0.5 ? 'var(--neon-yellow)' : `var(--neon-${accent})`;
  const name = revealed ? prettySpecies(slot.speciesId) : 'Unknown';
  const hpLabel = revealed ? (slot.fainted ? 'fainted' : `${slot.hp}/${slot.maxHp}`) : 'hidden';
  const options = slot.setOptions ?? [];
  const role = currentRole(slot);
  const selected = options.find((o) => o.role === role) ?? options[0];
  const teras = selected?.teraTypes?.length ? selected.teraTypes : (slot.assumedSet?.teraType ? [slot.assumedSet.teraType] : []);
  const tera = currentTera(slot);

  function pickRole(nextRole: string) {
    const opt = options.find((o) => o.role === nextRole);
    if (!opt || !onAssumeSet) return;
    const keep = opt.teraTypes.some((t) => t.toLowerCase() === tera.toLowerCase())
      ? tera
      : opt.teraTypes[0];
    onAssumeSet(slot, { ...opt.set, teraType: keep || opt.set.teraType });
  }

  function pickTera(nextTera: string) {
    if (!onAssumeSet) return;
    const base = slot.assumedSet ?? selected?.set;
    if (!base) return;
    onAssumeSet(slot, { ...base, teraType: nextTera || undefined });
  }

  return (
    <li className={`slot-row${slot.fainted ? ' slot-fainted' : ''}${slot.active ? ' slot-active' : ''}${revealed ? '' : ' slot-hidden'}`}>
      <Sprite speciesId={revealed ? slot.speciesId : ''} />
      <div className="slot-body">
        <div className="slot-meta">
          <span>{slot.active ? '● ' : ''}{name}</span>
          {revealed && slot.status ? <span className="status-pill">{slot.status}</span> : null}
          {revealed && onEditSet ? (
            <button
              type="button"
              className={`set-prov${slot.setWarning ? ' set-prov-warn' : ''}`}
              onClick={(e) => onEditSet(slot, e.currentTarget)}
            >
              {provenanceLabel(slot)}
            </button>
          ) : null}
          <BoostPills slot={slot} />
        </div>
        <div
          className="hp-track"
          role="meter"
          aria-label={`${name} HP`}
          aria-valuemin={0}
          aria-valuemax={max}
          aria-valuenow={revealed ? (slot.fainted ? 0 : slot.hp) : 0}
        >
          <div className="hp-fill" style={{ width: `${ratio * 100}%`, background: color }} />
        </div>
        <span className="dim slot-hp">{hpLabel}</span>
        {revealed && onAssumeSet && options.length > 0 && (
          <div className="slot-picks">
            <label className="slot-pick">
              <span>Set</span>
              <select
                aria-label={`${name} set`}
                value={role}
                onChange={(e) => pickRole(e.target.value)}
              >
                {options.map((o) => (
                  <option key={o.role} value={o.role}>
                    {o.role}{o.compatible ? '' : ' (incompatible)'}
                  </option>
                ))}
              </select>
            </label>
            <label className="slot-pick">
              <span>Tera</span>
              <select
                aria-label={`${name} tera type`}
                value={teras.some((t) => t.toLowerCase() === tera.toLowerCase()) ? tera : (teras[0] ?? '')}
                onChange={(e) => pickTera(e.target.value)}
                disabled={teras.length === 0}
              >
                {teras.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        {slot.setWarning ? <span className="set-warn">{slot.setWarning}</span> : null}
      </div>
    </li>
  );
}

export function Bench({
  title, slots, field, accent, area, tera, compact, onEditSet, onAssumeSet,
}: {
  title: string;
  slots: LiveSlot[];
  field?: LiveField['ours'];
  accent: 'cyan' | 'pink';
  area?: string;
  tera?: boolean;
  compact?: boolean;
  onEditSet?: (slot: LiveSlot, opener: HTMLElement) => void;
  onAssumeSet?: (slot: LiveSlot, set: CanonicalSet) => void;
}) {
  const six = [...slots];
  while (six.length < 6) {
    six.push({
      speciesId: '', hp: 0, maxHp: 100, status: '', fainted: false, active: false, revealed: false, setComplete: false,
    });
  }
  const shown = six.slice(0, 6);
  const activeIdx = shown.findIndex((s) => s.active);
  const lead = shown[activeIdx >= 0 ? activeIdx : 0]!;
  const rest = shown.filter((_, i) => i !== (activeIdx >= 0 ? activeIdx : 0));
  return (
    <section className={`card bench bench-${accent}${compact ? ' compact' : ''}${area ? ` theater-${area}` : ''}${tera ? ' tera-mode' : ''}`}>
      <h2 className="bench-title">{title}</h2>
      <SideFieldBadges side={field} />
      {compact ? (
        <>
          <ul className="bench-list">
            <SlotRow slot={lead} accent={accent} onEditSet={onEditSet} onAssumeSet={onAssumeSet} />
          </ul>
          <div className="bench-rest">
            {rest.map((s, i) => {
              const name = s.revealed && s.speciesId ? prettySpecies(s.speciesId) : 'Unknown';
              if (s.revealed && onEditSet) {
                return (
                  <button
                    key={i}
                    type="button"
                    className={`bench-name set-prov${s.fainted ? ' slot-fainted' : ''}${s.setWarning ? ' set-prov-warn' : ''}`}
                    onClick={(e) => onEditSet(s, e.currentTarget)}
                  >
                    {name}
                    <span className="set-prov-mini">{provenanceLabel(s)}</span>
                  </button>
                );
              }
              return (
                <span
                  key={i}
                  className={`bench-name${s.fainted ? ' slot-fainted' : ''}${s.revealed ? '' : ' slot-hidden'}`}
                >
                  {name}
                </span>
              );
            })}
          </div>
        </>
      ) : (
        <ul className="bench-list">
          {shown.map((s, i) => <SlotRow key={i} slot={s} accent={accent} onEditSet={onEditSet} onAssumeSet={onAssumeSet} />)}
        </ul>
      )}
    </section>
  );
}
