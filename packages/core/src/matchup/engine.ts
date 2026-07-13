import { MatchupRelation } from '../classes/matchup.js';
import type { SetClass } from '../classes/sets.js';
import type { KnowledgeGraph } from '../kg/knowledge-graph.js';
import { fullMatchup } from './damage.js';

export function computeTtkScore(
  ttkAToB: number,
  ttkBToA: number,
  speedAdvantage: 'a' | 'b' | 'tie',
): number {
  const aCanKill = ttkAToB > 0;
  const bCanKill = ttkBToA > 0;

  if (!aCanKill && !bCanKill) return 0;
  if (aCanKill && !bCanKill) return 1;
  if (!aCanKill && bCanKill) return -1;

  const ttkDiff = ttkBToA - ttkAToB;
  let baseScore = Math.tanh(ttkDiff / 2.5);

  let speedAdj = 0;
  if (speedAdvantage === 'a') speedAdj = 0.1;
  else if (speedAdvantage === 'b') speedAdj = -0.1;

  if (ttkDiff === 0) {
    if (speedAdvantage === 'a') speedAdj = 0.15;
    else if (speedAdvantage === 'b') speedAdj = -0.15;
  }

  return Math.max(-1, Math.min(1, baseScore + speedAdj));
}

export function computeMatchup(
  setA: SetClass,
  setB: SetClass,
  kg: KnowledgeGraph,
): MatchupRelation {
  const pokemonA = kg.getPokemon(setA.pokemon_id);
  const pokemonB = kg.getPokemon(setB.pokemon_id);

  if (!pokemonA || !pokemonB) {
    return new MatchupRelation(setA.id, setB.id, 0, 0, 0, 'ttk_calc');
  }

  const matchup = fullMatchup(setA, setB, kg);
  const ttkAb = matchup.ttk_a_to_b;
  const ttkBa = matchup.ttk_b_to_a;
  const speedAdv = matchup.speed_advantage;

  const tags: string[] = [];
  if (ttkAb > 0) {
    if (ttkAb === 1) tags.push('OHKO');
    else if (ttkAb <= 3) tags.push(`${ttkAb}HKO`);
    else tags.push(`${ttkAb}HKO`);
  }
  if (speedAdv === 'a') tags.push('faster');
  else if (speedAdv === 'b') tags.push('slower');
  else tags.push('speed_tie');

  if (matchup.best_move_a?.is_immune) tags.push('immune_to_a');
  if (matchup.best_move_b?.is_immune) tags.push('immune_to_b');
  if (matchup.best_move_a && matchup.best_move_a.type_effectiveness >= 2) {
    tags.push('super_effective_coverage');
  }
  if (matchup.best_move_b && matchup.best_move_b.type_effectiveness >= 2) {
    tags.push('vulnerable_to_super_effective');
  }

  const score = computeTtkScore(ttkAb, ttkBa, speedAdv);

  let confidence = 0.5;
  if (ttkAb > 0 && ttkBa > 0) confidence = 0.7;
  if (matchup.best_move_a && matchup.best_move_a.type_effectiveness >= 2) confidence += 0.1;
  if (matchup.best_move_b && matchup.best_move_b.type_effectiveness >= 2) confidence += 0.1;
  confidence = Math.min(1, confidence);

  return new MatchupRelation(
    setA.id, setB.id,
    Math.round(score * 10000) / 10000,
    Math.round(confidence * 100) / 100,
    0, 'ttk_calc', tags,
    ttkAb, ttkBa, speedAdv,
    matchup.best_move_a_id, matchup.best_move_b_id,
    matchup.damage_a_to_b, matchup.damage_b_to_a,
    matchup.hp_a, matchup.hp_b,
    matchup.min_damage_a_to_b, matchup.max_damage_a_to_b,
    matchup.min_damage_b_to_a, matchup.max_damage_b_to_a,
    matchup.damage_pct_a_to_b_lo, matchup.damage_pct_a_to_b_hi,
    matchup.damage_pct_b_to_a_lo, matchup.damage_pct_b_to_a_hi,
    matchup.min_ttk_a_to_b, matchup.max_ttk_a_to_b,
    matchup.min_ttk_b_to_a, matchup.max_ttk_b_to_a,
  );
}

export function computeAllMatchups(kg: KnowledgeGraph): number {
  const sets = kg.getAllSets();
  let count = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = 0; j < sets.length; j++) {
      if (i === j) continue;
      kg.addMatchup(computeMatchup(sets[i]!, sets[j]!, kg));
      count++;
    }
  }
  return count;
}
