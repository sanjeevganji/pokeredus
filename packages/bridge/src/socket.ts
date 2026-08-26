// Showdown websocket connect — one place for URL, headers, and quiet close.
import { WebSocket } from 'ws';

export const DEFAULT_SHOWDOWN_WS = 'wss://sim3.psim.us/showdown/websocket';
export const FALLBACK_SHOWDOWN_WS = 'ws://sim3.psim.us:8000/showdown/websocket';

const WS_OPTS = {
  origin: 'https://play.pokemonshowdown.com',
  perMessageDeflate: false,
  handshakeTimeout: 12_000,
  // ponytail: some Windows DNS/IPv6 paths get HTTP 200 instead of a WS upgrade. Prefer v4; drop if psim ever goes v6-only.
  family: 4 as const,
  headers: {
    'User-Agent': 'Mozilla/5.0 (PokeRedus)',
  },
};

/** Turn a saved/custom value into a raw Showdown websocket URL. Garbage → default. */
export function resolveShowdownWsUrl(raw?: string): string {
  const u = (raw ?? '').trim();
  if (!u) return DEFAULT_SHOWDOWN_WS;
  if (u.startsWith('ws://') || u.startsWith('wss://')) return ensureWebsocketPath(u);
  if (u.startsWith('http://') || u.startsWith('https://')) {
    try {
      const parsed = new URL(u);
      const proto = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      return ensureWebsocketPath(`${proto}//${parsed.host}${parsed.pathname}`);
    } catch {
      return DEFAULT_SHOWDOWN_WS;
    }
  }
  return DEFAULT_SHOWDOWN_WS;
}

function ensureWebsocketPath(url: string): string {
  const [base, query] = url.split('?');
  let path = base ?? url;
  if (/\/showdown\/websocket\/?$/.test(path)) return query ? `${path}?${query}` : path;
  if (/\/showdown\/?$/.test(path)) path = path.replace(/\/?$/, '') + '/websocket';
  else if (!path.includes('/showdown')) path = path.replace(/\/?$/, '') + '/showdown/websocket';
  return query ? `${path}?${query}` : path;
}

function connectOnce(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, WS_OPTS);
    const settle = (fn: () => void) => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('unexpected-response', onUnexpected);
      fn();
    };
    const fail = (err: Error) => {
      settle(() => {
        closeShowdownWebSocket(ws);
        reject(err);
      });
    };
    const onOpen = () => settle(() => resolve(ws));
    const onError = (err: Error) => fail(err);
    const onUnexpected = (_req: unknown, res: { statusCode?: number }) => {
      fail(new Error(`ws unexpected response ${res.statusCode ?? '?'} from ${url}`));
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
    ws.once('unexpected-response', onUnexpected);
  });
}

/** Open a Showdown socket, trying the official wss then plaintext fallback. */
export async function connectShowdownWebSocket(raw?: string): Promise<{ ws: WebSocket; url: string }> {
  const urls = [...new Set([
    resolveShowdownWsUrl(raw),
    DEFAULT_SHOWDOWN_WS,
    FALLBACK_SHOWDOWN_WS,
  ])];
  let last: Error | undefined;
  for (const url of urls) {
    try {
      const ws = await connectOnce(url);
      return { ws, url };
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw last ?? new Error('showdown websocket failed');
}

/** Close without throwing/logging "closed before the connection was established". */
export function closeShowdownWebSocket(ws?: WebSocket): void {
  if (!ws) return;
  ws.removeAllListeners('error');
  ws.on('error', () => { /* handshake abort is expected */ });
  if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  else if (ws.readyState !== WebSocket.CLOSED) ws.close();
}
