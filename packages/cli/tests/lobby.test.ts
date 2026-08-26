import { describe, it, expect } from 'vitest';
import {
  gamesFromRoomlist,
  gamesFromSearch,
  normalizeBattleRoom,
  parseLobbyLine,
} from '@pokeredus/bridge';

describe('normalizeBattleRoom', () => {
  it('accepts full, prefix-less, and numeric ids', () => {
    expect(normalizeBattleRoom('battle-gen9randombattle-9')).toBe('battle-gen9randombattle-9');
    expect(normalizeBattleRoom('gen9randombattle-9')).toBe('battle-gen9randombattle-9');
    expect(normalizeBattleRoom('9')).toBe('battle-gen9randombattle-9');
  });

  it('extracts a room from a Showdown play or replay URL', () => {
    expect(normalizeBattleRoom('https://play.pokemonshowdown.com/battle-gen9randombattle-9'))
      .toBe('battle-gen9randombattle-9');
    expect(normalizeBattleRoom('https://replay.pokemonshowdown.com/gen9randombattle-9'))
      .toBe('battle-gen9randombattle-9');
    expect(normalizeBattleRoom('play.pokemonshowdown.com/battle-gen9randombattle-9?t=1'))
      .toBe('battle-gen9randombattle-9');
  });
});

describe('parseLobbyLine', () => {
  it('parses updatesearch games for the logged-in user', () => {
    const ev = parseLobbyLine(
      '|updatesearch|{"searching":["gen9randombattle"],"games":{"battle-gen9randombattle-1":"[Gen 9] Random Battle"}}',
    );
    expect(ev).toEqual({
      type: 'updatesearch',
      searching: ['gen9randombattle'],
      games: { 'battle-gen9randombattle-1': '[Gen 9] Random Battle' },
    });
    expect(gamesFromSearch(ev && ev.type === 'updatesearch' ? ev.games : {})).toEqual([
      { room: 'battle-gen9randombattle-1', title: '[Gen 9] Random Battle', mine: true },
    ]);
  });

  it('parses a roomlist queryresponse', () => {
    const ev = parseLobbyLine(
      '|queryresponse|roomlist|{"rooms":{"battle-gen9randombattle-2":{"p1":"a","p2":"b","minElo":1000}}}',
    );
    expect(ev?.type).toBe('roomlist');
    const listed = gamesFromRoomlist(ev && ev.type === 'roomlist' ? ev.rooms : {});
    expect(listed).toEqual([
      { room: 'battle-gen9randombattle-2', title: 'a vs b', p1: 'a', p2: 'b', minElo: 1000, mine: false },
    ]);
  });

  it('parses updateuser and ignores battle lines', () => {
    expect(parseLobbyLine('|updateuser| alice|1|170|{}')).toEqual({
      type: 'updateuser', name: 'alice', named: true,
    });
    expect(parseLobbyLine('|turn|3')).toBeNull();
    expect(parseLobbyLine('|request|{"side":{}}')).toBeNull();
    expect(parseLobbyLine('|nametaken|alice|Wrong password.')).toEqual({
      type: 'nametaken', name: 'alice', reason: 'Wrong password.',
    });
  });
});
