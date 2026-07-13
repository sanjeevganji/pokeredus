// @pokeredus/calc — sole adapter over @smogon/calc for Gen 9 damage physics.
import {
  calculate,
  Pokemon,
  Move as SmogonMove,
  Field,
  Generations,
  TYPE_CHART,
} from '@smogon/calc';
import type { SetEntry, Move, Species } from '@pokeredus/pack';

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

export interface BattleModifiers {
  weather?: '' | 'sunny' | 'rain' | 'sandstorm' | 'snow';
  terrain?: '' | 'electric' | 'grassy' | 'psychic' | 'misty';
  attackerBoosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  defenderBoosts?: Partial<Record<'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  attackerStatus?: string;
  defenderStatus?: string;
  reflect?: boolean;
  lightScreen?: boolean;
}

const GEN = Generations.get(9);
const OFFENSE_CHART = TYPE_CHART[9] as Record<string, Record<string, number>>;

type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';

function titleCaseId(id: string): string {
  if (!id) return '';
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export function getTypeEffectiveness(moveType: string, defTypes: string[]): number {
  let mult = 1;
  for (const dt of defTypes) {
    mult *= OFFENSE_CHART[moveType]?.[dt] ?? 1;
  }
  return mult;
}

function stabMult(attackerTypes: string[], moveType: string): number {
  return attackerTypes.includes(moveType) ? 1.5 : 1;
}

/** Build @smogon/calc Pokemon from pack types. */
export function toPokemon(
  species: Species,
  set: SetEntry,
  level = 100,
  boosts?: Partial<Record<StatKey, number>>,
  status = '',
): Pokemon {
  return new Pokemon(GEN, species.name, {
    level,
    ability: titleCaseId(set.ability) || set.ability,
    item: titleCaseId(set.item) || set.item,
    nature: set.nature.name,
    evs: {
      hp: set.evs.hp,
      atk: set.evs.atk,
      def: set.evs.def,
      spa: set.evs.spa,
      spd: set.evs.spd,
      spe: set.evs.spe,
    },
    ivs: { ...set.ivs },
    teraType: (set.tera_type ? titleCaseId(set.tera_type) : undefined) as never,
    boosts: boosts ?? {},
    status: (status || undefined) as never,
  });
}

export function toSmogonMove(move: Move): SmogonMove {
  return new SmogonMove(GEN, move.name);
}

export function toField(mods: BattleModifiers = {}): Field {
  const weatherMap = {
    sunny: 'Sun',
    rain: 'Rain',
    sandstorm: 'Sand',
    snow: 'Snow',
  } as const;
  const terrainMap = {
    electric: 'Electric',
    grassy: 'Grassy',
    psychic: 'Psychic',
    misty: 'Misty',
  } as const;
  const field = new Field({
    weather: mods.weather ? weatherMap[mods.weather] : undefined,
    terrain: mods.terrain ? terrainMap[mods.terrain] : undefined,
  });
  if (mods.reflect) field.defenderSide.isReflect = true;
  if (mods.lightScreen) field.defenderSide.isLightScreen = true;
  return field;
}

export function effectiveStat(
  set: SetEntry,
  stat: StatKey,
  species: Species,
  level: number,
): number {
  return toPokemon(species, set, level).stats[stat] ?? 0;
}

export function computeHp(pokemon: Species, set: SetEntry, level: number): number {
  return toPokemon(pokemon, set, level).maxHP();
}

function emptyResult(move: Move, immune: boolean): DamageResult {
  return {
    move_id: move.id,
    move_name: move.name,
    move_type: move.type,
    move_category: move.category,
    base_power: 0,
    offensive_stat: 0,
    defensive_stat: 0,
    base_damage: 0,
    stab_mult: 1.0,
    type_effectiveness: immune ? 0 : 1.0,
    modifier_product: 1.0,
    final_damage: 0,
    effective_hp: 0,
    turns_to_kill: 0,
    is_ohko: false,
    is_immune: immune,
    is_contact: move.flags.includes('contact'),
    min_damage: 0,
    max_damage: 0,
  };
}

function flattenDamage(damage: number | number[] | number[][]): number[] {
  if (typeof damage === 'number') return [damage];
  if (Array.isArray(damage) && typeof damage[0] === 'number') return damage as number[];
  if (Array.isArray(damage) && Array.isArray(damage[0])) {
    return (damage as number[][]).flat();
  }
  return [];
}

/** Calculate damage via @smogon/calc — maps Result into DamageResult contract. */
export function computeDamage(
  attackerSet: SetEntry,
  defenderSet: SetEntry,
  move: Move,
  attackerPokemon: Species,
  defenderPokemon: Species,
  level = 100,
  mods: BattleModifiers = {},
): DamageResult {
  if (move.category === 'Status') {
    return {
      ...emptyResult(move, false),
      effective_hp: computeHp(defenderPokemon, defenderSet, level),
    };
  }

  const typeEff = getTypeEffectiveness(move.type, defenderPokemon.types);
  if (typeEff === 0) {
    return { ...emptyResult(move, true), effective_hp: 0 };
  }

  const attacker = toPokemon(
    attackerPokemon,
    attackerSet,
    level,
    mods.attackerBoosts,
    mods.attackerStatus ?? '',
  );
  const defender = toPokemon(
    defenderPokemon,
    defenderSet,
    level,
    mods.defenderBoosts,
    mods.defenderStatus ?? '',
  );
  const smogonMove = toSmogonMove(move);
  const field = toField(mods);
  const result = calculate(GEN, attacker, defender, smogonMove, field);

  const [minDmg, maxDmg] = result.range();
  const finalDamage = maxDmg;
  const effHp = defender.maxHP();
  const ttk = finalDamage <= 0 ? 0 : Math.ceil(effHp / finalDamage);
  const stab = stabMult(attackerPokemon.types, move.type);

  const offKey = move.category === 'Physical' ? 'atk' : 'spa';
  const defKey = move.category === 'Physical' ? 'def' : 'spd';

  // modifier_product: ratio of item-boosted max vs same spread without item
  let modProduct = 1;
  if (attackerSet.item && attackerSet.item !== 'leftovers') {
    const noItemSet = { ...attackerSet, item: '' };
    const noItemAtk = toPokemon(attackerPokemon, noItemSet, level, mods.attackerBoosts);
    const noItemResult = calculate(GEN, noItemAtk, defender, smogonMove, field);
    const [, noItemMax] = noItemResult.range();
    if (noItemMax > 0) modProduct = maxDmg / noItemMax;
  }

  return {
    move_id: move.id,
    move_name: move.name,
    move_type: move.type,
    move_category: move.category,
    base_power: Math.max(1, move.base_power),
    offensive_stat: attacker.stats[offKey] ?? 0,
    defensive_stat: defender.stats[defKey] ?? 0,
    base_damage: maxDmg,
    stab_mult: stab,
    type_effectiveness: typeEff,
    modifier_product: Math.round(modProduct * 10000) / 10000,
    final_damage: finalDamage,
    effective_hp: effHp,
    turns_to_kill: ttk,
    is_ohko: ttk === 1,
    is_immune: maxDmg === 0 && typeEff === 0,
    is_contact: move.flags.includes('contact'),
    min_damage: minDmg,
    max_damage: maxDmg,
  };
}

export { GEN as GEN9, getTypeEffectiveness as calcTypeEffectiveness };
