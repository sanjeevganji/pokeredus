// Lobby-only Showdown socket for the Vite games API.
// Kept separate from ShowdownClient so vite.config does not load @pokeredus/engine.
import { WebSocket } from 'ws';
import { getAssertion, guestName } from '../../bridge/src/auth';
import { parseLobbyLine, type LobbyEvent } from '../../bridge/src/lobby';

type LobbyHandler = (ev: LobbyEvent) => void;

export class LobbyClient {
  readonly url: string;
  private user?: string;
  private pass?: string;
  private ws?: WebSocket;
  private lobbyHandlers: LobbyHandler[] = [];

  constructor(opts: { url?: string; user?: string; pass?: string } = {}) {
    this.url = opts.url ?? 'wss://sim3.psim.us/showdown/websocket';
    this.user = opts.user;
    this.pass = opts.pass;
  }

  onLobby(h: LobbyHandler): () => void {
    this.lobbyHandlers.push(h);
    return () => {
      this.lobbyHandlers = this.lobbyHandlers.filter((x) => x !== h);
    };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on('open', () => resolve());
      ws.on('message', (data: Buffer | ArrayBuffer | string) => {
        const text = typeof data === 'string' ? data : data.toString();
        this.onMessage(text);
      });
      ws.on('error', (err) => console.error('[games] ws error:', err));
      ws.on('close', () => console.log('[games] ws closed'));
      ws.on('unexpected-response', (_req, res) => reject(new Error(`ws unexpected response ${res.statusCode}`)));
    });
  }

  send(msg: string): void {
    if (!this.ws) {
      console.warn('[games] send before connect:', msg);
      return;
    }
    this.ws.send(msg);
  }

  close(): void {
    this.ws?.close();
  }

  private onMessage(data: string): void {
    for (const raw of data.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('>')) continue;
      if (line.startsWith('|challstr|')) {
        void this.handleChallstr(line);
        continue;
      }
      const lobby = parseLobbyLine(line);
      if (lobby) for (const h of this.lobbyHandlers) h(lobby);
    }
  }

  private async handleChallstr(line: string): Promise<void> {
    const parts = line.split('|');
    const challstr = parts.slice(2).join('|');
    if (this.user && this.pass) {
      try {
        const assertion = await getAssertion(this.user, this.pass, challstr);
        this.send(`|/trn ${this.user},0,${assertion}`);
      } catch (e) {
        console.error('[games] auth failed, falling back to guest:', e);
        this.send(`|/trn ${guestName()},0,`);
      }
    } else {
      this.send(`|/trn ${guestName()},0,`);
    }
  }
}
