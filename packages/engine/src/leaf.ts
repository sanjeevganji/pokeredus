import type { Action, TurnState } from './state.js';
import type { PackIndex } from '@pokeredus/pack';
import type { Biases } from '@pokeredus/biases';
import { getEffectiveness } from './type-chart.js';

function bulkMetric(setId: string, pack: PackIndex): number {
  const set = pack.getSet(setId);
  if (!set) return 0;
  const sp = pack.getSpecies(set.pokemon_id);
  if (!sp) return 0;
  return sp.base_stats.hp + sp.base_stats.def + sp.base_stats.spd;
}

const PIVOT_OR_RECOVERY: ReadonlySet<string> = new Set([
  'uturn', 'voltswitch', 'partingshot', 'whirlwind', 'roar', 'haze',
  'dragontail', 'circlethrow', 'recover', 'softboiled', 'slackoff',
  'wish', 'roost', 'morningsun', 'moonlight', 'synthesis',
  'milkdrink', 'healorder',
]);

export interface LeafResult {
  score: number;
  reasoning: string[];
}

export function scoreLeaf(
  state: TurnState,
  action: Action,
  pack: PackIndex,
  biases: Biases,
): LeafResult {
  if (action.type === 'move') {
    return scoreMove(state, action, pack, biases);
  }
  return scoreSwitch(state, action, pack, biases);
}

function scoreMove(
  state: TurnState,
  action: Action,
  pack: PackIndex,
  biases: Biases,
): LeafResult {
  const reasons: string[] = [];
  const active = state.myActive;
  const set = pack.getSet(active.setId);
  const oppSet = pack.getSet(state.oppActive.setId);
  if (!set || !oppSet || !action.moveId) {
    return { score: 0.0, reasoning: ['missing set/move lookup'] };
  }
  const attackerPokemon = pack.getSpecies(set.pokemon_id);
  const defenderPokemon = pack.getSpecies(oppSet.pokemon_id);
  if (!attackerPokemon || !defenderPokemon) {
    return { score: 0.0, reasoning: ['missing species lookup'] };
  }
  const move = pack.getMove(action.moveId);
  if (!move) {
    return { score: 0.0, reasoning: [`unknown move ${action.moveId}`] };
  }

  const defTypes = defenderPokemon.types;
  let typeMult = getEffectiveness(move.type, defTypes);
  if (action.tera && set.tera_type) {
    typeMult = getEffectiveness(set.tera_type, defTypes);
  }

  const isStatus = move.category === 'Status';
  const isStab = attackerPokemon.types.includes(move.type);
  const aHasRecovery = set.moves.some((m) => PIVOT_OR_RECOVERY.has(m.toLowerCase()));

  let score = 1.0;

  const edge = pack.getEdge(set.id, oppSet.id);
  if (edge && biases.use_damage_rollout && edge.best_move_a_id === action.moveId) {
    const dmgPct = Math.max(0, edge.dmg_pct_hi);
    if (dmgPct > 0) {
      score += (dmgPct / 100) * biases.damage_weight;
      reasons.push(`~${dmgPct.toFixed(0)}% damage roll (cached)`);
    }
  }

  if (typeMult === 0) {
    score = -1.0;
    reasons.push('immune — never use');
    return { score, reasoning: reasons };
  } else if (typeMult >= 2.0) {
    score += 0.6 * biases.type_eff_weight;
    reasons.push(`super-effective (x${typeMult})`);
  } else if (typeMult > 1.0) {
    score += 0.3 * biases.type_eff_weight;
    reasons.push(`effective (x${typeMult})`);
  } else if (typeMult < 1.0) {
    score -= 0.3 * biases.type_eff_weight;
    reasons.push(`resisted (x${typeMult})`);
  }

  if (isStab && !isStatus) {
    score += 1 * biases.stab_weight;
    reasons.push('STAB');
  }

  if (move.base_power >= 100 && !isStatus) {
    score += 1 * biases.bp_weight;
    reasons.push('nuke-tier power');
  }

  if (isStatus) {
    score += 1 * biases.utility_weight;
    reasons.push('status utility');
    if (aHasRecovery) {
      score += 0.1 * biases.utility_weight;
      reasons.push('set has recovery → status spam');
    }
  }

  if (move.priority > 0) {
    score += 1 * biases.priority_weight;
    reasons.push('priority');
  }

  if (edge) {
    score += biases.edge_prior_weight * edge.score;
    if (Math.abs(edge.score) > 0.01) {
      reasons.push(`edge prior ${edge.score >= 0 ? '+' : ''}${edge.score.toFixed(2)}`);
    }
  }

  return { score, reasoning: reasons };
}

function scoreSwitch(
  state: TurnState,
  action: Action,
  pack: PackIndex,
  biases: Biases,
): LeafResult {
  const reasons: string[] = [];
  const slot = action.slot;
  if (slot === undefined) return { score: 0, reasoning: ['no slot'] };
  const cand = state.myBench[slot];
  if (!cand) return { score: 0, reasoning: [`no bench mon at slot ${slot}`] };

  const opp = state.oppActive;
  const oppSet = pack.getSet(opp.setId);
  const candSet = pack.getSet(cand.setId);
  if (!oppSet || !candSet) {
    return { score: 0, reasoning: ['missing set lookup for switch'] };
  }
  const oppPokemon = pack.getSpecies(oppSet.pokemon_id);
  const candPokemon = pack.getSpecies(candSet.pokemon_id);
  if (!oppPokemon || !candPokemon) {
    return { score: 0, reasoning: ['missing species lookup for switch'] };
  }

  let score = 0.0;

  const oppAttackTypes = collectAttackTypes(oppSet.moves, oppPokemon.types, pack);
  let typeMatchupProduct = 1.0;
  for (const atkType of oppAttackTypes) {
    typeMatchupProduct *= getEffectiveness(atkType, candPokemon.types);
  }
  let typeResistScore = 0.0;
  if (typeMatchupProduct === 0.0) {
    typeResistScore = 2.0;
    reasons.push("immune to opponent's STAB");
  } else if (typeMatchupProduct <= 0.25) {
    typeResistScore = 2.0;
    reasons.push("4x resist to opponent's STAB");
  } else if (typeMatchupProduct <= 0.5) {
    typeResistScore = 1.0;
    reasons.push("resists opponent's STAB");
  } else if (typeMatchupProduct <= 1.0) {
    typeResistScore = 0.5;
    reasons.push("neutral to opponent's STAB");
  } else if (typeMatchupProduct <= 2.0) {
    typeResistScore = 0.0;
    reasons.push("takes SE damage from opponent's STAB");
  } else {
    typeResistScore = -1.0;
    reasons.push("4x weak to opponent's STAB");
  }
  score += biases.switch_type_weight * typeResistScore;

  const oppSpe = oppPokemon.base_stats.spe ?? 0;
  const cSpe = candPokemon.base_stats.spe ?? 0;
  if (cSpe > oppSpe) {
    score += biases.switch_speed_weight;
    reasons.push('faster than opponent');
  } else if (cSpe < oppSpe) {
    score -= biases.switch_speed_weight;
    reasons.push('slower than opponent');
  } else {
    reasons.push('speed tie');
  }

  const edge = pack.getEdge(candSet.id, oppSet.id);
  if (edge) {
    const mBonus = Math.max(-1.0, Math.min(1.0, edge.score)) * biases.switch_edge_weight;
    score += mBonus;
    if (mBonus > 0.1) reasons.push(`favorable precomputed matchup (${edge.score.toFixed(2)})`);
    else if (mBonus < -0.1) reasons.push(`unfavorable precomputed matchup (${edge.score.toFixed(2)})`);
  }

  const oppBulk = bulkMetric(oppSet.id, pack);
  const cBulk = bulkMetric(candSet.id, pack);
  const dist = Math.abs(oppBulk - cBulk) / Math.max(1, oppBulk + cBulk);
  score -= biases.switch_distance_weight * dist;

  return { score, reasoning: reasons };
}

function collectAttackTypes(
  oppSetMoves: string[],
  oppPokemonTypes: string[],
  pack: PackIndex,
): string[] {
  const out: string[] = [];
  for (const mid of oppSetMoves) {
    const mv = pack.getMove(mid);
    if (mv && mv.category !== 'Status' && mv.base_power > 0) out.push(mv.type);
  }
  out.push(...oppPokemonTypes);
  return Array.from(new Set(out));
}
