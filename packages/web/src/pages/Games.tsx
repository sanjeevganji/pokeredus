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

