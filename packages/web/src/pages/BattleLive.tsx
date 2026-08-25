import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  deleteSpeciesSet,
  detachGame,
  formatFromRoom,
  getLiveState,
  getSpeciesSets,
  putSpeciesSet,
  type CanonicalSet,
  type LiveChoice,
  type LiveQuantum,
  type LiveReply,
  type LiveSlot,
  type LiveState,
  type LiveTurn,
  type SetCatalog,
} from '../lib/games';
import { importScenario } from '../lib/scenarios';
import { ScoreBar } from '../components/ScoreBar';
import { Bench, FieldBadges, actionLabel, hkoLabel, prettySpecies } from '../components/theater';

export default function BattleLive() {
  const navigate = useNavigate();
  const [live, setLive] = useState<LiveState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [ourTera, setOurTera] = useState(false);
  const [theirTera, setTheirTera] = useState(false);
  const [drawer, setDrawer] = useState<{ slot: LiveSlot; opener: HTMLElement } | null>(null);

  const openSet = useCallback((slot: LiveSlot, opener: HTMLElement) => {
    if (!slot.revealed || !slot.speciesId) return;
    setDrawer({ slot, opener });
  }, []);

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

  const save = useCallback(async () => {
    setBusy(true);
    setSaveMsg('');
    try {
      const s = await importScenario({ source: 'live', name: live.room ? `${live.room} turn ${live.turn ?? 0}` : undefined });
      setSaveMsg(`Saved ${s.name}`);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  }, [live.room, live.turn]);

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
        <button type="button" className="btn-secondary" onClick={save} disabled={busy}>
          Save scenario
        </button>
        <button type="button" className="btn-danger" onClick={detach} disabled={busy} style={{ marginLeft: 'auto' }}>
          {busy ? 'Detaching…' : 'Detach'}
        </button>
      </header>

      {live.error && <p className="theater-alert theater-alert-error" role="alert">{live.error}</p>}
      {live.winner && <p className="theater-alert theater-alert-win" role="status">{live.winner} wins</p>}
      {saveMsg && <p className="theater-alert" role="status">{saveMsg} {saveMsg.startsWith('Saved') && <Link to="/scenarios">Open lab</Link>}</p>}

      {loading ? (
        <TheaterSkeleton />
      ) : (
        <>
          <ScoreStrip state={live} />
          <div className="theater-body">
            <Bench area="ours" title="Ours" slots={live.ours ?? []} field={live.field?.ours} accent="cyan" tera={ourTera} compact />
            <ChoiceList
              area="ourc"
              title="Our choices"
              rows={rankOurs(ourTera ? (live.eval?.teraChoices ?? live.eval?.choices ?? []) : (live.eval?.choices ?? []), ourTera)}
              sampled={live.eval?.sampledAction}
              quantum={live.eval?.quantum}
              slots={live.ours}
              ours
              tera={ourTera}
              onTera={setOurTera}
            />
            <Bench area="theirs" title="Theirs" slots={live.theirs ?? []} field={live.field?.theirs} accent="pink" tera={theirTera} compact />
            <ChoiceList
              area="theirc"
              title="Their replies"
              rows={rankTheirs(theirTera ? (live.eval?.teraReplies ?? live.eval?.replies ?? []) : (live.eval?.replies ?? []), theirTera)}
              slots={live.theirs}
              tera={theirTera}
              onTera={setTheirTera}
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

function ScoreStrip({ state }: { state: LiveState }) {
  const ev = state.eval;
  const round = ev?.roundScore ?? 0;
  const label = `${round >= 0 ? '+' : ''}${round.toFixed(3)}`;
  const color = round > 0.05 ? 'var(--matchup-win)' : round < -0.05 ? 'var(--matchup-lose)' : 'var(--matchup-neutral)';
  return (
    <section className="score-strip card">
      <TurnGraph turns={state.turns ?? []} currentTurn={state.turn} currentScore={ev?.roundScore} />
      <div className="score-meta">
        <strong style={{ color }}>round {label}</strong>
        {ev && <span className="muted">mate {ev.forcedOutcome}{ev.mateProbability ? ` ${ev.mateProbability.toFixed(2)}` : ''}</span>}
        {ev?.sampledAction && <span className="sampled-label">sampled {actionLabel(ev.sampledAction, state.ours)}</span>}
        {ev?.quantum && (
          <span className="muted" title={quantumTitle(ev.quantum)}>
            {ev.quantum.mode}
            {ev.quantum.nQubits != null ? ` · ${ev.quantum.nQubits}q` : ''}
          </span>
        )}
      </div>
    </section>
  );
}

const GRAPH = { w: 200, h: 52, l: 2, r: 2, t: 4, b: 4 };

function TurnGraph({
  turns, currentTurn, currentScore,
}: {
  turns: LiveTurn[];
  currentTurn?: number;
  currentScore?: number;
}) {
  const pts: { turn: number; score: number }[] = turns.map((t) => ({ turn: t.turn, score: t.roundScore }));
  if (currentScore != null && (pts.length === 0 || pts[pts.length - 1]!.turn !== currentTurn)) {
    pts.push({ turn: currentTurn ?? (pts[pts.length - 1]?.turn ?? 0) + 1, score: currentScore });
  }
  const { w, h, l, r, t, b } = GRAPH;
  const innerW = w - l - r;
  const innerH = h - t - b;
  const y0 = t + innerH / 2;
  const yAt = (s: number) => t + ((6 - Math.max(-6, Math.min(6, s))) / 12) * innerH;
  const xAt = (i: number) => (pts.length <= 1 ? l + innerW / 2 : l + (i / (pts.length - 1)) * innerW);
  const line = pts.map((p, i) => `${xAt(i).toFixed(2)},${yAt(p.score).toFixed(2)}`).join(' ');
  const area = pts.length
    ? `M ${xAt(0).toFixed(2)} ${y0.toFixed(2)} L ${pts.map((p, i) => `${xAt(i).toFixed(2)} ${yAt(p.score).toFixed(2)}`).join(' ')} L ${xAt(pts.length - 1).toFixed(2)} ${y0.toFixed(2)} Z`
    : '';
  return (
    <div className="turn-graph-wrap">
      <div className="turn-graph-y" aria-hidden="true">
        <span>+6</span>
        <span>0</span>
        <span>−6</span>
      </div>
      <svg className="turn-graph" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="round score over turns, +6 to -6">
        <title>Round score by turn (−6 to +6)</title>
        <defs>
          <clipPath id="tg-up"><rect x={l} y={t} width={innerW} height={innerH / 2} /></clipPath>
          <clipPath id="tg-dn"><rect x={l} y={y0} width={innerW} height={innerH / 2} /></clipPath>
        </defs>
        <line className="turn-graph-grid" x1={l} y1={t} x2={w - r} y2={t} />
        <line className="turn-graph-zero" x1={l} y1={y0} x2={w - r} y2={y0} />
        <line className="turn-graph-grid" x1={l} y1={t + innerH} x2={w - r} y2={t + innerH} />
        {area && (
          <>
            <path d={area} className="turn-graph-fill-up" clipPath="url(#tg-up)" />
            <path d={area} className="turn-graph-fill-dn" clipPath="url(#tg-dn)" />
          </>
        )}
        {pts.length > 0 && <polyline className="turn-graph-line" points={line} fill="none" />}
        {pts.map((p, i) => (
          <circle
            key={`${p.turn}-${i}`}
            className={`turn-graph-dot${i === pts.length - 1 ? ' turn-graph-dot-now' : ''}`}
            cx={xAt(i)}
            cy={yAt(p.score)}
            r={i === pts.length - 1 ? 2.2 : 1.5}
          >
            <title>{`turn ${p.turn} ${p.score >= 0 ? '+' : ''}${p.score.toFixed(2)}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

type RankedRow = {
  id: string;
  score: number;
  probability?: number;
  hits?: number | null;
  ourHealth?: number;
  theirHealth?: number;
  ourModifier?: number;
  theirModifier?: number;
};

function rankOurs(choices: LiveChoice[], teraMode = false): RankedRow[] {
  return [...choices]
    .filter((c) => teraMode || !c.id.endsWith(':tera'))
    .sort((a, b) => b.choiceScore - a.choiceScore)
    .slice(0, 3)
    .map((c) => ({
      id: c.id,
      score: c.choiceScore,
      probability: c.probability,
      hits: c.hitsToKill,
      ourHealth: c.ourHealth,
      theirHealth: c.theirHealth,
      ourModifier: c.ourModifier,
      theirModifier: c.theirModifier,
    }));
}

function rankTheirs(replies: LiveReply[], teraMode = false): RankedRow[] {
  return [...replies]
    .filter((r) => teraMode || !r.id.endsWith(':tera'))
    .sort((a, b) => (a.choiceScore ?? a.expectedImpact) - (b.choiceScore ?? b.expectedImpact))
    .slice(0, 3)
    .map((r) => ({
      id: r.id,
      score: r.choiceScore ?? r.expectedImpact,
      hits: r.hitsToKillUs,
      ourHealth: r.ourHealth,
      theirHealth: r.theirHealth,
      ourModifier: r.ourModifier,
      theirModifier: r.theirModifier,
    }));
}

function ChoiceList({
  title, rows, sampled, quantum, slots, ours, area, tera, onTera,
}: {
  title: string;
  rows: RankedRow[];
  sampled?: string;
  quantum?: LiveQuantum;
  slots?: LiveSlot[];
  ours?: boolean;
  area?: string;
  tera?: boolean;
  onTera?: (on: boolean) => void;
}) {
  return (
    <section className={`card choice-list compact${area ? ` theater-${area}` : ''}${tera ? ' tera-mode' : ''}`}>
      <div className="choice-head-row">
        <h2 className="bench-title">{title}</h2>
        {onTera && (
          <button
            type="button"
            className={`tera-toggle${tera ? ' tera-toggle-on' : ''}`}
            aria-pressed={Boolean(tera)}
            onClick={() => onTera(!tera)}
          >
            TERA
          </button>
        )}
      </div>
      {rows.length === 0 && <p className="muted">{ours ? 'No eval yet this battle.' : 'No hypothesized replies yet.'}</p>}
      <ol className="choice-ol">
        {rows.map((r, i) => {
          const mark = r.id === sampled;
          return (
            <li key={r.id} className={`choice-row${mark ? ' choice-sampled' : ''}`}>
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <span>{mark ? '▸ ' : ''}{actionLabel(r.id, slots)}</span>
                  <span className="choice-score">{r.score >= 0 ? '+' : ''}{r.score.toFixed(2)}</span>
                </div>
                <ScoreBar score={r.score} parts={r} label={`${actionLabel(r.id, slots)} score`} />
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
