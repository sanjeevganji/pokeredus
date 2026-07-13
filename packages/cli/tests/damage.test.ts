// Task 6 — DamageModel (Gen-9 formula), ported from pokeredus/graph/damage_calc.py.
// Fixtures use real data from tests/fixtures/pack.mini.json so we exercise the
// full pipeline: set → species → move → modifiers → result.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';
import type { Species, SetEntry, Move } from '@pokeredus/pack/schema';
import { PackIndex } from '@pokeredus/pack';
import { computeDamage, effectiveStat, computeHp } from '@pokeredus/engine';
import { getEffectiveness } from '@pokeredus/engine';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = KnowledgePackSchema.parse(JSON.parse(raw));
const idx = new PackIndex(pack);

// ── Fixtures loaded from the real mini pack ─────────────────────────────
function fixBy<T>(arr: T[], pred: (x: T) => boolean): T {
  const hit = arr.find(pred);
  if (!hit) throw new Error('fixture not found');
  return hit;
}
const venusaurSp = fixBy(pack.species, (s) => s.id === 'venusaur') as Species;
const clefableSp = fixBy(pack.species, (s) => s.id === 'clefable') as Species;
const arcSp = fixBy(pack.species, (s) => s.id === 'arcanine-hisui') as Species;
const venuSet = fixBy(pack.sets, (s) => s.id === 'venusaur_sun-sweeper') as SetEntry;
const clefSet = fixBy(pack.sets, (s) => s.id === 'clefable_showdown-usage') as SetEntry;
const arcSet = fixBy(pack.sets, (s) => s.id === 'arcanine-hisui_choice-band') as SetEntry;
const sludgeBomb = fixBy(pack.moves, (m) => m.id === 'sludge-bomb') as Move;
const flareBlitz = fixBy(pack.moves, (m) => m.id === 'flare-blitz') as Move;
const growth = fixBy(pack.moves, (m) => m.id === 'growth') as Move;

describe('DamageModel', () => {
  describe('effectiveStat / computeHp', () => {
    it('computes a level-100 HP stat correctly for Clefable', () => {
      // Clefable showdown-usage set: 252 HP EVs, Bold nature (assumed +Def/-Atk)
      // HP formula does NOT apply nature — pure stat formula.
      const hp = computeHp(clefableSp, clefSet, 100);
      // Clefable base HP 95, 31 IV, 252 EV → floor((2*95+31+63)*100/100 + 110) = 394
      expect(hp).toBeGreaterThan(380);
      expect(hp).toBeLessThan(420);
    });

    it('effectiveStat computes a Special Attack for Venusaur (Timid)', () => {
      // Timid = +Spe / -Atk, SPA is neutral → 100 base, 31 IV, 252 EV, level 100
      // floor((floor((2*100+31+63)*100/100)+5) * 1.0) = 299 (neutral nature)
      const spa = effectiveStat(venuSet, 'spa', venusaurSp, 100);
      expect(spa).toBeGreaterThan(290);
      expect(spa).toBeLessThan(310);
    });
  });

  describe('computeDamage — real pack fixtures', () => {
    it('Sludge Bomb (Poison, SE 2x vs Clefable Fairy) deals positive damage', () => {
      const r = computeDamage(venuSet, clefSet, sludgeBomb, venusaurSp, clefableSp, 100);
      expect(r.is_immune).toBe(false);
      expect(r.move_category).toBe('Special');
      expect(r.type_effectiveness).toBe(2); // Poison vs Fairy = 2
      expect(r.final_damage).toBeGreaterThan(0);
      expect(r.min_damage).toBeLessThanOrEqual(r.max_damage);
      expect(r.turns_to_kill).toBeGreaterThan(0);
      // Life Orb in venuSet → modifier_product should be ~1.3
      expect(r.modifier_product).toBeGreaterThan(1.2);
    });

    it('Flare Blitz (Fire, 2x vs Venusaur Grass) hits with STAB (Arcanine is Fire)', () => {
      const r = computeDamage(arcSet, venuSet, flareBlitz, arcSp, venusaurSp, 100);
      // Fire vs Grass = 2, STAB (Arcanine is Fire-type) = 1.5, Choice Band = 1.5 (Physical)
      expect(r.type_effectiveness).toBe(2);
      expect(r.stab_mult).toBe(1.5);
      // Choice Band boosts physical offense STAT (not modifier_product) —
      // the offensive_stat reflects the 1.5x boost vs the unmodified value.
      const noCb = computeDamage(
        { ...arcSet, item: 'leftovers' },
        venuSet, flareBlitz, arcSp, venusaurSp, 100,
      ).offensive_stat;
      expect(r.offensive_stat).toBeGreaterThanOrEqual(noCb);
      expect(r.final_damage).toBeGreaterThan(
        computeDamage({ ...arcSet, item: 'leftovers' }, venuSet, flareBlitz, arcSp, venusaurSp, 100).final_damage,
      );
      expect(r.final_damage).toBeGreaterThan(0);
      expect(r.is_contact).toBe(true);
      // Flare Blitz base power 120 ≥ 100 → should be a hard hit
      expect(r.max_damage).toBeGreaterThan(r.min_damage);
    });

    it('Status moves deal zero damage', () => {
      const r = computeDamage(venuSet, clefSet, growth, venusaurSp, clefableSp, 100);
      expect(r.move_category).toBe('Status');
      expect(r.final_damage).toBe(0);
      expect(r.min_damage).toBe(0);
      expect(r.max_damage).toBe(0);
      expect(r.turns_to_kill).toBe(0);
    });

    it('Immune move returns is_immune = true (Psychic vs Dark synthetic)', () => {
      // No Dark species in the mini pack — construct one synthetically to exercise
      // the immunity code path (Dark resists/immunes Psychic).
      const darkMon: Species = {
        id: 'absol', name: 'Absol', types: ['Dark'],
        base_stats: { hp: 100, atk: 90, def: 80, spa: 90, spd: 80, spe: 90 },
        abilities: ['intimidate'], weight: 50,
      };
      const darkSet: SetEntry = {
        id: 'synthetic-set', pokemon_id: 'synthetic-dark', set_name: 'X',
        ability: 'intimidate', item: 'leftovers',
        nature: { name: 'Adamant', increased_stat: 'atk', decreased_stat: 'spa' },
        evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252, label: '' },
        moves: ['psychic'], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
        role: 'wall', tera_type: '',
      };
      const psychicMove: Move = {
        id: 'psychic', name: 'Psychic', type: 'Psychic', category: 'Special',
        base_power: 90, accuracy: 100, priority: 0, flags: ['protect'],
      };
      const r = computeDamage(venuSet, darkSet, psychicMove, venusaurSp, darkMon, 100);
      expect(r.is_immune).toBe(true);
      expect(r.type_effectiveness).toBe(0);
      expect(r.final_damage).toBe(0);
    });
  });

  describe('ponytail self-check (inline)', () => {
    it('a nuke-tier SE move should not need many turns to kill', () => {
      // Flare Blitz vs Venusaur: 2x SE + STAB + CB + 120 BP → strong
      const r = computeDamage(arcSet, venuSet, flareBlitz, arcSp, venusaurSp, 100);
      expect(r.turns_to_kill).toBeLessThanOrEqual(2);
    });
  });
});
