// Scorer — MCTS-style bounded-depth tree search, the main runtime entry.
// The Showdown bridge calls `scoreTurn(state, pack, biases)` per |request|.
//
// Algorithm:
//   1. legal = enumerateActions(state, pack)
//   2. for each action: leaf = scoreLeaf(state, action, pack, biases)
//   3. if rollout_depth > 0: build a shallow child TurnState (simulate the
//      expected result of taking the action), then greedily score the
//      opponent's best countermove with scoreLeaf again, and fold in:
//        final = leaf.score + biases.child_weight * bestChildScore
//      If rollout_count > 0 we additionally sample that many random opponent
//      replies (uniform over opponent's legal moves) and average their leaf
//      scores instead of just the greedy best — the plan's MCTS flavor.
//   4. Return ScoredAction[] sorted descending.
//
// We DO NOT call out to Python at runtime — the damage model is the in-TS
// port (damage.ts) and the heuristic prior is leaf.ts. The whole turn runs
// under biases.budget_ms (~50ms) by construction: O(legal × rollout_count)
// leaf calls, each leaf is O(moves) array work.
import type { Action, TurnState, ActiveMon } from './state.js';
import type { PackIndex } from '../pack/index.js';
import type { Biases } from '../biases/schema.js';
import { enumerateActions } from './actions.js';
import { scoreLeaf } from './leaf.js';

export interface ScoredAction {
  action: Action;
  score: number;
  reasoning: string[];
  /** Populated only when biases.rollout_depth > 0. */
  children?: ScoredAction[];
  /** Elapsed ms for this action's evaluation (diagnostic). */
  elapsedMs?: number;
}

/**
 * Score a full turn — the bridge's main hook. Returns ranked actions.
 * Refuses to run against a pack smaller than `biases.pack_min_mb` unless
 * `state.allowThin` is set (so the engine never silently uses a truncated pack).
 */
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

/** Evaluate one action: leaf + (optional) child search. */
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

  // Build the child state — the result of taking our action, leaving the
  // opponent to choose their best counter.
  const childState = simulateOneStep(state, action, pack);
  if (!childState) {
    return { score: leaf.score, reasoning: leaf.reasoning };
  }

  // Recurse one ply for the opponent. We compute the opponent's legal actions
  // and either (a) greedily take the best or (b) if rollout_count>0, average
  // over rolloutCount sampled replies. The child's child is scored flat
  // (rollout_depth reduces by 1) — bounded by construction.
  const oppLegal = enumerateActions(flipSide(childState), pack);
  if (oppLegal.length === 0) {
    return { score: leaf.score, reasoning: leaf.reasoning };
  }

  let bestChild: ScoredAction | undefined;
  const children: ScoredAction[] = [];

  if (biases.rollout_count > 0) {
    // Sample rollout_count replies (uniform random), average their leaf scores.
    let sum = 0;
    const n = Math.min(biases.rollout_count, oppLegal.length);
    for (let i = 0; i < n; i++) {
      // ponytail: ceiling — weight by opponent-leaf score later via a softmax
      // sampler; uniform is fine for v1 and matches the plan's MCTS framing.
      const reply = oppLegal[Math.floor(Math.random() * oppLegal.length)]!;
      const childLeaf = scoreLeaf(flipSide(childState), reply, pack, biases);
      sum += childLeaf.score;
      children.push({ action: reply, score: childLeaf.score, reasoning: childLeaf.reasoning });
    }
    const avgChild = sum / n;
    const combined = leaf.score + biases.child_weight * avgChild;
    bestChild = children[0]; // diagnostic only
    return { score: combined, reasoning: leaf.reasoning, children };
  } else {
    // Greedy best counter (depth-1 minimax-ish — opponent plays their best).
    for (const reply of oppLegal) {
      const childLeaf = scoreLeaf(flipSide(childState), reply, pack, biases);
      children.push({ action: reply, score: childLeaf.score, reasoning: childLeaf.reasoning });
    }
    children.sort((a, b) => b.score - a.score);
    bestChild = children[0];
    const combined = leaf.score + biases.child_weight * (bestChild ? bestChild.score : 0);
    return { score: combined, reasoning: leaf.reasoning, children };
  }
}

/** Build a shallow child TurnState — apply our action, swap perspective. */
function simulateOneStep(state: TurnState, action: Action, _pack: PackIndex): TurnState | null {
  // Deep enough copy to mutate HP / active mon independently.
  const clone: TurnState = {
    ...state,
    side: state.side === 'a' ? 'b' : 'a',
    myActive: { ...state.oppActive, boosts: { ...state.oppActive.boosts }, pp: { ...state.oppActive.pp } },
    oppActive: { ...state.myActive, boosts: { ...state.myActive.boosts }, pp: { ...state.myActive.pp } },
    myBench: state.myBench.map((m) => ({ ...m })),
    field: { ...state.field },
  };

  if (action.type === 'switch' && action.slot !== undefined) {
    const incoming = clone.myBench[action.slot];
    if (!incoming || incoming.fainted) return null;
    // swap active with the bench mon
    const oldActive = clone.oppActive; // oppActive is currently the "me" side post-flip
    clone.myBench[action.slot] = oldActive;
    clone.myActive = { ...incoming, boosts: { ...incoming.boosts }, pp: { ...incoming.pp } };
    return clone;
  }

  // For move actions we don't actually apply damage — the leaf scorer has
  // already folded expected damage in via the cached edge prior. The child
  // state is the post-decision position where the opponent now acts.
  return clone;
}

/** Swap our side and the opponent's — for evaluating the opponent's reply. */
function flipSide(s: TurnState): TurnState {
  return {
    ...s,
    side: s.side === 'a' ? 'b' : 'a',
    myActive: s.oppActive,
    oppActive: s.myActive,
    myBench: s.myBench, // bench is our team; from the opp's view we don't know theirs
  };
}
