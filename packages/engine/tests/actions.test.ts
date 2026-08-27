import { describe, it, expect } from 'vitest';
import { enumerateFromRequest, enumerateForEval, legalFromSlots } from '../src/actions.js';

describe('enumerateFromRequest', () => {
  it('emits ordinary and tera variants while Tera is available', () => {
    const actions = enumerateFromRequest({
      active: [{
        moves: [
          { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false },
          { move: 'Outrage', id: 'outrage', pp: 0, maxpp: 16, disabled: false },
        ],
        canTerastallize: 'Ground',
      }],
      side: {
        pokemon: [
          { ident: 'p1: Garchomp', details: 'Garchomp', condition: '100/100', active: true, moves: [] },
          { ident: 'p1: Toxapex', details: 'Toxapex', condition: '80/100', active: false, moves: [] },
          { ident: 'p1: Clefable', details: 'Clefable', condition: '0 fnt', active: false, moves: [] },
        ],
      },
    });
    const moves = actions.filter((a) => a.type === 'move');
    const switches = actions.filter((a) => a.type === 'switch');
    expect(moves.some((m) => m.moveId === 'earthquake' && !m.tera)).toBe(true);
    expect(moves.some((m) => m.moveId === 'earthquake' && m.tera)).toBe(true);
    expect(moves.some((m) => m.id === 'move:earthquake:tera')).toBe(true);
    expect(moves.some((m) => m.moveId === 'outrage')).toBe(false);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.slot).toBe(2);
    expect(switches.some((s) => s.tera)).toBe(false);
  });

  it('omits tera variants after Tera is used', () => {
    const actions = enumerateFromRequest({
      active: [{
        moves: [{ move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false }],
        canTerastallize: 'Ground',
      }],
      side: {
        pokemon: [
          { ident: 'p1: Garchomp', details: 'Garchomp', condition: '100/100', active: true, moves: [] },
        ],
      },
    }, true);
    expect(actions.some((a) => a.tera)).toBe(false);
    expect(actions.some((a) => a.moveId === 'earthquake' && !a.tera)).toBe(true);
  });

  it('force-switch emits only switches with CTS forced', () => {
    const actions = enumerateFromRequest({
      forceSwitch: [true],
      side: {
        pokemon: [
          { ident: 'p1: A', details: 'A', condition: '0 fnt', active: true, moves: [] },
          { ident: 'p1: B', details: 'B', condition: '100/100', active: false, moves: [] },
        ],
      },
    });
    expect(actions.every((a) => a.type === 'switch' && a.forced)).toBe(true);
  });

  it('wait requests yield no sendable actions but enumerateForEval uses team moves', () => {
    const req = {
      wait: true,
      side: {
        pokemon: [
          {
            ident: 'p1: Garchomp', details: 'Garchomp', condition: '100/100', active: true,
            moves: [
              { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false },
              { move: 'Outrage', id: 'outrage', pp: 8, maxpp: 16, disabled: false },
            ],
          },
          { ident: 'p1: Toxapex', details: 'Toxapex', condition: '100/100', active: false, moves: [] },
        ],
      },
    };
    expect(enumerateFromRequest(req)).toEqual([]);
    const scored = enumerateForEval(req);
    expect(scored.some((a) => a.moveId === 'earthquake')).toBe(true);
    expect(scored.some((a) => a.type === 'switch' && a.slot === 2)).toBe(true);
  });
});

describe('legalFromSlots', () => {
  it('uses assumed-set moves when knownMoves are empty', () => {
    const actions = legalFromSlots([{
      slot: 0, speciesId: 'garchomp', revealed: true, hp: 100, maxHp: 100, status: '',
      boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
      fainted: false, active: true, knownMoves: [], hypotheses: [], modifiers: [],
      set: {
        species: 'Garchomp', level: 80, item: 'leftovers', ability: 'roughskin',
        moves: ['Earthquake', 'Swords Dance', 'Scale Shot', 'Fire Fang'], nature: 'Jolly',
      },
    }]);
    expect(actions.map((a) => a.moveId).filter(Boolean)).toEqual(
      expect.arrayContaining(['earthquake', 'swordsdance', 'scaleshot', 'firefang']),
    );
  });
});
