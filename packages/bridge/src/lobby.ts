// Showdown lobby / search protocol — not battle lines.
// Used to detect the logged-in user's games and list public rooms.

export interface DetectedGame {
  room: string;
  title: string;
  p1?: string;
  p2?: string;
  turn?: number;
  minElo?: number;
  mine: boolean;
}

export type BattleMeta = {
  p1?: string;
  p2?: string;
  turn?: number;
  title?: string;
};

export type LobbyEvent =
  | { type: 'updateuser'; name: string; named: boolean }
  | { type: 'updatesearch'; searching: string[]; games: Record<string, string> }
  | { type: 'roomlist'; rooms: Record<string, RoomListEntry> }
  | { type: 'popup'; text: string }
  | { type: 'nametaken'; name: string; reason: string }
  | ({ type: 'battlemeta'; room: string } & BattleMeta);

export interface RoomListEntry {
  p1?: string;
  p2?: string;
  minElo?: number;
}

export function normalizeBattleRoom(id: string): string {
  let battle = id.trim();
  if (!battle) return battle;
  const embedded = battle.match(/battle-[a-z0-9]+-\d+[a-z0-9-]*/i);
  if (embedded) return embedded[0];
  if (/^https?:\/\//i.test(battle) || /pokemonshowdown\.com|psim\.us/i.test(battle)) {
    try {
      const href = battle.includes('://') ? battle : `https://${battle}`;
      battle = new URL(href).pathname.split('/').filter(Boolean).pop() ?? battle;
    } catch { /* keep trimmed input */ }
  }
  battle = battle.replace(/[/?#].*$/, '');
  if (battle.startsWith('battle-')) return battle;
  if (/^\d+$/.test(battle)) return `battle-gen9randombattle-${battle}`;
  return `battle-${battle}`;
}

export function parseLobbyLine(raw: string): LobbyEvent | null {
  let line = raw.trim();
  if (!line) return null;
  if (!line.startsWith('|')) {
    const bar = line.indexOf('|');
    if (bar < 0) return null;
    line = line.slice(bar);
  }
  const parts = line.split('|');
  const cmd = parts[1];
  if (cmd === 'updateuser') {
    return { type: 'updateuser', name: (parts[2] ?? '').trim(), named: parts[3] === '1' };
  }
  if (cmd === 'updatesearch') {
    try {
      const data = JSON.parse(parts.slice(2).join('|')) as {
        searching?: string[];
        games?: Record<string, string>;
      };
      return {
        type: 'updatesearch',
        searching: Array.isArray(data.searching) ? data.searching : [],
        games: data.games && typeof data.games === 'object' ? data.games : {},
      };
    } catch {
      return null;
    }
  }
  if (cmd === 'queryresponse' && parts[2] === 'roomlist') {
    try {
      const data = JSON.parse(parts.slice(3).join('|')) as
        | { rooms?: Record<string, RoomListEntry> }
        | Record<string, RoomListEntry>;
      const rooms =
        data && typeof data === 'object' && 'rooms' in data && data.rooms
          ? data.rooms
          : (data as Record<string, RoomListEntry>);
      return { type: 'roomlist', rooms: rooms && typeof rooms === 'object' ? rooms as Record<string, RoomListEntry> : {} };
    } catch {
      return null;
    }
  }
  if (cmd === 'popup') {
    return { type: 'popup', text: parts.slice(2).join('|') };
  }
  if (cmd === 'nametaken') {
    return { type: 'nametaken', name: parts[2] ?? '', reason: parts.slice(3).join('|') };
  }
  return null;
}

export function parseBattleMetaLine(raw: string): BattleMeta | null {
  let line = raw.trim();
  if (!line.startsWith('|')) {
    const bar = line.indexOf('|');
    if (bar < 0) return null;
    line = line.slice(bar);
  }
  const parts = line.split('|');
  const cmd = parts[1];
  if (cmd === 'player') {
    const name = (parts[3] ?? '').trim();
    if (!name) return null;
    if (parts[2] === 'p1') return { p1: name };
    if (parts[2] === 'p2') return { p2: name };
    return null;
  }
  if (cmd === 'turn') {
    const turn = Number(parts[2]);
    return Number.isFinite(turn) ? { turn } : null;
  }
  if (cmd === 'title') {
    const title = (parts[2] ?? '').trim();
    if (!title) return null;
    return { title, ...playersFromTitle(title) };
  }
  return null;
}

export function applyBattleMeta(game: DetectedGame, patch: BattleMeta): DetectedGame {
  const p1 = patch.p1 || game.p1;
  const p2 = patch.p2 || game.p2;
  return {
    ...game,
    p1,
    p2,
    turn: patch.turn ?? game.turn,
    title: p1 || p2 ? `${p1 ?? '?'} vs ${p2 ?? '?'}` : (patch.title || game.title),
  };
}

function playersFromTitle(title: string): { p1?: string; p2?: string } {
  const m = /^(.+?)\s+vs\.?\s+(.+)$/i.exec(title.trim());
  return m ? { p1: m[1]!.trim(), p2: m[2]!.trim() } : {};
}

export function gamesFromSearch(games: Record<string, string>): DetectedGame[] {
  return Object.entries(games).map(([room, title]) => ({
    room: normalizeBattleRoom(room),
    title,
    ...playersFromTitle(title),
    mine: true,
  }));
}

export function gamesFromRoomlist(rooms: Record<string, RoomListEntry>): DetectedGame[] {
  return Object.entries(rooms)
    .filter(([room]) => room.startsWith('battle-'))
    .map(([room, info]) => ({
      room,
      title: `${info?.p1 ?? '?'} vs ${info?.p2 ?? '?'}`,
      p1: info?.p1,
      p2: info?.p2,
      minElo: info?.minElo,
      mine: false,
    }));
}
