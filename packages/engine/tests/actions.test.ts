import { describe, it, expect } from 'vitest';
import { enumerateFromRequest } from '../src/actions.js';

describe('enumerateFromRequest', () => {
  it('emits moves and switches without tera variants', () => {
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
    expect(moves.some((m) => m.tera)).toBe(false);
    expect(moves.some((m) => m.moveId === 'outrage')).toBe(false);
    expect(switches).toHaveLength(1);
    expect(switches[0]?.slot).toBe(2);
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
});
