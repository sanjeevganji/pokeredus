import { describe, it, expect } from 'vitest';
import { hypothesesForSpecies, initialBelief, updateBeliefs } from '../src/beliefs.js';
import type { RandomSetPool } from '../src/pool.js';

const pool: RandomSetPool = {
  format: 'gen9randombattle',
  version: 1,
  samples: 10,
  seed: 1,
  species: {
    garchomp: [
      {
        set: {
          species: 'Garchomp',
          level: 78,
          item: 'loadeddice',
          ability: 'roughskin',
          moves: ['earthquake', 'swordsdance', 'scaleshot', 'firefang'],
          nature: 'Jolly',
        },
        count: 7,
      },
      {
        set: {
          species: 'Garchomp',
          level: 78,
          item: 'choicescarf',
          ability: 'roughskin',
          moves: ['earthquake', 'outrage', 'stoneedge', 'firefang'],
          nature: 'Jolly',
        },
        count: 3,
      },
    ],
  },
};

describe('Random Battle set beliefs', () => {
  it('starts at the highest-frequency compatible set', () => {
    const h = initialBelief(pool, { species: 'garchomp', moves: [] });
    expect(h[0]?.set.item).toBe('loadeddice');
    expect(h[0]?.probability).toBeCloseTo(0.7);
  });

  it('drops impossible hypotheses and renormalizes', () => {
    const prior = hypothesesForSpecies(pool, 'garchomp');
    const next = updateBeliefs(prior, { species: 'garchomp', moves: [], item: 'choicescarf' });
    expect(next).toHaveLength(1);
    expect(next[0]?.set.item).toBe('choicescarf');
    expect(next[0]?.probability).toBeCloseTo(1);
  });

  it('fails visibly when no candidate remains', () => {
    const prior = hypothesesForSpecies(pool, 'garchomp');
    expect(() => updateBeliefs(prior, { species: 'garchomp', moves: ['splash'] })).toThrow(/no compatible/);
  });

  it('fails visibly when the species is absent', () => {
    expect(() => hypothesesForSpecies(pool, 'missingno')).toThrow(/no hypotheses/);
  });
});
