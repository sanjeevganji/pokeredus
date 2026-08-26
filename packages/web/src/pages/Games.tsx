import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  attachGame,
  cancelSearch,
  detectGames,
  detachGame,
  disconnectGames,
  getGames,
  getLiveState,
  logoutGames,
  patchGameSettings,
  saveLogin,
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
  login: { saved: false, user: '', hasPass: false, verified: false },
};

export default function Games() {
  const navigate = useNavigate();
  const [snap, setSnap] = useState<GamesSnapshot>(empty);
  const [live, setLive] = useState<LiveState>({ status: 'idle' });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const apply = (next: GamesSnapshot) => {
    setSnap({ ...empty, ...next, login: next.login ?? empty.login, settings: next.settings ?? empty.settings });
    setErr(next.error || '');
  };

  useEffect(() => {
    getGames().then(apply).catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!snap.connected && !snap.attached) return;
    const t = setInterval(() => {
      getGames().then(apply).catch(() => { /* ignore poll errors */ });
    }, 2000);
    return () => clearInterval(t);
  }, [snap.connected, snap.attached]);

  useEffect(() => {
    getLiveState().then(setLive).catch(() => { /* ignore */ });
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

  const goLive = async (id: string) => {
    setBusy('attach');
    setErr('');
    try {
      const next = await attachGame(id, { dryRun: snap.settings.dry_run });
      apply(next);
      if (!next.error && next.attached) {
        setJoinOpen(false);
        navigate('/games/live');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const liveOn = Boolean(snap.attached) || (live.status && live.status !== 'idle');
  const saved = snap.login.saved;

  return (
    <div>
      <h1 className="neon-title" style={{ fontSize: '1.8rem' }}>Games</h1>
      <p className="muted">Saved Showdown login, detect battles, or join by id.</p>

      <section className="panel account-card" style={{ marginTop: 16 }}>
        {saved ? (
          <>
            <div className="account-row">
              <span className="account-avatar" aria-hidden="true">{initials(snap.login.user)}</span>
              <div>
                <div className="account-name">{snap.login.user}</div>
                <div className="account-meta">
                  <span className={`status-pill ${badgeClass(snap)}`}>{badgeLabel(snap, busy)}</span>
                  {!snap.login.hasPass && <span className="muted">No saved password</span>}
                </div>
              </div>
            </div>
            <div className="row-actions">
              <button type="button" className="btn-primary" onClick={() => run('detect', () => detectGames())} disabled={Boolean(busy)}>
                {busy === 'detect' ? 'Detecting…' : 'Detect games'}
              </button>
              <button type="button" onClick={() => setJoinOpen(true)} disabled={Boolean(busy)}>
                Join battle
              </button>
              <button type="button" onClick={() => run('search', () => searchGames())} disabled={!snap.connected || Boolean(busy)}>
                Search Random Battle
              </button>
              <button type="button" onClick={() => run('cancel', () => cancelSearch())} disabled={!snap.connected || Boolean(busy)}>
                Cancel search
              </button>
              {liveOn && <Link to="/games/live" className="btn-primary">Open battle</Link>}
            </div>
            <div className="row-actions account-tools">
              <label className="send-toggle">
                <input
                  type="checkbox"
                  checked={!snap.settings.dry_run}
                  onChange={(e) => {
                    const send = e.target.checked;
                    void run('settings', () => patchGameSettings({ dryRun: !send }));
                  }}
                />
                Send chosen moves
              </label>
              <button type="button" className="btn-secondary" onClick={() => setLoginOpen(true)} disabled={Boolean(busy)}>
                Change login
              </button>
              <button type="button" onClick={() => run('disconnect', () => disconnectGames())} disabled={!snap.connected && !snap.attached}>
                Disconnect
              </button>
              <button type="button" className="btn-danger" onClick={() => run('logout', () => logoutGames())} disabled={Boolean(busy)}>
                Forget login
              </button>
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              {snap.settings.dry_run
                ? 'Moves are logged only. Turn on send when you want the engine to choose on Showdown.'
                : 'The engine will send sampled moves to Showdown when attached.'}
            </p>
          </>
        ) : (
          <div className="account-empty">
            <p className="account-name" style={{ margin: 0 }}>No Showdown login saved</p>
            <p className="muted">Verify your account with the Showdown server, then detect games or join by battle id.</p>
            <div className="row-actions">
              <button type="button" className="btn-primary" onClick={() => setLoginOpen(true)}>
                Save login
              </button>
              <button type="button" onClick={() => setJoinOpen(true)}>Join battle as guest</button>
            </div>
          </div>
        )}
        {err && <p className="field-err" role="alert" style={{ marginBottom: 0 }}>{err}</p>}
      </section>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <GameList
          title="Your games"
          empty={snap.connected
            ? 'No games on this account. Search, join by id, or start one on Pokémon Showdown and detect again.'
            : 'Detect games after saving a login.'}
          games={snap.mine}
          attached={snap.attached?.room}
          onAttach={goLive}
          onDetach={() => run('detach', () => detachGame())}
        />
        <GameList
          title="Public Random Battles"
          empty={snap.connected ? 'No public battles listed.' : 'Detect games to list public rooms.'}
          games={snap.listed}
          attached={snap.attached?.room}
          onAttach={goLive}
          onDetach={() => run('detach', () => detachGame())}
        />
      </div>

      {loginOpen && (
        <LoginModal
          busy={busy === 'login'}
          defaultUser={snap.login.user}
          onClose={() => setLoginOpen(false)}
          onSave={async (user, pass) => {
            setBusy('login');
            setErr('');
            try {
              const next = await saveLogin(user, pass);
              apply(next);
              if (!next.error && next.login.verified) setLoginOpen(false);
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy('');
            }
          }}
        />
      )}
      {joinOpen && (
        <JoinModal
          busy={busy === 'attach'}
          onClose={() => setJoinOpen(false)}
          onJoin={(id) => void goLive(id)}
        />
      )}
    </div>
  );
}

function badgeLabel(snap: GamesSnapshot, busy: string): string {
  if (busy === 'detect' || busy === 'login') return 'checking';
  if (snap.login.verified) return 'verified';
  if (snap.connected && snap.named) return 'named';
  if (snap.connected) return 'guest';
  return 'offline';
}

function badgeClass(snap: GamesSnapshot): string {
  if (snap.login.verified) return 'status-connected';
  if (snap.connected) return 'status-waiting';
  return 'status-ended';
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? parts[0]?.[1] ?? '');
  return letters.toUpperCase();
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

function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = () =>
      [...panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )].filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
    (focusable().find((el) => el.tagName === 'INPUT') ?? focusable()[0])?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const els = focusable();
      if (!els.length) return;
      const i = els.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        els[els.length - 1]!.focus();
      } else if (!e.shiftKey && i === els.length - 1) {
        e.preventDefault();
        els[0]!.focus();
      }
    }
    panel.addEventListener('keydown', onKey);
    return () => {
      panel.removeEventListener('keydown', onKey);
      opener?.focus();
    };
  }, [props]);
  return (
    <div className="modal-overlay" onClick={props.onClose} role="presentation">
      <div
        ref={panelRef}
        className="modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h2 id={titleId} className="drawer-title">{props.title}</h2>
          <button type="button" className="btn-secondary" onClick={props.onClose} aria-label="Close">✕</button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

function LoginModal(props: {
  busy: boolean;
  defaultUser: string;
  onClose: () => void;
  onSave: (user: string, pass: string) => Promise<void>;
}) {
  const [user, setUser] = useState(props.defaultUser);
  const [pass, setPass] = useState('');
  const missing = !user.trim() || !pass;
  return (
    <Modal title="Showdown login" onClose={props.onClose}>
      <form
        className="drawer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!missing && !props.busy) void props.onSave(user.trim(), pass);
        }}
      >
        <div className="form-field">
          <label htmlFor="ps-user">Username</label>
          <input id="ps-user" autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} />
        </div>
        <div className="form-field">
          <label htmlFor="ps-pass">Password</label>
          <input id="ps-pass" type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Saved locally in launch settings. PokeRedus verifies it against the Showdown login server before connecting.
        </p>
        <div className="drawer-actions">
          <button type="button" className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={missing || props.busy}>
            {props.busy ? 'Verifying…' : 'Verify and save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function JoinModal(props: {
  busy: boolean;
  onClose: () => void;
  onJoin: (room: string) => void;
}) {
  const [room, setRoom] = useState('');
  return (
    <Modal title="Join battle" onClose={props.onClose}>
      <form
        className="drawer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (room.trim() && !props.busy) props.onJoin(room.trim());
        }}
      >
        <div className="form-field">
          <label htmlFor="ps-room">Battle id</label>
          <input
            id="ps-room"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder="gen9randombattle-… or battle-gen9randombattle-…"
          />
        </div>
        <div className="drawer-actions">
          <button type="button" className="btn-secondary" onClick={props.onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={!room.trim() || props.busy}>
            {props.busy ? 'Attaching…' : 'Attach'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
