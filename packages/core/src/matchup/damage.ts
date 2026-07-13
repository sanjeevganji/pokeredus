import {
  computeDamage,
  computeHp,
  effectiveStat,
  type DamageResult,
} from '@pokeredus/calc';
import type { Move, SetEntry, Species } from '@pokeredus/pack';
import type { KnowledgeGraph } from '../kg/knowledge-graph.js';
import type { SetClass } from '../classes/sets.js';
import type { MoveClass } from '../classes/moves.js';

export interface EnrichedDamageResult extends DamageResult {
  min_turns_to_kill: number;
  max_turns_to_kill: number;
  min_damage_percent: number;
  max_damage_percent: number;
}

function enrich(result: DamageResult): EnrichedDamageResult {
  const effHp = result.effective_hp;
  const minTtk = result.max_damage > 0 ? Math.ceil(effHp / result.max_damage) : 0;
  const maxTtk = result.min_damage > 0 ? Math.ceil(effHp / result.min_damage) : minTtk;
  return {
    ...result,
    min_turns_to_kill: minTtk,
    max_turns_to_kill: maxTtk,
    min_damage_percent: effHp > 0 ? (result.min_damage / effHp) * 100 : 0,
    max_damage_percent: effHp > 0 ? (result.max_damage / effHp) * 100 : 0,
  };
}

function toPackSet(set: SetClass): SetEntry {
  return {
    id: set.id,
    pokemon_id: set.pokemon_id,
    set_name: set.set_name,
    ability: set.ability,
    item: set.item,
    nature: {
      name: set.nature.name,
      increased_stat: set.nature.increased_stat,
      decreased_stat: set.nature.decreased_stat,
    },
    evs: set.evs.asDict() as unknown as SetEntry['evs'],
    moves: [...set.moves],
    ivs: set.ivs as SetEntry['ivs'],
    role: set.role,
    tera_type: set.tera_type,
  };
}

function toPackSpecies(kg: KnowledgeGraph, pokemonId: string): Species | undefined {
  const p = kg.getPokemon(pokemonId);
  if (!p) return undefined;
  return {
    id: p.id,
    name: p.name,
    types: p.types,
    base_stats: p.base_stats,
    abilities: p.abilities,
    weight: p.weight,
    tier: p.tier,
    is_mega: p.is_mega,
    is_paradox: p.is_paradox,
    is_legendary: p.is_legendary,
    is_pseudo: p.is_pseudo,
    api_name: p.api_name,
    primary_set_id: p.primary_set_id,
  };
}

function toPackMove(move: MoveClass): Move {
  return {
    id: move.id,
    name: move.name,
    type: move.type,
    category: move.category as Move['category'],
    base_power: move.base_power,
    accuracy: move.accuracy as Move['accuracy'],
    priority: move.priority,
    pp: move.pp,
    target: move.target,
    flags: move.flags,
    secondary_effects: move.secondary_effects,
  };
}

export function calcDamage(
  attackerSet: SetClass,
  defenderSet: SetClass,
  move: MoveClass,
  kg: KnowledgeGraph,
  level = 100,
): EnrichedDamageResult {
  const atkSp = toPackSpecies(kg, attackerSet.pokemon_id);
  const defSp = toPackSpecies(kg, defenderSet.pokemon_id);
  if (!atkSp || !defSp) {
    return enrich({
      move_id: move.id, move_name: move.name, move_type: move.type,
      move_category: move.category, base_power: 0, offensive_stat: 0,
      defensive_stat: 0, base_damage: 0, stab_mult: 1, type_effectiveness: 0,
      modifier_product: 1, final_damage: 0, effective_hp: 0, turns_to_kill: 0,
      is_ohko: false, is_immune: true, is_contact: move.is_contact,
      min_damage: 0, max_damage: 0,
    });
  }
  return enrich(computeDamage(
    toPackSet(attackerSet), toPackSet(defenderSet), toPackMove(move),
    atkSp, defSp, level,
  ));
}

export function bestMove(
  attackerSet: SetClass,
  defenderSet: SetClass,
  kg: KnowledgeGraph,
  level = 100,
): EnrichedDamageResult | null {
  let best: EnrichedDamageResult | null = null;
  for (const moveId of attackerSet.moves) {
    const move = kg.getMove(moveId);
    if (!move || move.is_status) continue;
    const result = calcDamage(attackerSet, defenderSet, move, kg, level);
    if (result.is_immune || result.final_damage <= 0) continue;
    if (!best || result.turns_to_kill < best.turns_to_kill
      || (result.turns_to_kill === best.turns_to_kill && result.final_damage > best.final_damage)) {
      best = result;
    }
  }
  return best;
}

export function turnsToKill(
  attackerSet: SetClass,
  defenderSet: SetClass,
  kg: KnowledgeGraph,
  level = 100,
): [number, EnrichedDamageResult | null] {
  const result = bestMove(attackerSet, defenderSet, kg, level);
  return result ? [result.turns_to_kill, result] : [0, null];
}

export interface FullMatchupResult {
  ttk_a_to_b: number;
  ttk_b_to_a: number;
  speed_a: number;
  speed_b: number;
  speed_advantage: 'a' | 'b' | 'tie';
  best_move_a: EnrichedDamageResult | null;
  best_move_b: EnrichedDamageResult | null;
  hp_a: number;
  hp_b: number;
  damage_a_to_b: number;
  damage_b_to_a: number;
  best_move_a_id: string;
  best_move_b_id: string;
  min_damage_a_to_b: number;
  max_damage_a_to_b: number;
  min_damage_b_to_a: number;
  max_damage_b_to_a: number;
  min_ttk_a_to_b: number;
  max_ttk_a_to_b: number;
  min_ttk_b_to_a: number;
  max_ttk_b_to_a: number;
  damage_pct_a_to_b_lo: number;
  damage_pct_a_to_b_hi: number;
  damage_pct_b_to_a_lo: number;
  damage_pct_b_to_a_hi: number;
}

export function fullMatchup(
  setA: SetClass,
  setB: SetClass,
  kg: KnowledgeGraph,
  level = 100,
): FullMatchupResult {
  const [ttkAb, resultAb] = turnsToKill(setA, setB, kg, level);
  const [ttkBa, resultBa] = turnsToKill(setB, setA, kg, level);

  const pa = kg.getPokemon(setA.pokemon_id);
  const pb = kg.getPokemon(setB.pokemon_id);
  const packA = pa ? toPackSpecies(kg, setA.pokemon_id) : undefined;
  const packB = pb ? toPackSpecies(kg, setB.pokemon_id) : undefined;

  const speedA = packA ? effectiveStat(toPackSet(setA), 'spe', packA, level) : 0;
  const speedB = packB ? effectiveStat(toPackSet(setB), 'spe', packB, level) : 0;

  let speedAdv: 'a' | 'b' | 'tie' = 'tie';
  if (speedA > speedB) speedAdv = 'a';
  else if (speedB > speedA) speedAdv = 'b';

  const hpA = packA ? computeHp(packA, toPackSet(setA), level) : 0;
  const hpB = packB ? computeHp(packB, toPackSet(setB), level) : 0;

  return {
    ttk_a_to_b: ttkAb,
    ttk_b_to_a: ttkBa,
    speed_a: speedA,
    speed_b: speedB,
    speed_advantage: speedAdv,
    best_move_a: resultAb,
    best_move_b: resultBa,
    hp_a: hpA,
    hp_b: hpB,
    damage_a_to_b: resultAb?.final_damage ?? 0,
    damage_b_to_a: resultBa?.final_damage ?? 0,
    best_move_a_id: resultAb?.move_id ?? '',
    best_move_b_id: resultBa?.move_id ?? '',
    min_damage_a_to_b: resultAb?.min_damage ?? 0,
    max_damage_a_to_b: resultAb?.max_damage ?? 0,
    min_damage_b_to_a: resultBa?.min_damage ?? 0,
    max_damage_b_to_a: resultBa?.max_damage ?? 0,
    min_ttk_a_to_b: resultAb?.min_turns_to_kill ?? 0,
    max_ttk_a_to_b: resultAb?.max_turns_to_kill ?? 0,
    min_ttk_b_to_a: resultBa?.min_turns_to_kill ?? 0,
    max_ttk_b_to_a: resultBa?.max_turns_to_kill ?? 0,
    damage_pct_a_to_b_lo: resultAb?.min_damage_percent ?? 0,
    damage_pct_a_to_b_hi: resultAb?.max_damage_percent ?? 0,
    damage_pct_b_to_a_lo: resultBa?.min_damage_percent ?? 0,
    damage_pct_b_to_a_hi: resultBa?.max_damage_percent ?? 0,
  };
}
