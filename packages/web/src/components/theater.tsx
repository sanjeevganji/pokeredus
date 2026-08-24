import { useState } from 'react';
import type { LiveField, LiveSlot } from '../lib/games';

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

function SlotRow({ slot, accent }: { slot: LiveSlot; accent: 'cyan' | 'pink' }) {
  const revealed = slot.revealed;
  const max = Math.max(slot.maxHp || 0, 1);
  const ratio = slot.fainted || !revealed ? 0 : Math.max(0, Math.min(1, slot.hp / max));
  const color = !revealed ? 'var(--fg-dim)' : ratio < 0.25 ? 'var(--neon-red)' : ratio < 0.5 ? 'var(--neon-yellow)' : `var(--neon-${accent})`;
  const name = revealed ? prettySpecies(slot.speciesId) : 'Unknown';
  const hpLabel = revealed ? (slot.fainted ? 'fainted' : `${slot.hp}/${slot.maxHp}`) : 'hidden';
  return (
    <li className={`slot-row${slot.fainted ? ' slot-fainted' : ''}${slot.active ? ' slot-active' : ''}${revealed ? '' : ' slot-hidden'}`}>
      <Sprite speciesId={revealed ? slot.speciesId : ''} />
      <div className="slot-body">
        <div className="slot-meta">
          <span>{slot.active ? '● ' : ''}{name}</span>
          {revealed && slot.status ? <span className="status-pill">{slot.status}</span> : null}
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
      </div>
    </li>
  );
}

export function Bench({
  title, slots, field, accent, area, tera,
}: {
  title: string;
  slots: LiveSlot[];
  field?: LiveField['ours'];
  accent: 'cyan' | 'pink';
  area?: string;
  tera?: boolean;
}) {
  const six = [...slots];
  while (six.length < 6) {
    six.push({
      speciesId: '', hp: 0, maxHp: 100, status: '', fainted: false, active: false, revealed: false,
    });
  }
  return (
    <section className={`card bench bench-${accent}${area ? ` theater-${area}` : ''}${tera ? ' tera-mode' : ''}`}>
      <h2 className="bench-title">{title}</h2>
      <SideFieldBadges side={field} />
      <ul className="bench-list">
        {six.slice(0, 6).map((s, i) => <SlotRow key={i} slot={s} accent={accent} />)}
      </ul>
    </section>
  );
}
