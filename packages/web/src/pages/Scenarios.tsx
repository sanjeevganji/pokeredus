import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScoreBar } from '../components/ScoreBar';
import { Bench, actionLabel, hkoLabel } from '../components/theater';
import type { LiveField, LiveSlot } from '../lib/games';
import {
  evalScenario,
  getScenario,
  getWeights,
  importScenario,
  listScenarios,
  playScenario,
  rankScenario,
  resetModelWeights,
  winrateScenario,
  type SavedScenario,
  type ScenarioChoice,
  type ScenarioEval,
  type ScenarioMeta,
  type ScoreWeights,
  type WinrateResult,
} from '../lib/scenarios';

export default function Scenarios() {
  const [list, setList] = useState<ScenarioMeta[]>([]);
  const [q, setQ] = useState('');
  const [current, setCurrent] = useState<SavedScenario | null>(null);
  const [ev, setEv] = useState<ScenarioEval | null>(null);
  const [weights, setWeights] = useState<ScoreWeights | null>(null);
  const [facing, setFacing] = useState<'ours' | 'theirs'>('ours');
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [winrate, setWinrate] = useState<WinrateResult | null>(null);
  const [playNote, setPlayNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => {
    setList(await listScenarios());
  }, []);

  useEffect(() => { refreshList().catch(() => { /* ignore */ }); getWeights().then(setWeights).catch(() => { /* ignore */ }); }, [refreshList]);

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return list;
    return list.filter((s) => s.name.toLowerCase().includes(n) || s.id.toLowerCase().includes(n));
  }, [list, q]);

  async function open(id: string) {
    setError('');
    setBusy('eval');
    setWinrate(null);
    setPlayNote('');
    try {
      const s = await getScenario(id);
      setCurrent(s);
      const out = await evalScenario(id);
      setEv(out.eval);
      setWeights(out.weights);
      const first = out.eval.choices[0]?.action.id ?? '';
      setSelected(first);
      setFacing('ours');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onImportLive() {
    setError('');
    setBusy('import');
    try {
      const s = await importScenario({ source: 'live' });
      await refreshList();
      await open(s.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onImportFile(file: File) {
    setError('');
    setBusy('import');
    try {
      const text = await file.text();
      const s = await importScenario({ source: 'transcript', text, name: file.name.replace(/\.[^.]+$/, '') });
      await refreshList();
      await open(s.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onRank(side: 'ours' | 'theirs', order: string[]) {
    if (!current) return;
    setBusy('rank');
    setError('');
    try {
      const out = await rankScenario(current.id, side, order);
      setEv(out.eval);
      setWeights(out.weights);
      setCurrent(out.scenario);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onPlay() {
    if (!current || !selected) return;
    setBusy('play');
    setError('');
    try {
      const out = await playScenario(current.id, facing, selected);
      setCurrent(out.scenario);
      setEv(out.eval);
      setPlayNote(`Opp ${out.sampledOpp}${out.weWin ? ' — we win' : out.theyWin ? ' — they win' : ''}`);
      const first = (facing === 'ours' ? out.eval.choices : out.eval.replies)[0]?.action.id ?? out.eval.choices[0]?.action.id ?? '';
      setSelected(first);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onWinrate() {
    if (!current) return;
    setBusy('winrate');
    setError('');
    try {
      setWinrate(await winrateScenario(current.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  async function onReset() {
    setBusy('reset');
    try {
      setWeights(await resetModelWeights());
      if (current) {
        const out = await evalScenario(current.id);
        setEv(out.eval);
        setWeights(out.weights);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy('');
  }

  const oursLive = current ? toLiveSlots(current.observation.ours) : [];
  const theirsLive = current ? toLiveSlots(current.observation.theirs) : [];
  const field = current ? toLiveField(current.observation.field, current.observation.ourSide !== 'p2') : undefined;

  return (
    <div>
      <h1 className="neon-title">Scenarios</h1>
      <p className="muted">Freeze a turn, rank both sides, play against the prediction model, and elastically tune score weights.</p>
      {error && <p className="theater-alert theater-alert-error" role="alert">{error}</p>}

      <div className="lab-layout">
        <aside className="card lab-list">
          <div className="choice-head-row">
            <h2 className="bench-title">Saved</h2>
          </div>
          <input
            type="search"
            placeholder="Filter scenarios"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter scenarios"
          />
          <div className="lab-actions">
            <button type="button" className="btn-primary" onClick={onImportLive} disabled={Boolean(busy)}>Import from live</button>
            <button type="button" className="btn-secondary" onClick={() => fileRef.current?.click()} disabled={Boolean(busy)}>Upload transcript</button>
            <input
              ref={fileRef}
              type="file"
              accept=".txt,.log,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void onImportFile(f);
              }}
            />
          </div>
          {filtered.length === 0 && (
            <div className="lab-empty">
              <p>No scenarios yet.</p>
              <p className="muted">Import from a live battle or upload a Showdown transcript.</p>
            </div>
          )}
          <ul className="lab-items">
            {filtered.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`lab-item${current?.id === s.id ? ' lab-item-on' : ''}`}
                  onClick={() => void open(s.id)}
                >
                  <strong>{s.name}</strong>
                  <span className="muted">turn {s.turn} · {s.source}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className="lab-main">
          {!current ? (
            <div className="card lab-empty-main">
              <h2>Open a scenario</h2>
              <p className="muted">Import from a live battle or upload a transcript to start ranking and playing.</p>
              <Link to="/games" className="btn-secondary">Go to Games</Link>
            </div>
          ) : (
            <>
              <div className="theater-body lab-benches">
                <Bench title="Ours" slots={oursLive} field={field?.ours} accent="cyan" />
                <Bench title="Theirs" slots={theirsLive} field={field?.theirs} accent="pink" />
              </div>
              {ev && (
                <div className="theater-body lab-benches">
                  <RankList
                    title="Our choices"
                    rows={ev.choices}
                    slots={oursLive}
                    selected={facing === 'ours' ? selected : ''}
                    onSelect={setSelected}
                    onReorder={(order) => void onRank('ours', order)}
                    ours
                  />
                  <RankList
                    title="Their replies"
                    rows={ev.replies}
                    slots={theirsLive}
                    selected={facing === 'theirs' ? selected : ''}
                    onSelect={setSelected}
                    onReorder={(order) => void onRank('theirs', order)}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <aside className="card lab-meta">
          <h2 className="bench-title">Model</h2>
          <div className="lab-facing" role="group" aria-label="Facing">
            <button type="button" className={facing === 'ours' ? 'btn-primary' : 'btn-secondary'} onClick={() => setFacing('ours')}>Play as ours</button>
            <button type="button" className={facing === 'theirs' ? 'btn-primary' : 'btn-secondary'} onClick={() => setFacing('theirs')}>Play as theirs</button>
          </div>
          <button type="button" className="btn-primary" onClick={() => void onPlay()} disabled={!current || !selected || Boolean(busy)}>
            Play this choice
          </button>
          <button type="button" className="btn-secondary" onClick={() => void onWinrate()} disabled={!current || Boolean(busy)}>
            {busy === 'winrate' ? 'Simulating…' : 'Simulate winrate'}
          </button>
          {playNote && <p className="muted">{playNote}</p>}
          {winrate && (
            <p>
              {winrate.wins}/{winrate.n} wins · {winrate.losses} losses · {winrate.draws} draws
              <span className="muted"> · {winrate.avgTurns.toFixed(1)} turns</span>
            </p>
          )}
          {busy && <p className="muted">{busy}…</p>}
          {weights && (
            <dl className="weight-dl">
              {(['health', 'modifier', 'secondary', 'switchRisk', 'sacrifice'] as const).map((k) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{weights[k].toFixed(2)}</dd>
                </div>
              ))}
            </dl>
          )}
          <button type="button" className="btn-secondary" onClick={() => void onReset()} disabled={Boolean(busy)}>Reset to defaults</button>
        </aside>
      </div>
    </div>
  );
}

function RankList({
  title, rows, slots, selected, onSelect, onReorder, ours,
}: {
  title: string;
  rows: ScenarioChoice[];
  slots: LiveSlot[];
  selected: string;
  onSelect: (id: string) => void;
  onReorder: (order: string[]) => void;
  ours?: boolean;
}) {
  const [dragId, setDragId] = useState<string | null>(null);
  const ids = rows.map((r) => r.action.id);
  function move(id: string, dir: -1 | 1) {
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = [...ids];
    const [x] = next.splice(i, 1);
    next.splice(j, 0, x!);
    onReorder(next);
  }

  function dropOn(target: string) {
    if (!dragId || dragId === target) return;
    const next = ids.filter((id) => id !== dragId);
    const at = next.indexOf(target);
    next.splice(at, 0, dragId);
    setDragId(null);
    onReorder(next);
  }

  return (
    <section className="card choice-list">
      <h2 className="bench-title">{title}</h2>
      {rows.length === 0 && <p className="muted">No choices.</p>}
      <ol className="choice-ol">
        {rows.map((r, i) => {
          const id = r.action.id;
          const mark = id === selected;
          return (
            <li
              key={id}
              className={`choice-row${mark ? ' choice-sampled' : ''}${dragId === id ? ' choice-dragging' : ''}`}
              draggable
              aria-grabbed={dragId === id}
              onDragStart={() => setDragId(id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOn(id)}
            >
              <span className="choice-rank">{i + 1}</span>
              <div className="choice-body">
                <div className="choice-head">
                  <button type="button" className="choice-pick" onClick={() => onSelect(id)}>
                    {mark ? '▸ ' : ''}{actionLabel(id, slots)}
                  </button>
                  <span className="choice-score">{r.choiceScore >= 0 ? '+' : ''}{r.choiceScore.toFixed(2)}</span>
                </div>
                <ScoreBar
                  score={r.choiceScore}
                  parts={{
                    ourHealth: r.ourHealth ?? 0,
                    theirHealth: r.theirHealth ?? 0,
                    ourModifier: r.ourModifier ?? 0,
                    theirModifier: r.theirModifier ?? 0,
                  }}
                  label={`${actionLabel(id, slots)} score`}
                />
                {ours && r.probability != null && (
                  <div className="choice-p" role="meter" aria-label="probability" aria-valuemin={0} aria-valuemax={1} aria-valuenow={r.probability}>
                    <div className="choice-p-fill" style={{ width: `${r.probability * 100}%` }} />
                  </div>
                )}
                <div className="choice-meta dim">
                  <span>{hkoLabel(r.hitsToKill ?? r.hitsToKillUs)}</span>
                  {r.probability != null && <span>p={r.probability.toFixed(2)}</span>}
                  <span className="lab-keys">
                    <button type="button" aria-label="Move up" onClick={() => move(id, -1)}>↑</button>
                    <button type="button" aria-label="Move down" onClick={() => move(id, 1)}>↓</button>
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function toLiveSlots(slots: SavedScenario['observation']['ours']): LiveSlot[] {
  return (slots ?? []).map((s) => ({
    speciesId: s.speciesId,
    hp: s.hp,
    maxHp: s.maxHp || 100,
    status: s.status,
    fainted: s.fainted,
    active: s.active,
    revealed: s.revealed,
    boosts: s.boosts as LiveSlot['boosts'],
    modifiers: s.modifiers,
  }));
}

function toLiveField(field: SavedScenario['observation']['field'], oursIsP1: boolean): LiveField | undefined {
  if (!field) return undefined;
  const side = (p1: boolean) => ({
    hazards: p1
      ? (field.hazards_p1 ?? { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false })
      : (field.hazards_p2 ?? { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false }),
    reflect: p1 ? (field.reflect_p1 ?? 0) : (field.reflect_p2 ?? 0),
    lightscreen: p1 ? (field.lightscreen_p1 ?? 0) : (field.lightscreen_p2 ?? 0),
  });
  return {
    weather: field.weather ?? '',
    terrain: field.terrain ?? '',
    trickroom: Boolean(field.trickroom),
    ours: side(oursIsP1),
    theirs: side(!oursIsP1),
  };
}
