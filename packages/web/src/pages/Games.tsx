import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  attachGame,
  cancelSearch,
  detectGames,
  detachGame,
  disconnectGames,
  getGames,
  getLiveState,
  searchGames,
  type DetectedGame,
  type GamesSnapshot,
  type LiveState,
} from '../lib/games';

const empty: GamesSnapshot = {
  connected: false,
  user: '',
  named: false,
  searching: [],
  mine: [],
  listed: [],
  attached: null,
  settings: { user: '', url: '', policy: 'quantum', dry_run: true },
};

export default function Games() {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<GamesSnapshot>(empty);
  const [live, setLive] = useState<LiveState>({ status: 'idle' });
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [url, setUrl] = useState('');
  const [room, setRoom] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const apply = (next: GamesSnapshot) => {
    setSnap(next);
    if (next.error) setErr(next.error);
    else setErr('');
  };

  useEffect(() => {
    getGames()
      .then((g) => {
        apply(g);
        setUser(g.settings.user);
        setUrl(g.settings.url);
        setDryRun(g.settings.dry_run);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!snap.connected && !snap.attached) return;
    const t = setInterval(() => {
      getGames().then(apply).catch(() => { /* ignore poll errors */ });
    }, 2000);
    return () => clearInterval(t);
  }, [snap.connected, snap.attached]);

  useEffect(() => {
    const t = setInterval(() => {
      getLiveState().then(setLive).catch(() => { /* ignore */ });
    }, 250);
    return () => clearInterval(t);
  }, []);

  const run = useCallback(async (label: string, fn: () => Promise<GamesSnapshot>) => {
    setBusy(label);
    setErr('');
    try {
      apply(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  }, []);

  const detect = () => run('detect', () => detectGames({
    user: user || undefined,
    pass: pass || undefined,
    url: url || undefined,
  }));

  const goLive = async (id: string) => {
    setBusy('attach');
    setErr('');
    try {
      const next = await attachGame(id, { dryRun });
      apply(next);
      if (!next.error && next.attached) navigate('/games/live');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const liveOn = Boolean(snap.attached) || (live.status && live.status !== 'idle');

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Games</h1>
      <p className="muted">Detect Showdown battles for this account and attach PokeLink from this UI.</p>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0, color: 'var(--neon-cyan)' }}>Showdown</h3>
        <div className="game-form">
          <label>User
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="guest if empty" />
          </label>
          <label>Password
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
          <label>Websocket URL
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="default sim3" />
          </label>
        </div>
        <div className="row-actions">
          <button type="button" onClick={detect} disabled={Boolean(busy)}>
            {busy === 'detect' ? 'Detecting…' : 'Connect & detect'}
          </button>
          <button type="button" onClick={() => run('search', () => searchGames())} disabled={!snap.connected || Boolean(busy)}>
            Search Random Battle
          </button>
          <button type="button" onClick={() => run('cancel', () => cancelSearch())} disabled={!snap.connected || Boolean(busy)}>
            Cancel search
          </button>
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            dry-run (log, do not send)
          </label>
          <button type="button" onClick={() => run('disconnect', () => disconnectGames())} disabled={!snap.connected && !snap.attached}>
            Disconnect
          </button>
          {liveOn && (
            <Link to="/games/live" className="btn-primary">Open battle</Link>
          )}
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          {statusLine(snap, busy)}
        </p>
        {err && <p style={{ color: 'var(--neon-red)', marginBottom: 0 }}>{err}</p>}
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <GameList
          title="Your games"
          empty={snap.connected ? 'No games on this account. Search, or start one on Pokémon Showdown and detect again.' : 'Connect to detect your games.'}
          games={snap.mine}
          attached={snap.attached?.room}
          onAttach={goLive}
          onDetach={() => run('detach', () => detachGame())}
        />
        <GameList
          title="Public Random Battles"
          empty={snap.connected ? 'No public battles listed.' : 'Connect to list public rooms.'}
          games={snap.listed}
          attached={snap.attached?.room}
          onAttach={goLive}
          onDetach={() => run('detach', () => detachGame())}
        />
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0, color: 'var(--neon-cyan)' }}>Attach by id</h3>
        <div className="row-actions">
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="gen9randombattle-… or battle-gen9randombattle-…"
            style={{ flex: 1, minWidth: 220 }}
          />
          <button type="button" onClick={() => goLive(room)} disabled={!room.trim() || Boolean(busy)}>
            Attach
          </button>
          <button type="button" onClick={() => run('detach', () => detachGame())} disabled={!snap.attached}>
            Detach
          </button>
        </div>
      </div>

      <Hud state={live} />
    </div>
  );
}

function statusLine(snap: GamesSnapshot, busy: string): string {
  if (busy) return busy;
  const bits = [];
  if (snap.connected) bits.push(`${snap.named ? 'named' : 'guest'} ${snap.user || '(connecting)'}`);
  else bits.push('not connected');
  if (snap.searching.length) bits.push(`searching ${snap.searching.join(', ')}`);
  if (snap.attached) {
    bits.push(`attached ${snap.attached.room}`);
    bits.push(snap.attached.dryRun ? 'dry-run' : 'send');
    bits.push(snap.attached.policy);
  }
  return bits.join('  ·  ');
}

function GameList(props: {
  title: string;
  empty: string;
  games: DetectedGame[];
  attached?: string;
  onAttach: (room: string) => void;
  onDetach: () => void;
}) {
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0, color: 'var(--neon-pink)' }}>{props.title}</h3>
      {props.games.length === 0 && <p className="muted">{props.empty}</p>}
      <ul className="game-list">
        {props.games.map((g) => {
          const on = props.attached === g.room;
          return (
            <li key={g.room} className="game-row">
              <div>
                <div>{g.title}</div>
                <div className="dim">{g.room}{g.minElo ? `  ·  elo ${g.minElo}` : ''}</div>
              </div>
              {on
                ? <button type="button" onClick={props.onDetach}>Detach</button>
                : <button type="button" onClick={() => props.onAttach(g.room)}>Attach</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Hud({ state }: { state: LiveState }) {
  const idle = !state.status || state.status === 'idle';
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0, color: 'var(--neon-orange)' }}>PokeLink</h3>
      {idle ? (
        <p className="muted">No live battle. Detect a game and attach, or launch live from the terminal.</p>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            <span className={`status-pill status-${state.status}`}>{state.status}</span>
            {'  '}turn {state.turn ?? 0}
            {'  ·  '}{state.policy}
            {'  ·  '}{state.dryRun ? 'dry-run' : 'send'}
            {state.field?.weather ? `  ·  ${state.field.weather}` : ''}
            {state.field?.terrain ? `  ·  ${state.field.terrain}` : ''}
            {state.field?.trickroom ? '  ·  TR' : ''}
            {state.room ? `  ·  ${state.room}` : ''}
            {state.winner ? `  ·  winner ${state.winner}` : ''}
          </p>
          {state.error && <p style={{ color: 'var(--neon-red)' }}>{state.error}</p>}
          <div className="hud-grid">
            <Side title="Ours" slots={state.ours ?? []} accent="var(--neon-cyan)" />
            <EvalBlock state={state} />
            <Side title="Theirs" slots={state.theirs ?? []} accent="var(--neon-pink)" />
          </div>
          <pre className="event-log">{formatEvents(state.events)}</pre>
        </>
      )}
    </div>
  );
}

function Side({ title, slots, accent }: { title: string; slots: LiveSlot[]; accent: string }) {
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 8px', color: accent }}>{title}</h4>
      {slots.length === 0 && <div className="dim">(none revealed)</div>}
      {slots.map((s, i) => {
        const max = Math.max(s.maxHp || 0, 1);
        const ratio = s.fainted ? 0 : Math.max(0, Math.min(1, s.hp / max));
        const color = ratio < 0.25 ? 'var(--neon-red)' : ratio < 0.5 ? 'var(--neon-yellow)' : accent;
        const name = (s.speciesId || '?').replace(/-/g, ' ');
        return (
          <div key={`${s.speciesId}-${i}`} style={{ marginBottom: 8, opacity: s.fainted ? 0.5 : 1 }}>
            <div>{s.active ? '● ' : ''}{name}  {s.hp}/{s.maxHp}{s.status ? `  ${s.status}` : ''}</div>
            <div className="hp-track"><div className="hp-fill" style={{ width: `${ratio * 100}%`, background: color }} /></div>
          </div>
        );
      })}
    </div>
  );
}

function EvalBlock({ state }: { state: LiveState }) {
  const ev = state.eval;
  if (!ev) return <div className="card"><h4 style={{ margin: 0 }} className="dim">Eval</h4><p className="muted">No eval yet this battle.</p></div>;
  const color = ev.roundScore > 0.05 ? 'var(--matchup-win)' : ev.roundScore < -0.05 ? 'var(--matchup-lose)' : 'var(--matchup-neutral)';
  return (
    <div className="card">
      <h4 style={{ margin: '0 0 8px', color }}>roundScore {ev.roundScore >= 0 ? '+' : ''}{ev.roundScore.toFixed(3)}</h4>
      <div className="muted">mate {ev.forcedOutcome}  p={ev.mateProbability.toFixed(3)}</div>
      <div style={{ color: 'var(--neon-green)', margin: '6px 0 8px' }}>sampled  {ev.sampledAction}</div>
      {ev.choices.map((c) => {
        const tag = c.cta != null ? `cta=${c.cta.toFixed(3)}` : c.cts != null ? `cts=${c.cts.toFixed(3)}` : '';
        const mark = c.id === ev.sampledAction;
        return (
          <div key={c.id} style={{ color: mark ? 'var(--neon-green)' : 'var(--fg-primary)', fontSize: '0.85rem' }}>
            {mark ? '> ' : '  '}[{c.id}] {tag}  impact={c.expectedImpact >= 0 ? '+' : ''}{c.expectedImpact.toFixed(3)}  choice={c.choiceScore >= 0 ? '+' : ''}{c.choiceScore.toFixed(3)}
            {c.probability != null ? `  p=${c.probability.toFixed(3)}` : ''}
          </div>
        );
      })}
    </div>
  );
}

function formatEvents(events?: { ts: string; text: string }[]): string {
  if (!events?.length) return '(no updates yet)';
  return events.map((e) => {
    const clock = e.ts?.length >= 19 ? e.ts.slice(11, 19) : e.ts;
    return clock ? `${clock}  ${e.text}` : e.text;
  }).join('\n');
}
