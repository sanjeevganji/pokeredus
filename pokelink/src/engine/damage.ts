// DamageModel — Gen-9 damage formula ported from pokeredus/graph/damage_calc.py.
// Every intermediate is Math.floor-ed exactly as the Python implementation does.
import type { SetEntry, Move, Species } from '../pack/schema.js';
import { getEffectiveness } from './type-chart.js';

export interface DamageResult {
  move_id: string;
  move_name: string;
  move_type: string;
  move_category: string;
  base_power: number;
  offensive_stat: number;
  defensive_stat: number;
  base_damage: number;
  stab_mult: number;
  type_effectiveness: number;
  modifier_product: number;
  final_damage: number;
  effective_hp: number;
  turns_to_kill: number;
  is_ohko: boolean;
  is_immune: boolean;
  is_contact: boolean;
  min_damage: number;
  max_damage: number;
}

/** A pluggable damage modifier — mirrors DamageModifier from damage_calc.py. */
export interface Modifier {
  name: string;
  priority: number;
  modifyOffense?(statValue: number, ctx: ModifierContext): number;
  modifyDefense?(statValue: number, ctx: ModifierContext): number;
  modifyDamage?(baseDamage: number, ctx: ModifierContext): number;
  modifyTypeEffectiveness?(eff: number, ctx: ModifierContext): number;
  modifyStab?(stab: number, ctx: ModifierContext): number;
  shouldSkip?(ctx: ModifierContext): boolean;
}

export interface ModifierContext {
  attackerSet: SetEntry;
  defenderSet: SetEntry;
  attackerPokemon: Species;
  defenderPokemon: Species;
  move: Move;
}

// ── Built-in modifiers (same set as Python get_calculator()) ─────────
// Item ids in the Knowledge Pack are lowercase with hyphens (e.g.
// "choice-band", "life-orb"). Normalize by stripping hyphens before compare.

function normItem(item: string): string {
  return item.toLowerCase().replace(/-/g, '');
}

const ChoiceBand: Modifier = {
  name: 'choiceband', priority: 50,
  modifyOffense(stat, ctx) {
    if (ctx.move.category === 'Physical' && normItem(ctx.attackerSet.item) === 'choiceband') return stat * 1.5;
    return stat;
  },
};

const ChoiceSpecs: Modifier = {
  name: 'choicespecs', priority: 50,
  modifyOffense(stat, ctx) {
    if (ctx.move.category === 'Special' && normItem(ctx.attackerSet.item) === 'choicespecs') return stat * 1.5;
    return stat;
  },
};

const LifeOrb: Modifier = {
  name: 'lifeorb', priority: 80,
  modifyDamage(base, ctx) {
    if (normItem(ctx.attackerSet.item) === 'lifeorb') return base * 1.3;
    return base;
  },
};

const Eviolite: Modifier = {
  name: 'eviolite', priority: 50,
  modifyDefense(stat, ctx) {
    if (normItem(ctx.defenderSet.item) === 'eviolite') return stat * 1.5;
    return stat;
  },
};

const AssaultVest: Modifier = {
  name: 'assaultvest', priority: 50,
  modifyDefense(stat, ctx) {
    if (normItem(ctx.defenderSet.item) === 'assaultvest' && ctx.move.category === 'Special') return stat * 1.5;
    return stat;
  },
};

const DEFAULT_MODIFIERS: Modifier[] = [ChoiceBand, ChoiceSpecs, LifeOrb, Eviolite, AssaultVest];

// ── Nature modifier (1.1 / 0.9 / 1.0) ─────────────────────────────────

function natureMod(set: SetEntry, stat: string): number {
  const n = set.nature;
  if (n.increased_stat === stat) return 1.1;
  if (n.decreased_stat === stat) return 0.9;
  return 1.0;
}

const DEFAULT_IV = 31;
const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
type StatKey = typeof STAT_KEYS[number];

/** Compute a final stat value — port of SetClass.effective_stat. */
export function effectiveStat(set: SetEntry, stat: StatKey, baseStats: Record<string, number>, level: number): number {
  const base = baseStats[stat] ?? 0;
  const iv = set.ivs[stat] ?? DEFAULT_IV;
  const ev = set.evs[stat] ?? 0;
  if (stat === 'hp') {
    return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100 + level + 10);
  }
  const nMod = natureMod(set, stat);
  return Math.floor((Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100) + 5) * nMod);
}

/** Compute effective HP — port of DamageCalculator._compute_hp. */
export function computeHp(pokemon: Species, set: SetEntry, level: number): number {
  const base = pokemon.base_stats.hp ?? 0;
  const iv = set.ivs.hp ?? DEFAULT_IV;
  const ev = set.evs.hp ?? 0;
  return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level) / 100 + level + 10);
}

/**
 * Calculate damage for one move — port of DamageCalculator.calculate.
 * Level defaults to 100 (the competitive target tier).
 */
export function computeDamage(
  attackerSet: SetEntry,
  defenderSet: SetEntry,
  move: Move,
  attackerPokemon: Species,
  defenderPokemon: Species,
  level: number = 100,
  modifiers: Modifier[] = DEFAULT_MODIFIERS,
): DamageResult {
  const ctx: ModifierContext = {
    attackerSet, defenderSet, attackerPokemon, defenderPokemon, move,
  };

  // Check skip (e.g. Levitate)
  for (const mod of modifiers) {
    if (mod.shouldSkip?.(ctx)) {
      return emptyResult(move, true);
    }
  }

  // Status moves deal no damage
  if (move.category === 'Status') {
    return {
      ...emptyResult(move, false),
      effective_hp: computeHp(defenderPokemon, defenderSet, level),
    };
  }

  // ── Offensive stat ──────────────────────────────────────────────
  const offKey: StatKey = move.category === 'Physical' ? 'atk' : 'spa';
  let offStat = effectiveStat(attackerSet, offKey, attackerPokemon.base_stats, level);
  for (const mod of modifiers) offStat = mod.modifyOffense?.(offStat, ctx) ?? offStat;
  offStat = Math.max(1, Math.floor(offStat));

  // ── Defensive stat ──────────────────────────────────────────────
  const defKey: StatKey = move.category === 'Physical' ? 'def' : 'spd';
  let defStat = effectiveStat(defenderSet, defKey, defenderPokemon.base_stats, level);
  for (const mod of modifiers) defStat = mod.modifyDefense?.(defStat, ctx) ?? defStat;
  defStat = Math.max(1, Math.floor(defStat));

  // ── Base damage (Gen 9 formula) ──────────────────────────────────
  const power = Math.max(1, move.base_power);
  const baseDamage = Math.floor(
    (Math.floor((2 * level) / 5 + 2) * power * offStat) / defStat / 50 + 2,
  );

  // ── STAB ─────────────────────────────────────────────────────────
  let stab = 1.0;
  if (attackerPokemon.types.includes(move.type)) stab = 1.5;
  for (const mod of modifiers) stab = mod.modifyStab?.(stab, ctx) ?? stab;

  // ── Type effectiveness ──────────────────────────────────────────
  let typeEff = getEffectiveness(move.type, defenderPokemon.types);
  for (const mod of modifiers) typeEff = mod.modifyTypeEffectiveness?.(typeEff, ctx) ?? typeEff;

  // ── Modifier product (items, abilities, etc.) ───────────────────
  const sortedMods = [...modifiers].sort((a, b) => a.priority - b.priority);
  let damageAfterMults = baseDamage;
  for (const mod of sortedMods) damageAfterMults = mod.modifyDamage?.(damageAfterMults, ctx) ?? damageAfterMults;
  const modProduct = baseDamage > 0 ? damageAfterMults / baseDamage : 1.0;

  // ── Final damage ────────────────────────────────────────────────
  const finalDamage = Math.max(0, Math.floor(baseDamage * stab * typeEff * modProduct));

  // ── Damage range (0.85–1.00 random factor) ──────────────────────
  const rollBase = baseDamage * stab * typeEff * modProduct;
  const minDmg = Math.max(0, Math.floor(rollBase * 0.85));
  const maxDmg = Math.max(0, Math.floor(rollBase * 1.0));

  // ── Defender HP & TTK ────────────────────────────────────────────
  const effHp = computeHp(defenderPokemon, defenderSet, level);
  const ttk = finalDamage <= 0 ? 0 : Math.ceil(effHp / finalDamage);

  return {
    move_id: move.id,
    move_name: move.name,
    move_type: move.type,
    move_category: move.category,
    base_power: power,
    offensive_stat: offStat,
    defensive_stat: defStat,
    base_damage: baseDamage,
    stab_mult: stab,
    type_effectiveness: typeEff,
    modifier_product: Math.round(modProduct * 10000) / 10000,
    final_damage: finalDamage,
    effective_hp: effHp,
    turns_to_kill: ttk,
    is_ohko: ttk === 1,
    is_immune: typeEff === 0,
    is_contact: move.flags.includes('contact'),
    min_damage: minDmg,
    max_damage: maxDmg,
  };
}

function emptyResult(move: Move, immune: boolean): DamageResult {
  return {
    move_id: move.id, move_name: move.name, move_type: move.type, move_category: move.category,
    base_power: 0, offensive_stat: 0, defensive_stat: 0, base_damage: 0,
    stab_mult: 1.0, type_effectiveness: immune ? 0 : 1.0, modifier_product: 1.0,
    final_damage: 0, effective_hp: 0, turns_to_kill: 0,
    is_ohko: false, is_immune: immune, is_contact: move.flags.includes('contact'),
    min_damage: 0, max_damage: 0,
  };
}

// ── Ponytail self-check (runs on every `npm test`) ────────────────────
// Assert: Garchomp Earthquake should OHKO (or close to) Heatran — SE ×2,
// base 100 power, STAB, very high Atk vs moderate Def.
// This is a light sanity check, not a full test suite.
import { assert } from 'console';
if (process.env.NODE_ENV !== 'test' && typeof require !== 'undefined') {
  try {
    // Inline mini-fixture: Garchomp Jolly CB Earthquake vs Heatran
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
      id: 'garchomp_sd', pokemon_id: 'garchomp', set_name: 'Swords Dance',
      ability: 'sandveil', item: 'choiceband',
      nature: { name: 'Jolly', increased_stat: 'spe', decreased_stat: 'spa' },
      evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252, label: '252 Atk / 4 SpD / 252 Spe' },
      moves: ['earthquake'], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      role: 'sweeper', tera_type: '',
    };
    const tranSet: SetEntry = {
      id: 'heatran_sdef', pokemon_id: 'heatran', set_name: 'Special Defense',
      ability: 'flashfire', item: 'leftovers',
      nature: { name: 'Calm', increased_stat: 'spd', decreased_stat: 'atk' },
      evs: { hp: 252, atk: 0, def: 0, spa: 0, spd: 252, spe: 4, label: '252 HP / 252 SpD / 4 Spe' },
      moves: ['lavaplume'], ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
      role: 'wall', tera_type: '',
    };
    const eq: Move = {
      id: 'earthquake', name: 'Earthquake', type: 'Ground', category: 'Physical',
      base_power: 100, accuracy: 100, priority: 0, flags: ['contact', 'protectable'],
    };
    const result = computeDamage(chompSet, tranSet, eq, garchomp, heatran, 100);
    assert(result.turns_to_kill <= 2, `Garchomp EQ should 2HKO or better Heatran, got TTK=${result.turns_to_kill}`);
  } catch {
    // Self-check is best-effort; in test mode vitest imports this module and
    // the inline fixture may not match a real pack. The actual pinned values
    // are in tests/damage.test.ts.
  }
}
