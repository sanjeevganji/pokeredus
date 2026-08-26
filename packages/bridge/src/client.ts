// ShowdownClient — a thin websocket session over `ws`.
//
// Responsibilities:
//   * connect to the PS websocket endpoint,
//   * transparently handle the `|challstr|` → `|/trn` auth handshake,
//   * auto-join a battle room when `battleRoom` is provided,
//   * parse battle lines with `parseLine` and lobby lines with `parseLobbyLine`.
//
// It deliberately does NOT hold game state or make decisions — that belongs to
// `BattleTracker` + `decide.ts`. The client is pure connectivity + parsing.
import type { WebSocket } from 'ws';
import { parseLine, type BattleEvent } from './protocol.js';
import { getAssertion, guestName } from './auth.js';
import { parseLobbyLine, type LobbyEvent } from './lobby.js';
import { closeShowdownWebSocket, connectShowdownWebSocket } from './socket.js';

export interface ShowdownClientOptions {
  url?: string;
  user?: string;
  pass?: string;
  /** Battle room to auto-join after auth, e.g. `battle-gen9ou-123`. */
  battleRoom?: string;
  dryRun?: boolean;
}

type EventHandler = (ev: BattleEvent) => void;
type LobbyHandler = (ev: LobbyEvent) => void;

export class ShowdownClient {
  readonly url: string;
  private user?: string;
  private pass?: string;
  private battleRoom?: string;
  dryRun: boolean;

  private ws?: WebSocket;
  private handlers: EventHandler[] = [];
  private lobbyHandlers: LobbyHandler[] = [];

  constructor(opts: ShowdownClientOptions = {}) {
    this.url = opts.url ?? 'wss://sim3.psim.us/showdown/websocket';
    this.user = opts.user;
    this.pass = opts.pass;
    this.battleRoom = opts.battleRoom;
    this.dryRun = opts.dryRun ?? false;
  }

  /** Register a handler fired for every parsed BattleEvent. */
  onEvent(h: EventHandler): void {
    this.handlers.push(h);
  }

  /** Register a handler for lobby / search lines (`updatesearch`, `roomlist`, …). */
  onLobby(h: LobbyHandler): () => void {
    this.lobbyHandlers.push(h);
    return () => {
      this.lobbyHandlers = this.lobbyHandlers.filter((x) => x !== h);
    };
  }

  /** Open the socket. Resolves once the connection is established. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => {
        console.log(`[pokeredus] connected to ${this.url}`);
        resolve();
      });
      ws.on('message', (data: Buffer | ArrayBuffer | string) => {
        const text = typeof data === 'string' ? data : data.toString();
        this.onMessage(text);
      });
      ws.on('error', (err) => console.error('[pokeredus] ws error:', err));
      ws.on('close', () => console.log('[pokeredus] ws closed'));
      ws.on('unexpected-response', (_req, res) => reject(new Error(`ws unexpected response ${res.statusCode}`)));
    });
  }

  /** Send a raw protocol message. */
  send(msg: string): void {
    if (!this.ws) {
      console.warn('[pokeredus] send before connect:', msg);
      return;
    }
    this.ws.send(msg);
  }

  /** Close the session. */
  close(): void {
    this.ws?.close();
  }

  private onMessage(data: string): void {
    for (const raw of data.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('>')) continue;
      if (line.startsWith('|challstr|')) {
        void this.handleChallstr(line);
        continue;
      }
      const lobby = parseLobbyLine(line);
      if (lobby) {
        for (const h of this.lobbyHandlers) h(lobby);
        continue;
      }
      const ev = parseLine(line);
      if (ev) for (const h of this.handlers) h(ev);
    }
  }

  private async handleChallstr(line: string): Promise<void> {
    const parts = line.split('|'); // ['', 'challstr', '<id>', '<challstr>']
    const challstr = parts.slice(2).join('|');
    if (this.user && this.pass) {
      try {
        const assertion = await getAssertion(this.user, this.pass, challstr);
        this.send(`|/trn ${this.user},0,${assertion}`);
      } catch (e) {
        console.error('[pokeredus] auth failed, falling back to guest:', e);
        this.send(`|/trn ${guestName()},0,`);
      }
    } else {
      this.send(`|/trn ${guestName()},0,`);
    }
    if (this.battleRoom) this.send(`|/join ${this.battleRoom}`);
  }
}
