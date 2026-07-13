import {
  computeDamage,
  computeHp,
  effectiveStat,
  type BattleModifiers,
} from '@pokeredus/calc';
import type { Move, SetEntry, Species } from '@pokeredus/pack';
import type { KnowledgeGraph } from '../kg/knowledge-graph.js';
import type { SetClass } from '../classes/sets.js';
import type { MoveClass } from '../classes/moves.js';
import type { AttributeManager } from '../attributes/manager.js';
import type { AttributeDefinition } from '../attributes/manager.js';

/** The 16 discrete damage rolls in Pokémon (0.85 to 1.0). */
export const DAMAGE_ROLLS = [
  0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92,
  0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1.00,
] as const;

export interface SpeciesProfile {
  pokemon_id: string;
  pokemon_name: string;
  max_hp: number;
  best_atk: number;
  best_def: number;
  best_spa: number;
  best_spd: number;
  best_spe: number;
  hp_set_id: string;
  atk_set_id: string;
  def_set_id: string;
  spa_set_id: string;
  spd_set_id: string;
  spe_set_id: string;
  all_move_ids: string[];
  items: string[];
  abilities: string[];
  primary_set_id: string;
}

export interface MoveEvaluation {
  move_id: string;
  move_name: string;
  move_type: string;
  move_category: string;
  base_power: number;
  priority: number;
  min_damage: number;
  max_damage: number;
  avg_damage: number;
  min_ttk: number;
  max_ttk: number;
  avg_ttk: number;
  type_effectiveness: number;
  stab: boolean;
  is_immune: boolean;
  weight: number;
}

export interface SpeciesMatchupResult {
  our_id: string;
  their_id: string;
  our_name: string;
  their_name: string;
  our_moves: MoveEvaluation[];
  their_moves: MoveEvaluation[];
  our_effective_ttk: number;
  their_effective_ttk: number;
  our_best_move: string;
  their_best_move: string;
  our_best_damage: number;
  their_best_damage: number;
  our_best_damage_max: number;
  their_best_damage_max: number;
  our_speed: number;
  their_speed: number;
  speed_advantage: 'us' | 'them' | 'tie';
  our_hp: number;
  their_hp: number;
  score: number;
  category: string;
  eval_text: string;
}

export type BattleOutcome = SpeciesMatchupResult;

interface AttributeMods {
  damage_mult: number;
  physical_mult: number;
  special_mult: number;
  speed_mult: number;
  defense_mult: number;
  spdef_mult: number;
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

export function buildSpeciesProfile(
  pokemonId: string,
  kg: KnowledgeGraph,
  level = 100,
): SpeciesProfile {
  const pokemon = kg.getPokemon(pokemonId);
  const emptyProfile = (): SpeciesProfile => ({
    pokemon_id: pokemonId,
    pokemon_name: pokemonId,
    max_hp: 0, best_atk: 0, best_def: 0, best_spa: 0, best_spd: 0, best_spe: 0,
    hp_set_id: '', atk_set_id: '', def_set_id: '', spa_set_id: '', spd_set_id: '', spe_set_id: '',
    all_move_ids: [], items: [], abilities: [], primary_set_id: '',
  });

  if (!pokemon) return emptyProfile();

  const sets = kg.getSets(pokemonId);
  if (!sets.length) {
    return {
      pokemon_id: pokemonId,
      pokemon_name: pokemon.name,
      max_hp: 0, best_atk: 0, best_def: 0, best_spa: 0, best_spd: 0, best_spe: 0,
      hp_set_id: '', atk_set_id: '', def_set_id: '', spa_set_id: '', spd_set_id: '', spe_set_id: '',
      all_move_ids: [], items: [], abilities: [], primary_set_id: '',
    };
  }

  const profile: SpeciesProfile = {
    pokemon_id: pokemonId,
    pokemon_name: pokemon.name,
    max_hp: 0, best_atk: 0, best_def: 0, best_spa: 0, best_spd: 0, best_spe: 0,
    hp_set_id: '', atk_set_id: '', def_set_id: '', spa_set_id: '', spd_set_id: '', spe_set_id: '',
    all_move_ids: [], items: [], abilities: [],
    primary_set_id: pokemon.primary_set_id || sets[0]!.id,
  };

  const itemsSeen = new Set<string>();
  const abilitiesSeen = new Set<string>();
  const movesSeen = new Set<string>();
  const moveList: string[] = [];

  for (const s of sets) {
    if (s.item) itemsSeen.add(s.item);
    if (s.ability) abilitiesSeen.add(s.ability);
    for (const mid of s.moves) {
      if (!movesSeen.has(mid)) {
        movesSeen.add(mid);
        moveList.push(mid);
      }
    }
  }
  profile.items = [...itemsSeen].sort();
  profile.abilities = [...abilitiesSeen].sort();
  profile.all_move_ids = moveList;

  const best: Record<string, [number, string]> = {
    hp: [0, ''], atk: [0, ''], def: [0, ''], spa: [0, ''], spd: [0, ''], spe: [0, ''],
  };
  for (const s of sets) {
    for (const stat of Object.keys(best) as Array<keyof typeof best>) {
      const val = s.effectiveStat(stat, pokemon.base_stats, level);
      if (val > best[stat]![0]) best[stat] = [val, s.id];
    }
  }

  profile.max_hp = best.hp![0];
  profile.best_atk = best.atk![0];
  profile.best_def = best.def![0];
  profile.best_spa = best.spa![0];
  profile.best_spd = best.spd![0];
  profile.best_spe = best.spe![0];
  profile.hp_set_id = best.hp![1];
  profile.atk_set_id = best.atk![1];
  profile.def_set_id = best.def![1];
  profile.spa_set_id = best.spa![1];
  profile.spd_set_id = best.spd![1];
  profile.spe_set_id = best.spe![1];

  return profile;
}

function defaultMods(): AttributeMods {
  return {
    damage_mult: 1, physical_mult: 1, special_mult: 1,
    speed_mult: 1, defense_mult: 1, spdef_mult: 1,
  };
}

function applyAttribute(attr: AttributeDefinition, mods: AttributeMods): void {
  const params = attr.params;
  if (!params || !Object.keys(params).length) return;

  if (attr.type === 'damage_mod') {
    const mult = Number(params.multiplier ?? 1);
    const appliesTo = String(params.applies_to ?? 'all');
    const target = String(params.target ?? 'attacker');
    if (target === 'defender') {
      if (appliesTo === 'all') mods.defense_mult *= mult > 1 ? 1 / mult : mult;
      else if (appliesTo === 'special') mods.spdef_mult *= mult > 1 ? 1 / mult : mult;
    } else {
      if (appliesTo === 'all') mods.damage_mult *= mult;
      else if (appliesTo === 'physical') mods.physical_mult *= mult;
      else if (appliesTo === 'special') mods.special_mult *= mult;
    }
  } else if (attr.type === 'speed_mod') {
    const mult = Number(params.multiplier ?? 1);
    const condition = String(params.condition ?? '');
    if (!condition) mods.speed_mult *= mult;
  } else if (attr.type === 'stat_mod') {
    const stat = String(params.stat ?? '');
    const stages = Number(params.stages ?? 0);
    const mult = stages >= 0 ? (2 + stages) / 2 : 2 / (2 - stages);
    const target = String(params.target ?? 'self');
    if (target === 'self') {
      if (stat === 'atk') mods.physical_mult *= mult;
      else if (stat === 'spa') mods.special_mult *= mult;
      else if (stat === 'spe') mods.speed_mult *= mult;
    }
  }
}

export class BattleSimulator {
  readonly level: number;
  private readonly profileCache = new Map<string, SpeciesProfile>();

  constructor(
    readonly kg: KnowledgeGraph,
    readonly attributeManager: AttributeManager | null = null,
    level = 100,
  ) {
    this.level = level;
  }

  getProfile(pokemonId: string): SpeciesProfile {
    let profile = this.profileCache.get(pokemonId);
    if (!profile) {
      profile = buildSpeciesProfile(pokemonId, this.kg, this.level);
      this.profileCache.set(pokemonId, profile);
    }
    return profile;
  }

  clearCache(): void {
    this.profileCache.clear();
  }

  getAttributeModifiers(profile: SpeciesProfile): AttributeMods {
    const mods = defaultMods();
    if (!this.attributeManager) return mods;

    for (const itemId of profile.items) {
      for (const attr of this.attributeManager.getItemAttributes(itemId)) {
        applyAttribute(attr, mods);
      }
    }
    for (const abilityId of profile.abilities) {
      for (const attr of this.attributeManager.getAbilityAttributes(abilityId)) {
        applyAttribute(attr, mods);
      }
    }
    return mods;
  }

  evaluateMove(
    moveId: string,
    attackerProfile: SpeciesProfile,
    defenderProfile: SpeciesProfile,
    attackerMods: AttributeMods,
    defenderMods: AttributeMods,
    fieldMods: BattleModifiers = {},
  ): MoveEvaluation | null {
    const move = this.kg.getMove(moveId);
    if (!move || move.is_status) return null;

    const atkSetId = move.is_physical ? attackerProfile.atk_set_id : attackerProfile.spa_set_id;
    const defSetId = move.is_physical ? defenderProfile.def_set_id : defenderProfile.spd_set_id;
    const attackerSet = this.kg.getSet(atkSetId || attackerProfile.primary_set_id);
    const defenderSet = this.kg.getSet(defSetId || defenderProfile.primary_set_id);
    if (!attackerSet || !defenderSet) return null;

    const atkSp = toPackSpecies(this.kg, attackerProfile.pokemon_id);
    const defSp = toPackSpecies(this.kg, defenderProfile.pokemon_id);
    if (!atkSp || !defSp) return null;

    const result = computeDamage(
      toPackSet(attackerSet), toPackSet(defenderSet), toPackMove(move),
      atkSp, defSp, this.level, fieldMods,
    );

    if (result.is_immune || result.type_effectiveness === 0) {
      return {
        move_id: moveId, move_name: move.name, move_type: move.type,
        move_category: move.category, base_power: move.base_power, priority: move.priority,
        min_damage: 0, max_damage: 0, avg_damage: 0,
        min_ttk: 0, max_ttk: 0, avg_ttk: 0,
        type_effectiveness: 0, stab: false, is_immune: true, weight: 0,
      };
    }

    // ponytail: scale calc output by attribute mults (approximate profile-optimal stats)
    const offMult = move.is_physical ? attackerMods.physical_mult * attackerMods.damage_mult
      : attackerMods.special_mult * attackerMods.damage_mult;
    const defMult = move.is_physical ? defenderMods.defense_mult : defenderMods.spdef_mult;
    const scale = offMult / Math.max(defMult, 0.01);

    const minDmg = Math.max(1, Math.floor(result.min_damage * scale));
    const maxDmg = Math.max(1, Math.floor(result.max_damage * scale));
    const avgDmg = (minDmg + maxDmg) / 2;
    const defHp = defenderProfile.max_hp || result.effective_hp;

    const minTtk = maxDmg > 0 ? Math.ceil(defHp / maxDmg) : 0;
    const maxTtk = minDmg > 0 ? Math.ceil(defHp / minDmg) : 0;
    const avgTtk = avgDmg > 0 ? defHp / avgDmg : 0;

    return {
      move_id: moveId, move_name: move.name, move_type: move.type,
      move_category: move.category, base_power: move.base_power, priority: move.priority,
      min_damage: minDmg, max_damage: maxDmg, avg_damage: avgDmg,
      min_ttk: minTtk, max_ttk: maxTtk, avg_ttk: avgTtk,
      type_effectiveness: result.type_effectiveness,
      stab: result.stab_mult > 1, is_immune: false, weight: 0,
    };
  }

  private computeMoveWeights(moves: MoveEvaluation[]): MoveEvaluation[] {
    const viable = moves.filter((m) => !m.is_immune && m.avg_ttk > 0);
    if (!viable.length) {
      for (const m of moves) m.weight = 0;
      return moves;
    }

    let bestInvTtk = 0;
    for (const m of viable) {
      const inv = 1 / m.avg_ttk;
      if (inv > bestInvTtk) bestInvTtk = inv;
    }

    for (const m of moves) {
      if (m.is_immune || m.avg_ttk <= 0) m.weight = 0;
      else if (bestInvTtk > 0) m.weight = (1 / m.avg_ttk) / bestInvTtk;
      else m.weight = 0;
    }
    return moves;
  }

  simulate(ourProfile: SpeciesProfile, theirProfile: SpeciesProfile): SpeciesMatchupResult {
    const result: SpeciesMatchupResult = {
      our_id: ourProfile.pokemon_id, their_id: theirProfile.pokemon_id,
      our_name: ourProfile.pokemon_name, their_name: theirProfile.pokemon_name,
      our_moves: [], their_moves: [],
      our_effective_ttk: 0, their_effective_ttk: 0,
      our_best_move: '', their_best_move: '',
      our_best_damage: 0, their_best_damage: 0,
      our_best_damage_max: 0, their_best_damage_max: 0,
      our_speed: 0, their_speed: 0, speed_advantage: 'tie',
      our_hp: ourProfile.max_hp, their_hp: theirProfile.max_hp,
      score: 0, category: 'neutral', eval_text: '',
    };

    const ourMods = this.getAttributeModifiers(ourProfile);
    const theirMods = this.getAttributeModifiers(theirProfile);

    const ourEvals: MoveEvaluation[] = [];
    for (const mid of ourProfile.all_move_ids) {
      const ev = this.evaluateMove(mid, ourProfile, theirProfile, ourMods, theirMods);
      if (ev) ourEvals.push(ev);
    }
    const theirEvals: MoveEvaluation[] = [];
    for (const mid of theirProfile.all_move_ids) {
      const ev = this.evaluateMove(mid, theirProfile, ourProfile, theirMods, ourMods);
      if (ev) theirEvals.push(ev);
    }

    result.our_moves = this.computeMoveWeights(ourEvals);
    result.their_moves = this.computeMoveWeights(theirEvals);
    result.our_effective_ttk = this.weightedTtk(result.our_moves);
    result.their_effective_ttk = this.weightedTtk(result.their_moves);

    const ourViable = result.our_moves.filter((m) => !m.is_immune && m.avg_ttk > 0);
    const theirViable = result.their_moves.filter((m) => !m.is_immune && m.avg_ttk > 0);

    if (ourViable.length) {
      const best = ourViable.reduce((a, b) => (a.avg_ttk <= b.avg_ttk ? a : b));
      result.our_best_move = best.move_name;
      result.our_best_damage = best.min_damage;
      result.our_best_damage_max = best.max_damage;
    } else {
      result.our_best_move = 'None';
    }

    if (theirViable.length) {
      const best = theirViable.reduce((a, b) => (a.avg_ttk <= b.avg_ttk ? a : b));
      result.their_best_move = best.move_name;
      result.their_best_damage = best.min_damage;
      result.their_best_damage_max = best.max_damage;
    } else {
      result.their_best_move = 'None';
    }

    result.our_speed = Math.floor(ourProfile.best_spe * ourMods.speed_mult);
    result.their_speed = Math.floor(theirProfile.best_spe * theirMods.speed_mult);
    if (result.our_speed > result.their_speed) result.speed_advantage = 'us';
    else if (result.their_speed > result.our_speed) result.speed_advantage = 'them';

    result.score = this.computeScore(result);
    result.category = this.categorize(result.score);
    result.eval_text = this.generateEvalText(result);
    return result;
  }

  simulateById(ourPokemonId: string, theirPokemonId: string): SpeciesMatchupResult {
    return this.simulate(this.getProfile(ourPokemonId), this.getProfile(theirPokemonId));
  }

  private weightedTtk(moves: MoveEvaluation[]): number {
    const viable = moves.filter((m) => !m.is_immune && m.avg_ttk > 0 && m.weight > 0);
    if (!viable.length) return 0;
    const totalWeight = viable.reduce((s, m) => s + m.weight, 0);
    if (totalWeight <= 0) return 0;
    return viable.reduce((s, m) => s + m.avg_ttk * m.weight, 0) / totalWeight;
  }

  private computeScore(result: SpeciesMatchupResult): number {
    const ourTtk = result.our_effective_ttk;
    const theirTtk = result.their_effective_ttk;

    if (ourTtk <= 0 && theirTtk <= 0) return 0;
    if (ourTtk <= 0 && theirTtk > 0) return -1;
    if (ourTtk > 0 && theirTtk <= 0) return 1;

    const ttkDiff = theirTtk - ourTtk;
    let score = Math.tanh(ttkDiff / 2.5);

    if (Math.abs(ttkDiff) < 1.5) {
      if (result.speed_advantage === 'us') score += 0.12;
      else if (result.speed_advantage === 'them') score -= 0.12;
    }

    const ourViable = result.our_moves.filter((m) => !m.is_immune && m.avg_ttk > 0).length;
    const theirViable = result.their_moves.filter((m) => !m.is_immune && m.avg_ttk > 0).length;
    if (ourViable > theirViable + 1) score += 0.05;
    else if (theirViable > ourViable + 1) score -= 0.05;

    const ourPriority = result.our_moves.some((m) => !m.is_immune && m.priority > 0);
    const theirPriority = result.their_moves.some((m) => !m.is_immune && m.priority > 0);
    if (ourPriority && !theirPriority) score += 0.08;
    else if (theirPriority && !ourPriority) score -= 0.08;

    return Math.max(-1, Math.min(1, score));
  }

  private categorize(score: number): string {
    if (score >= 0.6) return 'counter';
    if (score >= 0.2) return 'check';
    if (score >= -0.2) return 'neutral';
    if (score >= -0.6) return 'checked_by';
    return 'countered_by';
  }

  private generateEvalText(result: SpeciesMatchupResult): string {
    const parts: string[] = [];
    parts.push(result.our_effective_ttk > 0
      ? `~${result.our_effective_ttk.toFixed(1)} turns to KO them`
      : 'Cannot KO them');
    parts.push(result.their_effective_ttk > 0
      ? `~${result.their_effective_ttk.toFixed(1)} turns to KO us`
      : 'They cannot KO us');

    const ourViable = result.our_moves.filter((m) => !m.is_immune && m.avg_ttk > 0);
    if (ourViable.length) {
      const best = ourViable.reduce((a, b) => (a.avg_ttk <= b.avg_ttk ? a : b));
      const pctLo = result.their_hp > 0 ? (best.min_damage / result.their_hp) * 100 : 0;
      const pctHi = result.their_hp > 0 ? (best.max_damage / result.their_hp) * 100 : 0;
      parts.push(`Best: ${best.move_name} (${pctLo.toFixed(0)}-${pctHi.toFixed(0)}%)`);
    }

    if (result.speed_advantage === 'us') {
      parts.push(`Faster (${result.our_speed} vs ${result.their_speed})`);
    } else if (result.speed_advantage === 'them') {
      parts.push(`Slower (${result.our_speed} vs ${result.their_speed})`);
    }

    if (ourViable.length > 1) parts.push(`${ourViable.length} viable moves`);
    return parts.join(' | ');
  }
}

/** Compute HP for a set at level using @pokeredus/calc. */
export function profileHp(kg: KnowledgeGraph, setId: string, level = 100): number {
  const set = kg.getSet(setId);
  if (!set) return 0;
  const sp = toPackSpecies(kg, set.pokemon_id);
  if (!sp) return 0;
  return computeHp(sp, toPackSet(set), level);
}

/** Best speed stat across sets for a species. */
export function profileSpeed(kg: KnowledgeGraph, profile: SpeciesProfile, level = 100): number {
  const set = kg.getSet(profile.spe_set_id || profile.primary_set_id);
  const sp = toPackSpecies(kg, profile.pokemon_id);
  if (!set || !sp) return profile.best_spe;
  return effectiveStat(toPackSet(set), 'spe', sp, level);
}
