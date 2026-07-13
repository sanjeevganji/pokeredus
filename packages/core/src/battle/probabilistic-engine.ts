import { computeDamage, computeHp, type BattleModifiers } from '@pokeredus/calc';
import type { Move, SetEntry, Species } from '@pokeredus/pack';
import type { KnowledgeGraph } from '../kg/knowledge-graph.js';
import type { SetClass } from '../classes/sets.js';
import { FieldAttribute } from '../classes/attributes.js';
import { GameState, PokemonState } from './game-state.js';
import { BattleSimulator } from './simulator.js';

export interface SimAction {
  action_type: 'move' | 'switch';
  target_id: string;
  source_side: 'a' | 'b';
}

export interface RolloutResult {
  winner: 'a' | 'b' | 'draw';
  turns: number;
  final_hp_a: Record<string, number>;
  final_hp_b: Record<string, number>;
  action_log: string[];
}

export interface ActionStats {
  action: SimAction;
  wins: number;
  losses: number;
  draws: number;
  total_rollouts: number;
  avg_turns: number;
  win_rate: number;
}

export interface StateEvaluation {
  win_probability: number;
  draw_probability: number;
  loss_probability: number;
  actions: ActionStats[];
  best_action: SimAction | null;
  rollout_count: number;
  perspective_win_pct: number;
}

/** ponytail: minimal mulberry32 PRNG for deterministic rollouts */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
    id: p.id, name: p.name, types: p.types, base_stats: p.base_stats,
    abilities: p.abilities, weight: p.weight, tier: p.tier,
    is_mega: p.is_mega, is_paradox: p.is_paradox, is_legendary: p.is_legendary,
    is_pseudo: p.is_pseudo, api_name: p.api_name, primary_set_id: p.primary_set_id,
  };
}

function mapWeather(w: string | null | undefined): BattleModifiers['weather'] {
  if (!w) return '';
  if (w === 'sun' || w === 'sunny') return 'sunny';
  if (w === 'rain') return 'rain';
  if (w === 'sand' || w === 'sandstorm') return 'sandstorm';
  if (w === 'hail' || w === 'snow') return 'snow';
  return '';
}

function mapTerrain(f: string): BattleModifiers['terrain'] {
  if (f === 'electric_terrain' || f === 'electric') return 'electric';
  if (f === 'grassy_terrain' || f === 'grassy') return 'grassy';
  if (f === 'psychic_terrain' || f === 'psychic') return 'psychic';
  if (f === 'misty_terrain' || f === 'misty') return 'misty';
  return '';
}

function fieldModsFromState(state: GameState): BattleModifiers {
  let terrain: BattleModifiers['terrain'] = '';
  for (const attr of state.field.global_attributes.get({ attribute_type: 'field' })) {
    if (attr instanceof FieldAttribute && FieldAttribute.TERRAIN_TYPES.has(attr.field)) {
      terrain = mapTerrain(attr.field);
      break;
    }
  }
  return {
    weather: mapWeather(state.field.getWeather()),
    terrain,
  };
}

export class ProbabilisticEngine {
  private readonly rng: () => number;

  constructor(
    readonly kg: KnowledgeGraph,
    readonly sim: BattleSimulator,
    readonly defaultRollouts = 30,
    readonly maxTurns = 200,
    seed: number | null = null,
  ) {
    this.rng = seed != null ? mulberry32(seed) : Math.random;
  }

  evaluateState(
    state: GameState,
    perspective: 'a' | 'b' = 'a',
    numRollouts?: number,
  ): StateEvaluation {
    const n = numRollouts ?? this.defaultRollouts;
    let wins = 0;
    let losses = 0;
    let draws = 0;

    for (let i = 0; i < n; i++) {
      const result = this.rollout(state.clone());
      if (result.winner === perspective) wins++;
      else if (result.winner === 'draw') draws++;
      else losses++;
    }

    const evaluation: StateEvaluation = {
      win_probability: wins / n,
      draw_probability: draws / n,
      loss_probability: losses / n,
      actions: [],
      best_action: null,
      rollout_count: n,
      perspective_win_pct: (wins / n) * 100,
    };

    const actions = this.getAvailableActions(state, perspective);
    const perAction = Math.max(5, Math.floor(n / Math.max(actions.length, 1)));

    for (const action of actions) {
      const stats: ActionStats = {
        action, wins: 0, losses: 0, draws: 0,
        total_rollouts: perAction, avg_turns: 0,
        win_rate: 0,
      };
      for (let i = 0; i < perAction; i++) {
        const clone = state.clone();
        this.executeAction(clone, action);
        const result = this.rollout(clone);
        if (result.winner === perspective) stats.wins++;
        else if (result.winner === 'draw') stats.draws++;
        else stats.losses++;
      }
      stats.win_rate = stats.total_rollouts > 0 ? stats.wins / stats.total_rollouts : 0;
      evaluation.actions.push(stats);
    }

    evaluation.actions.sort((a, b) => b.win_rate - a.win_rate);
    evaluation.best_action = evaluation.actions[0]?.action ?? null;
    return evaluation;
  }

  quickWinPct(state: GameState, perspective: 'a' | 'b' = 'a', numRollouts = 20): number {
    let wins = 0;
    for (let i = 0; i < numRollouts; i++) {
      if (this.rollout(state.clone()).winner === perspective) wins++;
    }
    return wins / numRollouts;
  }

  getAvailableActions(state: GameState, side: 'a' | 'b'): SimAction[] {
    const active = state.getActivePokemon(side);
    if (!active || active.isFainted) return [];

    const actions: SimAction[] = [];
    const setObj = this.kg.getSet(active.set_id);
    if (setObj) {
      for (const moveId of setObj.moves) {
        const move = this.kg.getMove(moveId);
        if (move && !move.is_status) {
          actions.push({ action_type: 'move', target_id: moveId, source_side: side });
        }
      }
    }

    const team = side === 'a' ? state.team_a : state.team_b;
    const activeIdx = side === 'a' ? state.active_a : state.active_b;
    for (let i = 0; i < team.length; i++) {
      const pkmn = team[i]!;
      if (i !== activeIdx && !pkmn.isFainted) {
        actions.push({ action_type: 'switch', target_id: pkmn.set_id, source_side: side });
      }
    }
    return actions;
  }

  rollout(state: GameState): RolloutResult {
    for (let turn = 0; turn < this.maxTurns; turn++) {
      const [isOver, winner] = state.isBattleOver();
      if (isOver) {
        return { winner: (winner ?? 'draw') as 'a' | 'b' | 'draw', turns: turn, final_hp_a: {}, final_hp_b: {}, action_log: [] };
      }

      for (const side of ['a', 'b'] as const) {
        const active = state.getActivePokemon(side);
        if (!active || active.isFainted) {
          this.forceSwitch(state, side);
          continue;
        }

        const roll = this.rng();
        const opponent = state.getOpponent(side);
        let action: SimAction | null = null;

        if (roll < 0.70 && opponent && !opponent.isFainted) {
          action = this.pickBestMove(state, side);
        } else if (roll < 0.90) {
          action = this.pickRandomMove(state, side);
        } else {
          action = this.pickRandomSwitch(state, side);
        }

        if (action) this.executeAction(state, action);

        const [over, w] = state.isBattleOver();
        if (over) {
          return { winner: (w ?? 'draw') as 'a' | 'b' | 'draw', turns: turn, final_hp_a: {}, final_hp_b: {}, action_log: [] };
        }
      }
      state.tick();
    }

    const winner = this.evaluateHpTiebreak(state);
    const result: RolloutResult = {
      winner, turns: this.maxTurns, action_log: [],
      final_hp_a: {}, final_hp_b: {},
    };
    for (const p of state.team_a) result.final_hp_a[p.set_id] = p.current_hp;
    for (const p of state.team_b) result.final_hp_b[p.set_id] = p.current_hp;
    return result;
  }

  pickBestMove(state: GameState, side: 'a' | 'b'): SimAction | null {
    const active = state.getActivePokemon(side);
    const opponent = state.getOpponent(side);
    if (!active || !opponent) return this.pickRandomMove(state, side);

    const ourProfile = this.sim.getProfile(active.pokemon_id);
    const theirProfile = this.sim.getProfile(opponent.pokemon_id);
    const setObj = this.kg.getSet(active.set_id);
    if (!setObj) return this.pickRandomMove(state, side);

    const ourMods = this.sim.getAttributeModifiers(ourProfile);
    const theirMods = this.sim.getAttributeModifiers(theirProfile);
    const fieldMods = fieldModsFromState(state);

    let bestMoveId: string | null = null;
    let bestDmg = 0;

    for (const moveId of setObj.moves) {
      const move = this.kg.getMove(moveId);
      if (!move || move.is_status) continue;
      const ev = this.sim.evaluateMove(moveId, ourProfile, theirProfile, ourMods, theirMods, fieldMods);
      if (ev && !ev.is_immune && ev.avg_damage > bestDmg) {
        bestDmg = ev.avg_damage;
        bestMoveId = moveId;
      }
    }

    return bestMoveId
      ? { action_type: 'move', target_id: bestMoveId, source_side: side }
      : this.pickRandomMove(state, side);
  }

  pickRandomMove(state: GameState, side: 'a' | 'b'): SimAction | null {
    const moves = this.getAvailableActions(state, side).filter((a) => a.action_type === 'move');
    if (!moves.length) return null;
    return moves[Math.floor(this.rng() * moves.length)]!;
  }

  pickRandomSwitch(state: GameState, side: 'a' | 'b'): SimAction | null {
    const switches = this.getAvailableActions(state, side).filter((a) => a.action_type === 'switch');
    if (!switches.length) return null;
    return switches[Math.floor(this.rng() * switches.length)]!;
  }

  forceSwitch(state: GameState, side: 'a' | 'b'): boolean {
    const team = side === 'a' ? state.team_a : state.team_b;
    const activeIdx = side === 'a' ? state.active_a : state.active_b;
    for (let i = 0; i < team.length; i++) {
      if (i !== activeIdx && !team[i]!.isFainted) {
        return state.switchPokemon(side, i);
      }
    }
    return false;
  }

  executeAction(state: GameState, action: SimAction): void {
    if (action.action_type === 'switch') this.executeSwitch(state, action);
    else if (action.action_type === 'move') this.executeMove(state, action);
  }

  executeSwitch(state: GameState, action: SimAction): void {
    const team = action.source_side === 'a' ? state.team_a : state.team_b;
    for (let i = 0; i < team.length; i++) {
      const pkmn = team[i]!;
      if (pkmn.set_id === action.target_id && !pkmn.isFainted) {
        state.switchPokemon(action.source_side, i);
        return;
      }
    }
  }

  executeMove(state: GameState, action: SimAction): void {
    const attacker = state.getActivePokemon(action.source_side);
    const defender = state.getOpponent(action.source_side);
    if (!attacker || !defender || defender.isFainted) return;

    const move = this.kg.getMove(action.target_id);
    if (!move || move.is_status) return;

    const attackerSet = this.kg.getSet(attacker.set_id);
    const defenderSet = this.kg.getSet(defender.set_id);
    const atkSp = toPackSpecies(this.kg, attacker.pokemon_id);
    const defSp = toPackSpecies(this.kg, defender.pokemon_id);
    if (!attackerSet || !defenderSet || !atkSp || !defSp) return;

    const fieldMods = fieldModsFromState(state);
    const result = computeDamage(
      toPackSet(attackerSet), toPackSet(defenderSet),
      {
        id: move.id, name: move.name, type: move.type,
        category: move.category as Move['category'],
        base_power: move.base_power,
        accuracy: move.accuracy as Move['accuracy'],
        priority: move.priority, pp: move.pp, target: move.target,
        flags: move.flags, secondary_effects: move.secondary_effects,
      },
      atkSp, defSp, this.sim.level, fieldMods,
    );

    if (result.is_immune) return;

    const { min_damage: minDmg, max_damage: maxDmg } = result;
    const actualDamage = maxDmg <= minDmg
      ? maxDmg
      : minDmg + Math.floor(this.rng() * (maxDmg - minDmg + 1));
    defender.takeDamage(Math.max(1, actualDamage));
    attacker.useMove(action.target_id);
  }

  evaluateHpTiebreak(state: GameState): 'a' | 'b' | 'draw' {
    const hpA = state.team_a.filter((p) => !p.isFainted).reduce((s, p) => s + p.current_hp, 0);
    const hpB = state.team_b.filter((p) => !p.isFainted).reduce((s, p) => s + p.current_hp, 0);
    const scoreA = state.countAlive('a') * 1000 + hpA;
    const scoreB = state.countAlive('b') * 1000 + hpB;
    if (scoreA > scoreB) return 'a';
    if (scoreB > scoreA) return 'b';
    return 'draw';
  }

  createStateFromSets(teamASetIds: string[], teamBSetIds: string[]): GameState {
    const buildTeam = (setIds: string[]): PokemonState[] => {
      const team: PokemonState[] = [];
      for (const sid of setIds.slice(0, 6)) {
        const setObj = this.kg.getSet(sid);
        if (!setObj) continue;
        const sp = toPackSpecies(this.kg, setObj.pokemon_id);
        if (!sp) continue;
        const hp = computeHp(sp, toPackSet(setObj), this.sim.level);
        const ps = new PokemonState(setObj.pokemon_id, sid);
        ps.current_hp = hp;
        ps.max_hp = hp;
        team.push(ps);
      }
      return team;
    };

    const state = new GameState();
    state.team_a = buildTeam(teamASetIds);
    state.team_b = buildTeam(teamBSetIds);

    if (state.team_a[0] && !state.team_a[0].isFainted) {
      state.team_a[0].is_active = true;
      state.active_a = 0;
    }
    if (state.team_b[0] && !state.team_b[0].isFainted) {
      state.team_b[0].is_active = true;
      state.active_b = 0;
    }
    return state;
  }
}
