import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  detachGame,
  getLiveState,
  type LiveChoice,
  type LiveField,
  type LiveQuantum,
  type LiveReply,
  type LiveSlot,
  type LiveState,
  type LiveTurn,
} from '../lib/games';

const STAT_LABEL: Record<string, string> = {
  atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe', accuracy: 'Acc', evasion: 'Eva',
};

export default function BattleLive() {
  const navigate = useNavigate();
  const [live, setLive] = useState<LiveState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getLiveState().then(setLive).catch(() => { /* ignore */ });
    const t = setInterval(() => {
      getLiveState().then(setLive).catch(() => { /* ignore */ });
    }, 250);
    return () => clearInterval(t);
  }, []);

  const detach = useCallback(async () => {
    setBusy(true);
    try {
      await detachGame();
    } catch { /* still leave the theater */ }
    setBusy(false);
    navigate('/games');
  }, [navigate]);

  const idle = !live.status || live.status === 'idle';
  if (idle) {
    return (
      <div className="theater">
        <div className="theater-empty">
          <h1>No live battle</h1>
          <p className="muted">Attach a Showdown game from Games, or launch PokeLink from the terminal.</p>
          <Link to="/games" className="btn-primary">Detect a battle</Link>
        </div>
      </div>
    );
  }

  const loading = (live.status === 'connecting' || live.status === 'deciding') && !live.eval;

  return (
    <div className="theater">
      <header className="theater-chrome">
        <Link to="/games" className="btn-secondary">Back to Games</Link>
        <h1 className="theater-title">{live.room || 'PokeLink'}</h1>
        <span className={`status-pill status-${live.status}`}>{live.status}</span>
        <span className="muted">turn {live.turn ?? 0}</span>
        <span className="muted">{live.policy}</span>
        <span className="muted">{live.dryRun ? 'dry-run' : 'send'}</span>
        <FieldBadges field={live.field} />
        <button type="button" className="btn-danger" onClick={detach} disabled={busy} style={{ marginLeft: 'auto' }}>
          {busy ? 'Detaching…' : 'Detach'}
        </button>
      </header>

      {live.error && <p className="theater-alert theater-alert-error" role="alert">{live.error}</p>}
      {live.winner && <p className="theater-alert theater-alert-win" role="status">{live.winner} wins</p>}

      {loading ? (
        <TheaterSkeleton />
      ) : (
        <>
          <ScoreStrip state={live} />
          <div className="theater-body">
            <Bench area="ours" title="Ours" slots={live.ours ?? []} field={live.field?.ours} accent="cyan" />
            <ChoiceList
              area="ourc"
              title="Our choices"
              rows={rankOurs(live.eval?.choices ?? [])}
              sampled={live.eval?.sampledAction}
              quantum={live.eval?.quantum}
              slots={live.ours}
              ours
            />
            <Bench area="theirs" title="Theirs" slots={live.theirs ?? []} field={live.field?.theirs} accent="pink" />
            <ChoiceList
              area="theirc"
              title="Their replies"
              rows={rankTheirs(live.eval?.replies ?? [])}
              slots={live.theirs}
            />
          </div>
        </>
      )}

      <details className="theater-log">
        <summary>Protocol log</summary>
        <pre className="event-log">{formatEvents(live.events)}</pre>
      </details>
    </div>
  );
}

function FieldBadges({ field }: { field?: LiveField }) {
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

function SideFieldBadges({ side }: { side?: LiveField['ours'] }) {
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

function Bench({
  title, slots, field, accent, area,
}: {
  title: string;
  slots: LiveSlot[];
  field?: LiveField['ours'];
  accent: 'cyan' | 'pink';
  area: string;
}) {
  const six = [...slots];
  while (six.length < 6) {
    six.push({
      speciesId: '', hp: 0, maxHp: 100, status: '', fainted: false, active: false, revealed: false,
    });
  }
  return (
    <section className={`card bench bench-${accent} theater-${area}`}>
      <h2 className="bench-title">{title}</h2>
      <SideFieldBadges side={field} />
      <ul className="bench-list">
        {six.slice(0, 6).map((s, i) => <SlotRow key={i} slot={s} accent={accent} />)}
      </ul>
    </section>
  );
}

function SlotRow({ slot, accent }: { slot: LiveSlot; accent: 'cyan' | 'pink' }) {
  const revealed = slot.revealed;
  const max = Math.max(slot.maxHp || 0, 1);
  const ratio = slot.fainted || !revealed ? (revealed ? 0 : 0) : Math.max(0, Math.min(1, slot.hp / max));
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

function Sprite({ speciesId }: { speciesId: string }) {
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

function ScoreStrip({ state }: { state: LiveState }) {
  const ev = state.eval;
  const score = ev?.roundScore ?? 0;
  const pct = ((Math.max(-6, Math.min(6, score)) + 6) / 12) * 100;
  const positive = score >= 0;
  const fillLeft = positive ? 50 : pct;
  const fillWidth = positive ? pct - 50 : 50 - pct;
  const label = `${score >= 0 ? '+' : ''}${score.toFixed(3)}`;
  const color = score > 0.05 ? 'var(--matchup-win)' : score < -0.05 ? 'var(--matchup-lose)' : 'var(--matchup-neutral)';
  return (
    <section className="score-strip card">
      <div
        className="bipolar"
        role="meter"
        aria-label="round score"
        aria-valuemin={-6}
        aria-valuemax={6}
        aria-valuenow={Number(score.toFixed(3))}
      >
        <div className="bipolar-mid" />
        <div
          className="bipolar-fill"
          style={{
            left: `${fillLeft}%`,
            width: `${Math.max(fillWidth, 0)}%`,
            background: color,
          }}
        />
      </div>
      <div className="score-meta">
        <strong style={{ color }}>roundScore {label}</strong>
        {ev && <span className="muted">mate {ev.forcedOutcome}{ev.mateProbability ? ` ${ev.mateProbability.toFixed(2)}` : ''}</span>}
        {ev?.sampledAction && <span className="sampled-label">sampled {actionLabel(ev.sampledAction, state.ours)}</span>}
        {ev?.quantum && (
          <span className="muted" title={quantumTitle(ev.quantum)}>
            {ev.quantum.mode}
            {ev.quantum.nQubits != null ? ` · ${ev.quantum.nQubits}q` : ''}
          </span>
        )}
      </div>
      <TurnSparks turns={state.turns ?? []} />
    </section>
  );
}

function TurnSparks({ turns }: { turns: LiveTurn[] }) {
  if (!turns.length) return null;
  return (
    <div className="turn-sparks" aria-label="turn scores">
      {turns.map((t, i) => {
        const h = Math.min(1, Math.abs(t.roundScore) / 6) * 100;
        const color = t.roundScore > 0.05 ? 'var(--neon-cyan)' : t.roundScore < -0.05 ? 'var(--neon-pink)' : 'var(--fg-dim)';
        return (
          <div
            key={`${t.turn}-${i}`}
            className="spark"
            title={`turn ${t.turn} ${t.roundScore >= 0 ? '+' : ''}${t.roundScore.toFixed(2)}`}
            style={{ height: `${Math.max(h, 8)}%`, background: color }}
          />
        );
      })}
    </div>
  );
}

type RankedRow = {
  id: string;
  score: number;
  probability?: number;
  hits?: number | null;
  deltaM?: number;
};

function rankOurs(choices: LiveChoice[]): RankedRow[] {
  const ranked = [...choices]
    .sort((a, b) => b.choiceScore - a.choiceScore)
    .map((c) => ({
      id: c.id,
      score: c.choiceScore,
      probability: c.probability,
      hits: c.hitsToKill,
      deltaM: c.expectedModifierDelta,
    }));
  // #region agent log
  fetch('http://127.0.0.1:7559/ingest/6200673b-d438-4c7f-9e45-49a0c341555a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'029c39'},body:JSON.stringify({sessionId:'029c39',runId:'pre',hypothesisId:'E',location:'BattleLive.tsx:rankOurs',message:'our ranked choices',data:{count:ranked.length,ids:ranked.map((r)=>r.id),tera:ranked.filter((r)=>r.id.endsWith(':tera')).length,top3:ranked.slice(0,3).map((r)=>r.id)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  return ranked;
}

function rankTheirs(replies: LiveReply[]): RankedRow[] {
  const ranked = [...replies]
    .sort((a, b) => a.expectedImpact - b.expectedImpact)
    .map((r) => ({
      id: r.id,
      score: r.expectedImpact,
      hits: r.hitsToKillUs,
    }));
}

function ChoiceList({
  title, rows, sampled, quantum, slots, ours, area,
}: {
  title: string;
  rows: RankedRow[];
  sampled?: string;
  quantum?: LiveQuantum;
  slots?: LiveSlot[];
  ours?: boolean;
  area?: string;
}) {
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.score)), 0.01);
  return (
    <section className={`card choice-list${area ? ` theater-${area}` : ''}`}>
      <h2 className="bench-title">{title}</h2>
      {rows.length === 0 && <p className="muted">{ours ? 'No eval yet this battle.' : 'No hypothesized replies yet.'}</p>}
      <ol className="choice-ol">
        {rows.map((r, i) => {
          const mark = r.id === sampled;
          const width = (Math.abs(r.score) / maxAbs) * 100;
          const pos = r.score >= 0;
          return (
            <li key={r.id} className={`choice-row${mark ? ' choice-sampled' : ''}`}>
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span>{mark ? '▸ ' : ''}{actionLabel(r.id, slots)}</span>
                  <span className="choice-score">{r.score >= 0 ? '+' : ''}{r.score.toFixed(2)}</span>
                </div>
                <div
                  className="choice-track"
                  role="meter"
                  aria-label={`${actionLabel(r.id, slots)} score`}
                  aria-valuemin={-maxAbs}
                  aria-valuemax={maxAbs}
                  aria-valuenow={Number(r.score.toFixed(3))}
                >
                  <div
                    className="choice-fill"
                    style={{
                      width: `${width}%`,
                      marginLeft: pos ? 0 : `${100 - width}%`,
                      background: pos ? 'var(--neon-cyan)' : 'var(--neon-pink)',
                    }}
                  />
                </div>
                {ours && r.probability != null && (
                  <div
                    className="choice-p"
                    role="meter"
                    aria-label="quantum probability"
                    aria-valuemin={0}
                    aria-valuemax={1}
                    aria-valuenow={Number(r.probability.toFixed(3))}
                    title={quantum ? quantumTitle(quantum) : undefined}
                  >
                    <div className="choice-p-fill" style={{ width: `${r.probability * 100}%` }} />
                  </div>
                )}
                <div className="choice-meta dim">
                  <span>{hkoLabel(r.hits)}</span>
                  {r.deltaM != null && <span>ΔM {r.deltaM >= 0 ? '+' : ''}{r.deltaM.toFixed(2)}</span>}
                  {ours && r.probability != null && <span>p={r.probability.toFixed(2)}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TheaterSkeleton() {
  return (
    <div className="theater-body" aria-busy="true" aria-label="Loading battle">
      {[0, 1, 2, 3].map((k) => (
        <div key={k} className="card skeleton-block">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton-row" />)}
        </div>
      ))}
    </div>
  );
}

function prettySpecies(id: string): string {
  if (!id) return '?';
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function actionLabel(id: string, slots?: LiveSlot[]): string {
  if (id.startsWith('move:')) {
    const tera = id.endsWith(':tera');
    const move = id.slice(5).replace(/:tera$/, '');
    return `${prettySpecies(move)}${tera ? ' Tera' : ''}`;
  }
  if (id.startsWith('switch:')) {
    const n = Number(id.slice(7));
    const slot = Number.isFinite(n) ? slots?.[n - 1] : undefined;
    if (slot?.revealed && slot.speciesId) return `Switch ${prettySpecies(slot.speciesId)}`;
    return `Switch ${n || id}`;
  }
  return id;
}

function hkoLabel(n: number | null | undefined): string {
  if (n == null || n < 1) return '—';
  if (n === 1) return 'OHKO';
  if (n <= 3) return `${n}HKO`;
  return '—';
}

function quantumTitle(q: { mode: string; nQubits?: number; shots?: number; exact?: boolean }): string {
  const bits = [q.mode];
  if (q.nQubits != null) bits.push(`${q.nQubits} qubits`);
  if (q.exact) bits.push('exact');
  else if (q.shots != null) bits.push(`${q.shots} shots`);
  return bits.join(' · ');
}

function formatEvents(events?: { ts: string; text: string }[]): string {
  if (!events?.length) return '(no updates yet)';
  return events.map((e) => {
    const clock = e.ts?.length >= 19 ? e.ts.slice(11, 19) : e.ts;
    return clock ? `${clock}  ${e.text}` : e.text;
  }).join('\n');
}
