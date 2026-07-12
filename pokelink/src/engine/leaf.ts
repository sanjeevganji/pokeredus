// Leaf evaluator — the additive heuristic prior.
// A faithful TS port of pokeredus/graph/matchup_graph.py:pick_best_move
// (move actions) and find_optimal_switch (switch actions). The new hook the
// downloaded intelligence plugs into is the edge_prior_term, weighted by
// biases.edge_prior_weight. Reasoning strings are accumulated exactly like
// the Python implementation so each ScoredAction carries a human-readable trail
// — this is the "available to human fine tuning and iterative adjustments"
// surface the plan calls for.
import type { Action, ActiveMon, TurnState } from './state.js';
import type { PackIndex } from '../pack/index.js';
import type { Biases } from '../biases/schema.js';
import { getEffectiveness, getBestEffectiveness } from './type-chart.js';

// ponytail: ceiling — when richer bulk is needed (the Python scorer uses a
// 3D axis projection), upgrade by porting project_to_3d. The simple bulk
// metric here (sum of HP+def+spd) is a stable monotone surrogate for now.
function bulkMetric(setId: string, pack: PackIndex): number {
  const set = pack.getSet(setId);
  if (!set) return 0;
  const sp = pack.getSpecies(set.pokemon_id);
  if (!sp) return 0;
  return sp.base_stats.hp + sp.base_stats.def + sp.base_stats.spd;
}

// Pivot and recovery moves (lowercase move ids) — ported verbatim from
// matchup_graph.py:PIVOT_OR_RECOVERY. Used for the status-spam bonus.
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

/**
 * Score a single action (move or switch) against the current TurnState.
 * Returns { score, reasoning } — the reasoning array is the human-readable
 * audit trail mirroring pick_best_move / find_optimal_switch.
 */
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

// ── Move scoring ──────────────────────────────────────────────────────
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
  // For tera variants, the defender (if tera'd) would change types; for now
  // the bridge does not surface opponent tera state, so we ignore it.
  let typeMult = getEffectiveness(move.type, defTypes);
  if (action.tera && set.tera_type) {
    // If WE tera into the set's tera type, recompute type eff using tera type.
    typeMult = getEffectiveness(set.tera_type, defTypes);
  }

  const isStatus = move.category === 'Status';
  const isStab = attackerPokemon.types.includes(move.type);
  const aHasRecovery = set.moves.some((m) => PIVOT_OR_RECOVERY.has(m.toLowerCase()));

  // base score — matches Python pick_best_move line 587
  let score = 1.0;

  // ── Damage-derived score from cached edge (best-move match) ──────────
  const edge = pack.getEdge(set.id, oppSet.id);
  if (edge && biases.use_damage_rollout && edge.best_move_a_id === action.moveId) {
    const dmgPct = Math.max(0, edge.dmg_pct_hi);
    if (dmgPct > 0) {
      score += (dmgPct / 100) * biases.damage_weight;
      reasons.push(`~${dmgPct.toFixed(0)}% damage roll (cached)`);
    }
  }

  // ── Type effectiveness ──────────────────────────────────────────────
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
  // type_mult === 1.0 → neutral, no change

  // ── STAB ────────────────────────────────────────────────────────────
  if (isStab && !isStatus) {
    score += 1 * biases.stab_weight;
    reasons.push('STAB');
  }

  // ── High base power (nuke) ───────────────────────────────────────────
  if (move.base_power >= 100 && !isStatus) {
    score += 1 * biases.bp_weight;
    reasons.push('nuke-tier power');
  }

  // ── Status utility ──────────────────────────────────────────────────
  if (isStatus) {
    score += 1 * biases.utility_weight;
    reasons.push('status utility');
    if (aHasRecovery) {
      score += 0.1 * biases.utility_weight;
      reasons.push('set has recovery → status spam');
    }
  }

  // ── Priority ────────────────────────────────────────────────────────
  if (move.priority > 0) {
    score += 1 * biases.priority_weight;
    reasons.push('priority');
  }

  // ── Edge prior (the downloaded-intelligence hook) ────────────────────
  if (edge) {
    score += biases.edge_prior_weight * edge.score;
    if (Math.abs(edge.score) > 0.01) {
      reasons.push(`edge prior ${edge.score >= 0 ? '+' : ''}${edge.score.toFixed(2)}`);
    }
  }

  return { score, reasoning: reasons };
}

// ── Switch scoring ────────────────────────────────────────────────────
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

  // 1. Type resist: product of opponent's STAB attack type eff vs candidate.
  //    Mirrors find_optimal_switch line 710-735.
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

  // 2. Speed advantage (uses base_stats as a proxy; the full Python impl
  //    uses effective_stat with EVs/IVs/nature — we approximate with base
  //    spe since the bench mon's set may not be known exactly).
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

  // 3. Precomputed matchup edge: candidate → opponent
  const edge = pack.getEdge(candSet.id, oppSet.id);
  if (edge) {
    const mBonus = Math.max(-1.0, Math.min(1.0, edge.score)) * biases.switch_edge_weight;
    score += mBonus;
    if (mBonus > 0.1) reasons.push(`favorable precomputed matchup (${edge.score.toFixed(2)})`);
    else if (mBonus < -0.1) reasons.push(`unfavorable precomputed matchup (${edge.score.toFixed(2)})`);
  }

  // 4. Complementary-role tiebreak (bulk distance surrogate; closer = similar role
  //    → we want complementary, so we lightly penalize similarity).
  const oppBulk = bulkMetric(oppSet.id, pack);
  const cBulk = bulkMetric(candSet.id, pack);
  const dist = Math.abs(oppBulk - cBulk) / Math.max(1, oppBulk + cBulk);
  score -= biases.switch_distance_weight * dist;

  return { score, reasoning: reasons };
}

/** Opponent's offensive types: non-status damaging move types + own STAB types, deduped. */
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
  // dedupe preserving order
  return Array.from(new Set(out));
}
