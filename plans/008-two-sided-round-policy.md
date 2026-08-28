# 008 — Weight every two-sided round adversarially and belief-correctly

**Status:** TODO  
**Commit:** `b97a334`  
**Effort:** L  
**Risk:** High — changes the policy distribution used to choose live actions  
**Depends on:** 003 (DONE), 006, 007  
**Supersedes:** joint-cap and opponent-weighting portions of 002 and 004

## Why

After plan 007 provides a trustworthy pair delta, the engine must evaluate a
selected action against all legal opponent responses. The current evaluator
does create many action pairs, but it merges away set-hypothesis availability,
scores opponent responses with the wrong strategic framing, caps a joint QAOA
grid, marginalizes it, then reconstructs an independent product distribution.
That can give a rare-set-only move too much mass, ignore a manual assumed set,
or favor an opponent action because it is good for us.

This plan retains the hypothesis axis and applies the same policy transform
separately to each side. Every legal action remains represented; no capped
joint reconstruction is needed.

## Current state at `b97a334`

[`packages/engine/src/evaluate.ts`](../packages/engine/src/evaluate.ts) correctly
finds active hypotheses, but applies the active hypothesis to every bench slot
without a set:

```ts
const hyps = active.hypotheses.length ? active.hypotheses : [/* fallback */];
// ...
const theirSets = obs.theirs.map((s) => (s.active ? hyp.set : (s.set ?? hyp.set)));
```

This duplicates the active set into unrevealed/unknown slots.

Branch accumulation includes `hyp.probability`, but `meanCell` divides each
action pair by its own accumulated mass:

```ts
const inv = cell.w > 0 ? 1 / cell.w : 0;
// ...
turnScore: cell.turnScore * inv,
```

If a reply exists only in a 10% hypothesis, the cell keeps its conditional
value and loses the 10% availability mass before reply policy is calculated.

All reply IDs are then unioned and weighted without a hypothesis condition:

```ts
const replies = [...replyById.values()];
const pTheir = softmax(first.replies.map((r) => r.choiceScore));
```

Joint refinement keeps at most 32 pairs, marginalizes them, and later rebuilds
an independent product:

```ts
const capped = capJointPairs(sorted, ourIds, theirIds, JOINT_CAP);
// ...
const marg = marginalize(pairIds, joint.probs, ourIds, theirIds);
```

[`evaluateJointStatePolicy`](../packages/engine/src/evaluate.ts) reconstructs:

```ts
jointProbs.set(pairKey(ourIds[i]!, theirIds[j]!),
  (pOur[i] ?? 0) * (pTheir[j] ?? 0));
```

That product cannot retain hypothesis-conditional reply availability or any
joint correlation.

Manual set overrides are present on `SlotSnapshot.set` with
`setSource='manual'`, while public hypotheses remain for display. Evaluation
prefers the public `hypotheses` array, so the manual correction is not the
simulation assumption.

## Policy contract

Let:

- `i` be one of our legal actions;
- `h` be one active-opponent set hypothesis;
- `j ∈ A(h)` be an opponent action legal under `h`;
- `P(h)` be normalized belief mass;
- `D(i,j,h) ∈ [-1,+1]` be plan 007's expected normalized pair delta from our
  perspective;
- `T(ids, scores)` be the selected policy transform (QAOA in live mode,
  softmax only when explicitly selected or allowed as fallback).

### Assumption selection

```text
if active.setSource == "manual":
  H = [{ set: active.set, probability: 1 }]
else if active.hypotheses is non-empty:
  H = normalized compatible hypotheses
else if active.set is complete:
  H = [{ set: active.set, probability: 1 }]
else:
  fail visibly
```

Public hypotheses remain in output for display even when a compatible manual
set is the active simulation assumption.

For each `h`, generate only actions legal under that set and current state.
A move absent from `h` has zero availability under `h`; it is not a zero-score
branch.

### Two-sided iterative policy

Initialize our policy uniformly across all legal root actions. Then for a small,
explicit iteration count (reuse the existing default of two unless tests show
one is sufficient):

```text
opponentUtility(j,h) =
  Σ_i P_ours(i) × (-D(i,j,h))

P_theirs(j | h) =
  T(A(h), opponentUtility(*,h))

ourUtility(i) =
  Σ_h P(h) × Σ_j P_theirs(j|h) × D(i,j,h)

P_ours(i) =
  T(ourActions, ourUtility(*))
```

`D(i,j,h)` never changes perspective: it is always our `PairScore.score`.
The opponent transform input is exactly `-D`, once. Do not negate opponent
features in plan 007 and then negate the resulting pair delta again.

The opponent transform receives opponent-perspective utility. Positive input
must mean good for the actor on both calls.

Finally:

```text
roundScore =
  Σ_i P_ours(i)
    × Σ_h P(h)
      × Σ_j P_theirs(j|h)
        × D(i,j,h)
```

This score is from our perspective and remains in `[-1,+1]`.

For display only:

```text
P_theirs_display(j) =
  Σ_h where j∈A(h) P(h) × P_theirs(j|h)
```

The display probabilities across the union of opponent action IDs sum to one.
Also expose availability mass:

```text
availability(j) = Σ_h where j∈A(h) P(h)
```

Do not label policy mass or availability as confidence.

### Human-learned weights

Plan 007's persisted human corrections affect `D(i,j,h)` before either policy
transform. Policy code must not maintain another set of score weights.

A corrected ranking must therefore be able to change:

- our utility vector;
- opponent utility vectors where the corrected feature is present;
- policy probabilities;
- `roundScore`.

Use deterministic softmax in focused tests to prove this. QAOA tests only need
to prove finite normalized output and action coverage; finite-shot QAOA is not
expected to be monotonic sample-for-sample.

## Data contract

Keep the hypothesis-conditioned grid internal, but define a typed structure
instead of encoding it in tab-delimited IDs:

```ts
interface HypothesisPolicy {
  key: string;
  set: CanonicalSet;
  probability: number;
  actions: LegalAction[];
  probabilities: number[];
  availabilityByAction: Record<string, number>;
}

interface PairEvaluationCell {
  ourAction: LegalAction;
  theirAction: LegalAction;
  hypothesisKey: string;
  hypothesisProbability: number;
  pairDelta: number;
  // branch/range diagnostics from plan 007
}
```

`JointPolicyResult` may keep its public name for compatibility, but it must
carry enough information for plan 009 to sample a hypothesis and then a
conditional reply:

```ts
{
  pOur: number[];
  hypotheses: HypothesisPolicy[];
  evaluation: RoundEvaluation;
  diagnostics: {
    iterations: number;
    maxPolicyDelta: number;
    hypothesisMass: number;
    legalPairCount: number;
  };
}
```

Remove `jointProbs` if no caller needs it after plan 009 migration. Do not
pretend an independently reconstructed product is a joint policy.

Add to `ReplyEvaluation`:

- `availability`: hypothesis mass where the action is legal;
- `probability`: the display marginal above;
- `expectedUtility`: opponent-perspective `E[-D]` for policy/display
  diagnostics, separate from actor-local `choiceScore`;
- optionally `hypothesisCount` for diagnostics.

Add `expectedUtility` to `ChoiceEvaluation` for our final belief- and
reply-weighted `E[D]`. Preserve plan 007's actor-local `choiceScore` on both
types because the Scenario reordering and `elasticUpdate` train that value.

Do not expose full hidden sets in live JSON. Internal hypothesis keys must not
leak unrevealed species.

## In scope

- `packages/engine/src/evaluate.ts`
- `packages/engine/src/observation.ts`
- `packages/engine/src/actions.ts` only to reuse plan 006 legality
- `packages/engine/src/policy.ts` only for a shared validated transform helper
- `packages/engine/src/scenario.ts` only to compile against the new policy
  result; rollout behavior belongs to plan 009
- `packages/bridge/src/decide.ts`
- `packages/bridge/src/live-state.ts` for additive reply diagnostics
- `packages/engine/tests/integration.test.ts`
- `packages/engine/tests/scenario.test.ts`
- `packages/engine/tests/beliefs.test.ts`
- `packages/engine/tests/policy.test.ts`
- `packages/cli/tests/decide.test.ts`

## Out of scope

- Changing plan 007 valuation formulas or effect metadata.
- Learning separate opponent weights.
- Inferring unrevealed species or switching to an unrevealed slot.
- Exact Nash/minimax solving or a new game-theory dependency.
- Encoding the whole action grid in one QAOA circuit.
- Terminal rollouts and hidden frontier handling (plan 009).
- UI redesign.

## Implementation steps

### 1. Add failing hypothesis-policy fixtures

Build a tiny deterministic evaluator fixture with two hypotheses:

- `h1`, probability 0.9, actions `{common}`;
- `h2`, probability 0.1, actions `{common, rare}`;
- `rare` has a high conditional utility for the opponent.

Assert:

1. `availability(rare) = 0.1`;
2. display mass for `rare` cannot exceed its hypothesis-conditioned mass
   contribution;
3. all hypothesis and conditional action probabilities normalize;
4. a manual override to `h2` makes its assumption mass one;
5. a manual override never erases public candidates from display data;
6. swapping side perspective negates pair delta and reverses actor utility;
7. an opponent action harmful to us receives more opponent-policy mass than an
   action helpful to us;
8. every our action remains represented even when total pairs exceed 32.

Use an injected deterministic pair evaluator or the smallest fixed Showdown
fixture. Do not test probability bookkeeping through slow random teams.

### 2. Preserve hypotheses through branch aggregation

Replace the `Map<pairKey, PairCell>` that merges hypotheses with either:

- a three-key map `(hypothesisKey, ourId, theirId)`; or
- nested maps by hypothesis and action.

Branch/chance weights normalize only within a specific `(h,i,j)` cell.
`P(h)` remains outside that conditional mean until the formulas in this plan
apply it.

Use a stable hypothesis key based on `canonicalizeSet`; never use array position
alone because filtering/reordering changes positions.

Do not substitute the active hypothesis for bench slots. For simulation:

- active slot uses `h.set`;
- each revealed bench uses its compatible manual set, selected assumed set, or
  its own hypothesis;
- each unrevealed slot remains the neutral placeholder and is never switchable.

### 3. Make assumption precedence explicit

Add one small helper for active simulation assumptions. It must:

- collapse a compatible manual override to probability one;
- otherwise normalize public hypothesis mass;
- fall back to one complete selected set only when hypotheses are absent;
- throw on zero/NaN mass or no complete assumption.

Test it directly. Do not change `beliefs.ts` candidate filtering or plan 003's
display catalog.

### 4. Extract one validated side-policy transform

Wrap the existing `QuantumPolicyProcess.decide`/softmax selection behind one
engine helper that:

- receives actor-positive finite scores;
- preserves action order;
- validates output length, finite non-negative values, and positive total mass;
- normalizes once;
- uses softmax only when requested or when the existing explicit fallback
  permits it;
- includes actor/hypothesis context in errors without revealing hidden set
  details.

Both sides call this helper. Do not duplicate QAOA response validation already
present in `policy.ts`.

### 5. Replace joint-cap refinement with separate transforms

Delete:

- `JOINT_CAP`;
- `capJointPairs`;
- tab-delimited pair IDs used as QAOA actions;
- `marginalize`;
- independent `jointProbs` reconstruction.

Implement the iterative contract:

1. start `P_ours` uniformly;
2. calculate each `P_theirs(*|h)` from opponent-positive utility;
3. calculate our belief-weighted utility;
4. transform our vector;
5. repeat for the configured small iteration count;
6. calculate exact final `roundScore` from the final policies.

Track `maxPolicyDelta` per iteration. Do not add a convergence loop with
unbounded runtime. If diagnostics show two iterations are insufficient, STOP
with the fixture instead of silently raising live latency.

### 6. Assemble public choice/reply rows from the final policy

For each our action:

- `choiceScore` remains plan 007's actor-local action value used for human
  correction;
- `expectedUtility` is its final normalized `E[D]` across hypotheses and
  conditional replies;
- `probability` is `P_ours`;
- ranges include all represented compatible branches for that action;
- learned features/weights remain from plan 007.

For each unioned opponent action:

- `choiceScore` remains plan 007's opponent actor-local action value used for
  human correction;
- `expectedUtility` is opponent-perspective `E[-D]` conditioned on the
  hypotheses where it exists;
- `probability` is the belief-weighted display marginal;
- `availability` is separate;
- ranges retain our-perspective signs only if field names explicitly say so.

Sort rows only for display after action IDs/probability arrays are aligned.
Sampling must use ID-to-probability mapping, not array positions from a
different sort.

### 7. Update live decision and compatibility consumers

`decideAndAct` should continue sampling only our returned policy. Remove any
fallback that transforms already-transformed scores a second time.

Add `availability` to live reply mapping and diagnostics. Preserve
`policyWeight` terminology. The live JSON must not serialize canonical hidden
sets or hypothesis keys.

Leave `scenario.ts` compiling with the richer result, but defer its sampling
logic to plan 009. Mark its old `jointProbs` use with a failing test rather than
reconstructing the old product.

### 8. Prove human corrections reach policy

Create a fixed two-action Scenario:

1. evaluate with default weights in softmax mode;
2. apply one or more plan 007 human reorder corrections;
3. evaluate again with persisted weights;
4. assert the relevant normalized pair deltas, `P_ours`, at least one affected
   `P_theirs(*|h)`, and `roundScore` change in the expected direction;
5. assert opponent probabilities still favor exactly `-D`;
6. reset and assert the default deltas, distributions, and round score return.

This is the end-to-end check that the model is elastic rather than a UI-only
weight editor.

## Verification

```bash
npx vitest run packages/engine/tests/beliefs.test.ts packages/engine/tests/policy.test.ts packages/engine/tests/integration.test.ts packages/engine/tests/scenario.test.ts packages/engine/tests/weights.test.ts packages/cli/tests/decide.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli
```

Expected:

- every command exits 0;
- `P(h)` sums to one;
- every `P_theirs(*|h)` and `P_ours` sums to one;
- reply display marginals sum to one and report separate availability;
- rare-set-only actions retain their prior availability mass;
- compatible manual override assumptions have mass one;
- opponent policy favors negative-for-us pair deltas;
- every legal our action is represented with no 32-pair cap;
- `roundScore` equals the stated weighted sum and lies in `[-1,+1]`;
- a persisted human correction can change pair values and policy ranking;
- no hidden set contents appear in live JSON.

## Drift checks

Before implementation:

1. Confirm active hypotheses are still merged by `pairKey(ourId,theirId)`.
2. Confirm `meanCell` still divides away cell mass.
3. Confirm `pTheir` is still one unconditional vector.
4. Confirm `JOINT_CAP`, `capJointPairs`, and `marginalize` still exist.
5. Confirm manual `slot.set` is still ignored when public hypotheses exist.
6. Confirm `evaluateJointStatePolicy` still reconstructs `pOur × pTheir`.

If plan 007 changed internal cell types, adapt this plan to its shared branch
score without reintroducing a second scorer.

## Escape hatches

- If an action is legal in one hypothesis and illegal in another, keep it
  conditional. Do not convert illegality into zero utility.
- If a manual override conflicts with revealed facts, plan 003's boundary must
  reject it before evaluation. Do not assign it partial mass here.
- If separate QAOA calls exceed live latency, benchmark and reduce the fixed
  iteration count or keep the existing explicit softmax benchmark mode. Do not
  silently cap legal actions.
- If actor perspective is ambiguous in a field, add a side-swap test and name
  the perspective in the field; do not guess by negating at call sites.
- If a hidden species would need an action, return an unknown frontier for plan
  009. Do not generate a species.

## Maintenance

The hypothesis-conditioned policy is the sole source of opponent weights.
Reviewers should reject unconditional reply unions, availability represented
as a zero-score branch, manual assumptions ignored in favor of display
candidates, opponent utilities with our sign, capped legal grids, or product
“joint” distributions that discard the hypothesis condition.
