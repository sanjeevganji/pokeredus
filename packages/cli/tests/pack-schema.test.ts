// Task 2 — Knowledge Pack Zod schema validation.
import { describe, it, expect } from 'vitest';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';

const minimal = {
  version: 1,
  generated_at: '2026-07-08T00:00:00+00:00',
  types: { Normal: { Normal: 1, Fire: 1 }, Fire: { Normal: 1, Fire: 0.5 } },
  species: [],
  moves: [],
  abilities: [],
  items: [],
  sets: [],
  edges: [],
};

describe('KnowledgePackSchema', () => {
  it('accepts a minimal valid pack', () => {
    const parsed = KnowledgePackSchema.parse(minimal);
    expect(parsed.version).toBe(1);
  });

  it('rejects the wrong version', () => {
    expect(() => KnowledgePackSchema.parse({ ...minimal, version: 2 })).toThrow();
  });

  it('rejects a missing required section', () => {
    const { species, ...rest } = minimal;
    expect(() => KnowledgePackSchema.parse(rest)).toThrow();
  });

  it('accepts a full species/set/move/edge row', () => {
    const full = {
      ...minimal,
      species: [{
        id: 'garchomp', name: 'Garchomp', types: ['Dragon', 'Ground'],
        base_stats: { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 },
        abilities: ['sand-stream'], weight: 95, tier: 'OU',
      }],
      moves: [{
        id: 'earthquake', name: 'Earthquake', type: 'Ground',
        category: 'Physical', base_power: 100, accuracy: true,
        priority: 0, flags: ['contact'],
      }],
      sets: [{
        id: 'garchomp_rock-polisher', pokemon_id: 'garchomp', set_name: 'Rock Polisher',
        ability: 'sand-stream', item: 'leftovers',
        nature: { name: 'Jolly', increased_stat: 'spe', decreased_stat: 'spa' },
        evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252, label: '252 Atk / 4 SpD / 252 Spe' },
        moves: ['earthquake', 'stone-edge', 'swords-dance', 'rapid-spin'],
        ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        role: 'setup_sweeper', tera_type: 'Ground',
      }],
      edges: [{
        a_set_id: 'garchomp_rock-polisher', b_set_id: 'garchomp_rock-polisher',
        score: 0.5, best_move_a_id: 'earthquake', ttk_a: 2, ttk_b: 3,
        dmg_pct_lo: 40, dmg_pct_hi: 55,
      }],
    };
    expect(KnowledgePackSchema.parse(full)).toBeDefined();
  });
});
