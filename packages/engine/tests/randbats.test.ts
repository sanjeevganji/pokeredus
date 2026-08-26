import { describe, it, expect } from 'vitest';
import { loadPool } from '../src/pool.js';
import { compatible } from '../src/beliefs.js';
import { materializeRole, parseRandbats, pickMoves, randbatsToPool } from '../src/randbats.js';

const sample = {
  Garchomp: {
    level: 74,
    abilities: ['Rough Skin'],
    items: ['Loaded Dice', 'Rocky Helmet'],
    roles: {
      'Fast Support': {
        abilities: ['Rough Skin'],
        items: ['Rocky Helmet'],
        teraTypes: ['Ground', 'Steel'],
        moves: ['Dragon Tail', 'Earthquake', 'Outrage', 'Spikes', 'Stealth Rock'],
      },
      'Setup Sweeper': {
        abilities: ['Rough Skin'],
        items: ['Loaded Dice'],
        teraTypes: ['Fire', 'Ground', 'Steel'],
        moves: ['Earthquake', 'Fire Fang', 'Iron Head', 'Scale Shot', 'Stone Edge', 'Swords Dance'],
      },
    },
  },
  Alcremie: {
    level: 90,
    abilities: ['Aroma Veil'],
    items: ['Leftovers'],
    roles: {
      'Tera Blast user': {
        abilities: ['Aroma Veil'],
        items: ['Leftovers'],
        teraTypes: ['Ground'],
        moves: ['Alluring Voice', 'Calm Mind', 'Recover', 'Tera Blast'],
        evs: { atk: 0 },
        ivs: { atk: 0 },
      },
    },
    evs: { atk: 0 },
    ivs: { atk: 0 },
  },
};

describe('randbats import', () => {
  it('turns roles into pool rows with JSON defaults', () => {
    const pool = randbatsToPool(sample);
    expect(pool.species.garchomp).toHaveLength(2);
    const support = pool.species.garchomp!.find((r) => r.set.role === 'Fast Support')!.set;
    expect(support.level).toBe(74);
    expect(support.nature).toBe('Hardy');
    expect(support.item).toBe('Rocky Helmet');
    expect(support.teraTypes).toEqual(['Ground', 'Steel']);
    expect(support.movePool).toHaveLength(5);
    expect(support.moves).toHaveLength(4);
    expect(support.evs?.hp).toBe(85);
    const alcremie = pool.species.alcremie![0]!.set;
    expect(alcremie.evs?.atk).toBe(0);
    expect(alcremie.ivs?.atk).toBe(0);
    expect(alcremie.level).toBe(90);
  });

  it('matches revealed tera against role options and extra moves against the pool', () => {
    const spec = parseRandbats(sample).garchomp!;
    const set = materializeRole(spec, spec.roles[1]!);
    expect(compatible(set, { species: 'garchomp', moves: ['swordsdance'] })).toBe(true);
    expect(compatible(set, { species: 'garchomp', moves: [], teraType: 'Fire' })).toBe(true);
    expect(compatible(set, { species: 'garchomp', moves: [], teraType: 'Water' })).toBe(false);
  });

  it('prefers revealed moves when picking four', () => {
    expect(pickMoves(['a', 'b', 'c', 'd', 'e'], ['e', 'c'])).toEqual(['e', 'c', 'a', 'b']);
  });

  it('loads the committed gen9 file', () => {
    const pool = loadPool();
    expect(Object.keys(pool.species).length).toBeGreaterThan(400);
    expect(pool.species.garchomp?.some((r) => r.set.role === 'Setup Sweeper')).toBe(true);
  });
});
