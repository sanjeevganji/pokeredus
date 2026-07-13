import { describe, it, expect } from 'vitest';
import { calculate, Pokemon, Move, Generations } from '@smogon/calc';
import { computeDamage, getTypeEffectiveness } from '../src/index.js';
import type { Species, SetEntry, Move as PackMove } from '@pokeredus/pack';

const GEN = Generations.get(9);

const garchomp: Species = {
  id: 'garchomp', name: 'Garchomp', types: ['Dragon', 'Ground'],
  base_stats: { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
  abilities: ['sandveil'], weight: 95, tier: 'OU',
};
const heatran: Species = {
  id: 'heatran', name: 'Heatran', types: ['Fire', 'Steel'],
  base_stats: { hp: 91, atk: 90, def: 106, spa: 130, spd: 106, spe: 77 },
  abilities: ['flashfire'], weight: 430, tier: 'OU',
};
const chompSet: SetEntry = {
  id: 'garchomp_cb', pokemon_id: 'garchomp', set_name: 'CB',
  ability: 'rough-skin', item: 'choice-band',
  nature: { name: 'Jolly', increased_stat: 'spe', decreased_stat: 'spa' },
  evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252, label: '' },
  moves: ['earthquake'], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  role: 'sweeper', tera_type: '',
};
const heatranSet: SetEntry = {
  id: 'heatran_sdef', pokemon_id: 'heatran', set_name: 'SDef',
  ability: 'flash-fire', item: 'leftovers',
  nature: { name: 'Calm', increased_stat: 'spd', decreased_stat: 'atk' },
  evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 4, label: '' },
  moves: ['lavaplume'], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  role: 'wall', tera_type: '',
};
const eq: PackMove = {
  id: 'earthquake', name: 'Earthquake', type: 'Ground', category: 'Physical',
  base_power: 100, accuracy: 100, priority: 0, flags: ['contact'],
};

describe('@smogon/calc golden matchups', () => {
  it('Garchomp CB Earthquake vs Heatran — adapter matches direct calc', () => {
    const adapted = computeDamage(chompSet, heatranSet, eq, garchomp, heatran, 100);
    const direct = calculate(
      GEN,
      new Pokemon(GEN, 'Garchomp', {
        level: 100, ability: 'Rough Skin', item: 'Choice Band', nature: 'Jolly',
        evs: { atk: 252, spe: 252, spd: 4 },
      }),
      new Pokemon(GEN, 'Heatran', {
        level: 100, ability: 'Flash Fire', item: 'Leftovers', nature: 'Calm',
        evs: { hp: 252, spd: 252, spe: 4 },
      }),
      new Move(GEN, 'Earthquake'),
    );
    const [dMin, dMax] = direct.range();
    expect(adapted.min_damage).toBe(dMin);
    expect(adapted.max_damage).toBe(dMax);
    expect(adapted.type_effectiveness).toBe(4);
    expect(adapted.turns_to_kill).toBeLessThanOrEqual(2);
  });

  it('type chart: Poison vs Fairy is 2x', () => {
    expect(getTypeEffectiveness('Poison', ['Fairy'])).toBe(2);
  });

  it('type chart: Psychic vs Dark is immune', () => {
    expect(getTypeEffectiveness('Psychic', ['Dark'])).toBe(0);
  });

  it('Fire STAB Flare Blitz vs Grass has 2x type eff', () => {
    expect(getTypeEffectiveness('Fire', ['Grass', 'Poison'])).toBe(2);
  });
});
