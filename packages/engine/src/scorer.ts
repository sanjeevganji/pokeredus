import type { Action, FieldFlags, Side, TurnState } from './state.js';
import type { PackIndex } from '@pokeredus/pack';
import type { Biases } from '@pokeredus/biases';
import { computeDamage, type BattleModifiers } from '@pokeredus/calc';
import { enumerateActions } from './actions.js';
import { scoreLeaf } from './leaf.js';

export interface ScoredAction {
  action: Action;
  score: number;
  reasoning: string[];
  children?: ScoredAction[];
  elapsedMs?: number;
}

export function scoreTurn(
  state: TurnState,
  pack: PackIndex,
  biases: Biases,
): ScoredAction[] {
  if (!state.allowThin && pack.byteSizeMB < biases.pack_min_mb) {
    throw new Error(
      `pack too small (${pack.byteSizeMB.toFixed(2)}MB < ${biases.pack_min_mb}MB) — ` +
      `pass allowThin:true on the TurnState for the mini pack`,
    );
  }

  const legal = enumerateActions(state, pack);
  const scored: ScoredAction[] = legal.map((action) => {
    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    const result = evaluateAction(state, action, pack, biases);
    const t1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    return {
      action,
      score: result.score,
      reasoning: result.reasoning,
      children: result.children,
      elapsedMs: t1 - t0,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function evaluateAction(
  state: TurnState,
  action: Action,
  pack: PackIndex,
  biases: Biases,
): { score: number; reasoning: string[]; children?: ScoredAction[] } {
  const leaf = scoreLeaf(state, action, pack, biases);
  if (biases.rollout_depth <= 0) {
    return { score: leaf.score, reasoning: leaf.reasoning };
  }

  const childState = simulateOneStep(state, action, pack);
  if (!childState) {
    return { score: leaf.score, reasoning: leaf.reasoning };
  }

  const oppLegal = enumerateActions(flipSide(childState), pack);
  if (oppLegal.length === 0) {
    return { score: leaf.score, reasoning: leaf.reasoning };
  }

  const children: ScoredAction[] = [];

  if (biases.rollout_count > 0) {
    let sum = 0;
    const n = Math.min(biases.rollout_count, oppLegal.length);
    for (let i = 0; i < n; i++) {
      const reply = oppLegal[Math.floor(Math.random() * oppLegal.length)]!;
      const childLeaf = scoreLeaf(flipSide(childState), reply, pack, biases);
      sum += childLeaf.score;
      children.push({ action: reply, score: childLeaf.score, reasoning: childLeaf.reasoning });
    }
    const avgChild = sum / n;
    const combined = leaf.score + biases.child_weight * avgChild;
    return { score: combined, reasoning: leaf.reasoning, children };
  } else {
    for (const reply of oppLegal) {
      const childLeaf = scoreLeaf(flipSide(childState), reply, pack, biases);
      children.push({ action: reply, score: childLeaf.score, reasoning: childLeaf.reasoning });
    }
    children.sort((a, b) => b.score - a.score);
    const bestChild = children[0];
    const combined = leaf.score + biases.child_weight * (bestChild ? bestChild.score : 0);
    return { score: combined, reasoning: leaf.reasoning, children };
  }
}

function fieldToBattleMods(field: FieldFlags, actorSide: Side): BattleModifiers {
  return {
    weather: field.weather || undefined,
    terrain: field.terrain || undefined,
    reflect: actorSide === 'a' ? field.reflect_b > 0 : field.reflect_a > 0,
    lightScreen: actorSide === 'a' ? field.lightscreen_b > 0 : field.lightscreen_a > 0,
  };
}

function simulateOneStep(state: TurnState, action: Action, pack: PackIndex): TurnState | null {
  const clone: TurnState = {
    ...state,
    side: state.side === 'a' ? 'b' : 'a',
    myActive: { ...state.oppActive, boosts: { ...state.oppActive.boosts }, pp: { ...state.oppActive.pp } },
    oppActive: { ...state.myActive, boosts: { ...state.myActive.boosts }, pp: { ...state.myActive.pp } },
    myBench: state.myBench.map((m) => ({ ...m, boosts: { ...m.boosts }, pp: { ...m.pp } })),
    field: { ...state.field, hazards_a: { ...state.field.hazards_a }, hazards_b: { ...state.field.hazards_b } },
  };

  if (action.type === 'switch' && action.slot !== undefined) {
    const incoming = state.myBench[action.slot];
    if (!incoming || incoming.fainted) return null;
    clone.myBench[action.slot] = { ...state.myActive, boosts: { ...state.myActive.boosts }, pp: { ...state.myActive.pp } };
    clone.myActive = { ...incoming, boosts: { ...incoming.boosts }, pp: { ...incoming.pp } };
    return clone;
  }

  if (action.type === 'move' && action.moveId) {
    const attackerSet = pack.getSet(state.myActive.setId);
    const defenderSet = pack.getSet(state.oppActive.setId);
    const move = pack.getMove(action.moveId);
    const atkSp = attackerSet ? pack.getSpecies(attackerSet.pokemon_id) : undefined;
    const defSp = defenderSet ? pack.getSpecies(defenderSet.pokemon_id) : undefined;

    if (attackerSet && defenderSet && move && atkSp && defSp && move.category !== 'Status') {
      const mods = fieldToBattleMods(state.field, state.side);
      const result = computeDamage(attackerSet, defenderSet, move, atkSp, defSp, 100, mods);
      if (!result.is_immune && result.max_damage > 0) {
        const dmg = Math.max(1, Math.floor((result.min_damage + result.max_damage) / 2));
        clone.myActive.hp = Math.max(0, clone.myActive.hp - dmg);
        if (clone.myActive.hp <= 0) clone.myActive.fainted = true;
      }
    }
  }

  return clone;
}

function flipSide(s: TurnState): TurnState {
  return {
    ...s,
    side: s.side === 'a' ? 'b' : 'a',
    myActive: s.oppActive,
    oppActive: s.myActive,
    myBench: s.myBench,
  };
}
