// Task 5 — TypeChart effectiveness, ported from pokeredus/classes/types.py.
// Pinned values mirror the canonical 18×18 chart exactly.
import { describe, it, expect } from 'vitest';
import { getEffectiveness, getBestEffectiveness, POKEMON_TYPES, TYPE_CHART } from '../src/engine/type-chart.js';

describe('TypeChart', () => {
  it('exposes all 18 canonical Pokémon types', () => {
    expect(POKEMON_TYPES).toHaveLength(18);
    expect(POKEMON_TYPES).toContain('Normal');
    expect(POKEMON_TYPES).toContain('Fairy');
  });

  it('water vs fire = super-effective (2x)', () => {
    expect(getEffectiveness('Water', ['Fire'])).toBe(2);
  });

  it('fire vs fire = double resist (0.25 = 0.5^2)', () => {
    // No dual Fire in the chart test, but [Fire, Fire] would be 0.5*0.5
    expect(getEffectiveness('Fire', ['Fire'])).toBe(0.5);
    expect(getEffectiveness('Fire', ['Fire', 'Fire'])).toBeCloseTo(0.25);
  });

  it('ground vs flying = immune (0)', () => {
    expect(getEffectiveness('Ground', ['Flying'])).toBe(0);
  });

  it('ghost vs normal = immune (0)', () => {
    expect(getEffectiveness('Ghost', ['Normal'])).toBe(0);
  });

  it('normal vs steel = resisted (0.5)', () => {
    expect(getEffectiveness('Normal', ['Steel'])).toBe(0.5);
  });

  it('neutral default = 1.0', () => {
    expect(getEffectiveness('Normal', ['Water'])).toBe(1);
  });

  it('dual-type defender: ground vs [Fire, Steel] = 2*2 = 4x', () => {
    // Ground SE Fire (2) and SE Steel (2) → product 4
    expect(getEffectiveness('Ground', ['Fire', 'Steel'])).toBe(4);
  });

  it('dual-type defender: water vs [Fire, Rock] = 2*2 = 4x', () => {
    expect(getEffectiveness('Water', ['Fire', 'Rock'])).toBe(4);
  });

  it('dual-type defender: fire vs [Water, Dragon] = 0.5*0.5 = 0.25x', () => {
    expect(getEffectiveness('Fire', ['Water', 'Dragon'])).toBeCloseTo(0.25);
  });

  it('getBestEffectiveness picks the strongest attacking type', () => {
    // Water (2x vs Fire) beats Grass (0.5x vs Fire) for attacker [Water, Grass]
    const [best, mult] = getBestEffectiveness(['Water', 'Grass'], ['Fire']);
    expect(best).toBe('Water');
    expect(mult).toBe(2);
  });

  it('every canonical attacker has a row in TYPE_CHART', () => {
    for (const t of POKEMON_TYPES) {
      expect(TYPE_CHART[t]).toBeDefined();
      for (const d of POKEMON_TYPES) {
        expect(TYPE_CHART[t]?.[d]).toBeTypeOf('number');
      }
    }
  });
});
