// Dev-server hub: detect Showdown games and attach the live CLI.
// Runs only inside Vite's Node process — not in the browser bundle.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { LobbyClient } from './lobby-client';
import {
  gamesFromRoomlist,
  gamesFromSearch,
  normalizeBattleRoom,
  type DetectedGame,
} from '../../bridge/src/lobby';
import { defaultLiveObservationPath } from '../../bridge/src/live-state';
import type { BattleObservation, RevealedFacts } from '../../engine/src/observation';
import { defaultPoolPath, loadPool, speciesKey } from '../../engine/src/pool';
import {
  deleteSetOverride,
  listSetCatalog,
  loadSetOverrides,
  saveSetOverride,
} from '../../engine/src/set-overrides';

const DEFAULT_FORMAT = 'gen9randombattle';
const AUTH_MS = 8000;
const ROOMLIST_MS = 2500;

export interface LauncherSettings {
  policy: string;
  dry_run: boolean;
  user: string;
  pass: string;
  url: string;
  decision_log: string;
  seed: number | null;
  shots: number | null;
}

export interface AttachedLive {
  room: string;
  pid: number;
  dryRun: boolean;
  policy: string;
}

export interface GamesSnapshot {
  connected: boolean;
  user: string;
  named: boolean;
  searching: string[];
  mine: DetectedGame[];
  listed: DetectedGame[];
  attached: AttachedLive | null;
  error?: string;
  settings: {
    user: string;
    url: string;
    policy: string;
    dry_run: boolean;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export class GameHub {
  private client?: LobbyClient;
  private live?: ChildProcess;
  private userName = '';
  private named = false;
  private searching: string[] = [];
  private mine: DetectedGame[] = [];
  private listed: DetectedGame[] = [];
  private attached: AttachedLive | null = null;
  private error?: string;
  private credUser = '';
  private credPass = '';
  private credUrl = '';
  private authWaiters: Array<() => void> = [];

  constructor(private readonly root: string) {}

  settingsPath(): string {
    return path.join(this.root, 'tools', 'launch-settings.json');
  }

  liveStatePath(): string {
    return process.env.POKELINK_STATE || path.join(this.root, 'live-state.json');
  }

  setOverridesPath(): string {
    return process.env.POKEREDUS_SET_OVERRIDES || path.join(this.root, 'set-overrides.json');
  }

  loadSettings(): LauncherSettings {
    const defaults: LauncherSettings = {
      policy: 'quantum',
      dry_run: true,
      user: '',
      pass: '',
      url: '',
      decision_log: 'decisions.jsonl',
      seed: null,
      shots: null,
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8')) as Partial<LauncherSettings>;
      return { ...defaults, ...raw };
    } catch {
      return defaults;
    }
  }

  snapshot(): GamesSnapshot {
    const s = this.loadSettings();
    return {
      connected: Boolean(this.client),
      user: this.userName,
      named: this.named,
      searching: this.searching,
      mine: this.mine,
      listed: this.listed,
      attached: this.attached,
      error: this.error,
      settings: {
        user: this.credUser || s.user,
        url: this.credUrl || s.url,
        policy: s.policy === 'softmax' ? 'softmax' : 'quantum',
        dry_run: Boolean(s.dry_run),
      },
    };
  }

  async detect(opts: { user?: string; pass?: string; url?: string; format?: string } = {}): Promise<GamesSnapshot> {
    this.error = undefined;
    const s = this.loadSettings();
    const user = opts.user ?? this.credUser ?? s.user;
    const pass = opts.pass ?? this.credPass ?? s.pass;
    const url = opts.url ?? this.credUrl ?? s.url;
    const format = opts.format || DEFAULT_FORMAT;
    if (this.client && (user !== this.credUser || pass !== this.credPass || url !== this.credUrl)) {
      this.closeLobby();
    }
    await this.ensureConnected({ user, pass, url });
    const gotList = new Promise<void>((resolve) => {
      const off = this.client!.onLobby((ev) => {
        if (ev.type === 'roomlist') {
          off();
          resolve();
        }
      });
      setTimeout(() => {
        off();
        resolve();
      }, ROOMLIST_MS);
    });
    this.client!.send(`|/cmd roomlist ${format}`);
    await gotList;
    return this.snapshot();
  }

  search(format = DEFAULT_FORMAT): GamesSnapshot {
    if (!this.client) {
      this.error = 'Connect and detect first.';
      return this.snapshot();
    }
    this.client.send(`|/search ${format}`);
    return this.snapshot();
  }

  cancelSearch(): GamesSnapshot {
    this.client?.send('|/cancelsearch');
    return this.snapshot();
  }

  attach(roomRaw: string, opts: { dryRun?: boolean; policy?: string } = {}): GamesSnapshot {
    const room = normalizeBattleRoom(roomRaw);
    if (!room) {
      this.error = 'Need a battle id.';
      return this.snapshot();
    }
    this.detach();
    const s = this.loadSettings();
    const policy = opts.policy === 'softmax' || opts.policy === 'quantum'
      ? opts.policy
      : s.policy === 'softmax' ? 'softmax' : 'quantum';
    const dryRun = opts.dryRun ?? s.dry_run;
    const user = this.credUser || s.user;
    const pass = this.credPass || s.pass;
    const url = this.credUrl || s.url;
    const tsx = tsxCli(this.root);
    const cliTs = path.join(this.root, 'packages', 'cli', 'src', 'cli.ts');
    const args = ['live', '--battle', room, '--policy', policy];
    if (dryRun) args.push('--dry-run');
    if (user) {
      args.push('--user', user);
      if (pass) args.push('--pass', pass);
    }
    if (url) args.push('--url', url);
    if (s.decision_log) args.push('--decision-log', s.decision_log);
    args.push('--live-state', this.liveStatePath());
    if (s.seed != null) args.push('--seed', String(s.seed));
    if (s.shots != null) args.push('--shots', String(s.shots));

    const env = {
      ...process.env,
      POKELINK_STATE: this.liveStatePath(),
      POKEREDUS_WEIGHTS: path.join(this.root, 'score-weights.json'),
      POKEREDUS_SET_OVERRIDES: this.setOverridesPath(),
      // ponytail: intercepted TLS on some Windows boxes breaks undici/ws verify. Set NODE_EXTRA_CA_CERTS to drop this.
      NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? '0',
    };
    const child = spawn(process.execPath, [tsx, cliTs, ...args], {
      cwd: this.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (buf: Buffer) => process.stdout.write(`[live] ${buf}`));
    child.stderr?.on('data', (buf: Buffer) => process.stderr.write(`[live] ${buf}`));
    child.on('exit', (code) => {
      if (this.live === child) {
        this.attached = null;
        this.live = undefined;
        if (code && code !== 0) this.error = `live exited ${code}`;
      }
    });
    this.live = child;
    this.attached = { room, pid: child.pid ?? 0, dryRun: Boolean(dryRun), policy };
    this.error = undefined;
    return this.snapshot();
  }

  detach(): GamesSnapshot {
    if (this.live) {
      this.live.kill();
      this.live = undefined;
    }
    this.attached = null;
    return this.snapshot();
  }

  disconnect(): GamesSnapshot {
    this.detach();
    this.closeLobby();
    this.searching = [];
    this.mine = [];
    this.listed = [];
    this.userName = '';
    this.named = false;
    this.error = undefined;
    return this.snapshot();
  }

  readLiveState(): unknown {
    const fp = this.liveStatePath();
    if (!fs.existsSync(fp)) return { status: 'idle' };
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch {
      return { status: 'idle' };
    }
  }

  private closeLobby(): void {
    this.client?.close();
    this.client = undefined;
  }

  private async ensureConnected(opts: { user: string; pass: string; url: string }): Promise<void> {
    if (this.client) return;
    this.credUser = opts.user;
    this.credPass = opts.pass;
    this.credUrl = opts.url;
    const client = new LobbyClient({
      url: opts.url || undefined,
      user: opts.user || undefined,
      pass: opts.pass || undefined,
    });
    client.onLobby((ev) => {
      if (ev.type === 'updateuser') {
        this.userName = ev.name.trim();
        this.named = ev.named;
        for (const w of this.authWaiters) w();
        this.authWaiters = [];
      } else if (ev.type === 'updatesearch') {
        this.searching = ev.searching;
        this.mine = gamesFromSearch(ev.games);
      } else if (ev.type === 'roomlist') {
        const mineRooms = new Set(this.mine.map((g) => g.room));
        this.listed = gamesFromRoomlist(ev.rooms)
          .map((g) => ({ ...g, mine: mineRooms.has(g.room) }))
          .slice(0, 40);
      } else if (ev.type === 'popup') {
        this.error = ev.text.replace(/<[^>]+>/g, ' ').trim();
      }
    });
    this.client = client;
    const authed = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, AUTH_MS);
      this.authWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
    await client.connect();
    await authed;
  }
}

function tsxCli(root: string): string {
  const candidates = [
    path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(root, 'packages', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('tsx CLI not found; run npm install');
}

export function gamesApiPlugin(root: string): Plugin {
  // ponytail: intercepted TLS on some Windows boxes breaks undici/ws verify. Set NODE_EXTRA_CA_CERTS to drop this.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';
  const hub = new GameHub(root);
  return {
    name: 'games-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '';
        try {
          if (url === '/api/live' || url.startsWith('/api/live?')) {
            sendJson(res, hub.readLiveState());
            return;
          }
          if (!url.startsWith('/api/games')) return next();
          const route = url.split('?')[0] ?? url;

          if (req.method === 'GET' && (route === '/api/games' || route === '/api/games/')) {
            sendJson(res, hub.snapshot());
            return;
          }
          if (req.method !== 'POST') return next();
          const body = await readJsonBody(req);
          if (route === '/api/games/detect' || route === '/api/games/connect') {
            sendJson(res, await hub.detect({
              user: str(body.user),
              pass: str(body.pass),
              url: str(body.url),
              format: str(body.format),
            }));
            return;
          }
          if (route === '/api/games/search') {
            sendJson(res, hub.search(str(body.format) || DEFAULT_FORMAT));
            return;
          }
          if (route === '/api/games/cancel') {
            sendJson(res, hub.cancelSearch());
            return;
          }
          if (route === '/api/games/attach') {
            sendJson(res, hub.attach(String(body.room ?? ''), {
              dryRun: typeof body.dryRun === 'boolean' ? body.dryRun : undefined,
              policy: str(body.policy),
            }));
            return;
          }
          if (route === '/api/games/detach') {
            sendJson(res, hub.detach());
            return;
          }
          if (route === '/api/games/disconnect') {
            sendJson(res, hub.disconnect());
            return;
          }
          return next();
        } catch (err) {
          sendJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
        }
      });
    },
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
