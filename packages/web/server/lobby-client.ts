// Lobby-only Showdown socket for the Vite games API.
// Kept separate from ShowdownClient so vite.config does not load @pokeredus/engine.
import type { WebSocket } from 'ws';
import { getAssertion, guestName } from '../../bridge/src/auth';
import { parseBattleMetaLine, parseLobbyLine, type LobbyEvent } from '../../bridge/src/lobby';
import { closeShowdownWebSocket, connectShowdownWebSocket } from '../../bridge/src/socket';

type LobbyHandler = (ev: LobbyEvent) => void;

export class LobbyClient {
  url: string;
  private user?: string;
  private pass?: string;
  private ws?: WebSocket;
  private lobbyHandlers: LobbyHandler[] = [];
  authError?: string;

  constructor(opts: { url?: string; user?: string; pass?: string } = {}) {
    this.url = opts.url ?? '';
    this.user = opts.user;
    this.pass = opts.pass;
  }

  onLobby(h: LobbyHandler): () => void {
    this.lobbyHandlers.push(h);
    return () => {
      this.lobbyHandlers = this.lobbyHandlers.filter((x) => x !== h);
    };
  }

  async connect(): Promise<void> {
    const { ws, url } = await connectShowdownWebSocket(this.url);
    this.url = url;
    this.ws = ws;
    ws.on('message', (data: Buffer | ArrayBuffer | string) => {
      const text = typeof data === 'string' ? data : data.toString();
      this.onMessage(text);
    });
    ws.on('error', (err) => {
      if (err.message.includes('closed before the connection was established')) return;
      console.error('[games] ws error:', err);
    });
    ws.on('close', () => console.log('[games] ws closed'));
  }

  send(msg: string): void {
    if (!this.ws) {
      console.warn('[games] send before connect:', msg);
      return;
    }
    this.ws.send(msg);
  }

  close(): void {
    closeShowdownWebSocket(this.ws);
    this.ws = undefined;
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
        const msg = e instanceof Error ? e.message : String(e);
        this.authError = msg;
        console.error('[games] Showdown login failed:', e);
        for (const h of this.lobbyHandlers) h({ type: 'popup', text: msg });
      }
    } else {
      this.send(`|/trn ${guestName()},0,`);
    }
  }
}
