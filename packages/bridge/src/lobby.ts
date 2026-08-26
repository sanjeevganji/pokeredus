// Showdown lobby / search protocol — not battle lines.
// Used to detect the logged-in user's games and list public rooms.

export interface DetectedGame {
  room: string;
  title: string;
  p1?: string;
  p2?: string;
  minElo?: number;
  mine: boolean;
}

export type LobbyEvent =
  | { type: 'updateuser'; name: string; named: boolean }
  | { type: 'updatesearch'; searching: string[]; games: Record<string, string> }
  | { type: 'roomlist'; rooms: Record<string, RoomListEntry> }
  | { type: 'popup'; text: string }
  | { type: 'nametaken'; name: string; reason: string };

export interface RoomListEntry {
  p1?: string;
  p2?: string;
  minElo?: number;
}

export function normalizeBattleRoom(id: string): string {
  const battle = id.trim();
  if (!battle) return battle;
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

export function gamesFromSearch(games: Record<string, string>): DetectedGame[] {
  return Object.entries(games).map(([room, title]) => ({
    room: normalizeBattleRoom(room),
    title,
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
