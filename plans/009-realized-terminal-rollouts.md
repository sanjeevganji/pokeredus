# 009 — Roll out realized pair deltas to honest terminal/frontier outcomes

**Status:** DONE

Functional tests inject softmax/fake policy and a fake clock. The real-QAOA
benchmark (10s budget) completed 1/8 stratified samples (`partial`,
keep-opt-in). Live forecasting is behind `--forecast` and never blocks the
sent action.  
**Commit:** `b97a334`  
**Effort:** L  
**Risk:** High — multi-turn errors compound and can misstate win forecasts  
**Depends on:** 006, 007, 008  
**Supersedes:** unresolved terminal-rollout portions of 004 and 005

## Why

The repository has a stratified rollout loop, QAOA policy calls, caching,
Wilson intervals, progress callbacks, and live forecast fields. The loop does
not yet follow a realized battle:

- after simulating one pair, it adds the selected action's expected
  `choiceScore`, not the realized pair delta;
- future actions are sampled from independent marginals;
- set beliefs are not sampled and frozen consistently;
- unknown opponent slots are packed as Smeargle or copies of the active set;
- a rollout with no legal represented action is called a draw;
- functional completion depends on a ten-second wall-clock budget and currently
  flakes on this machine.

This plan consumes plans 006–008 without creating a second evaluator. It stops
at an explicit neutral hidden-team frontier rather than fabricating a species,
and reserves terminal win/loss outcomes for all-six elimination.

## Current state at `b97a334`

[`packages/engine/src/scenario.ts`](../packages/engine/src/scenario.ts) adds an
expected root choice score after simulating a concrete opponent reply:

```ts
const rootSim = simulateRound(obs, rootAction, rootOpp, seed);
let cumulativeScore =
  rootPolicy.evaluation.choices.find((c) => c.action.id === rootAction.id)?.choiceScore ?? 0;
```

It repeats the same mismatch on future turns:

```ts
const simRes = simulateRound(currentState, ourAct, oppAct, seed);
const choiceScore =
  statePolicy.evaluation.choices.find((c) => c.action.id === ourAct.id)?.choiceScore ?? 0;
cumulativeScore += choiceScore;
```

Future pairs are sampled independently:

```ts
const ourId = sampleAction(ourChoices.map((c) => c.id), statePolicy.pOur, rng);
const oppId = sampleAction(theirChoices.map((r) => r.id), statePolicy.pTheir, rng);
```

The terminal utility still uses the old six-point score:

```ts
const terminalUtility = cumulativeScore + 6 * (winInd - lossInd);
```

[`packages/engine/src/sim.ts`](../packages/engine/src/sim.ts) fills every
missing party position with `placeholderSet()` (Smeargle/Splash), and
`evaluate.ts` currently substitutes the active hypothesis for bench slots
without sets. Those placeholders are useful neutral observation sentinels but
must never become rollout combatants.

The cache key includes much current state, but excludes:

- hypothesis probabilities and manual/public assumption identity;
- modifier names/multipliers/remaining turns;
- current item, ability, Tera type, and some field durations;
- score weights and effect-valuation version/content;
- policy mode/options that change probabilities.

`validateAssumptionsComplete` correctly requires complete sets only for
revealed living combatants. Hidden slots should remain incomplete and lead to a
frontier, not a fabricated full-team simulation.

[`packages/bridge/src/live-state.ts`](../packages/bridge/src/live-state.ts)
already has `patchForecast`, but no live caller starts/cancels a dedicated
forecast and forwards progress.

## Rollout contract

### One sampled world per rollout

At rollout start, build a private `RolloutWorld`:

```ts
interface RolloutWorld {
  revealedSetBySideSlot: Map<string, CanonicalSet>;
  beliefKeyBySideSlot: Map<string, string>;
}
```

For every revealed living opponent slot:

1. compatible manual assumption wins deterministically;
2. otherwise sample exactly one compatible public hypothesis from normalized
   belief mass;
3. otherwise use the one complete selected set;
4. if none exists, return `incomplete-assumptions`.

Freeze that selected set for the whole rollout. Do not resample because the
Pokémon switches out and back in. Newly simulated revelations may filter a
world only if the selected set conflicts; that indicates a bug and must fail
the rollout visibly.

Our complete revealed sets remain fixed. Unrevealed opponent slots have no
species or set in `RolloutWorld`.

### Pair sampling

At each represented state, consume plan 008:

```text
sample our action from P_ours
sample active hypothesis/world consistently
sample opponent action from P_theirs(action | sampled hypothesis)
```

For a stratified root action, keep our root action fixed, then sample a
hypothesis and its conditional opponent response. Do not reconstruct or sample
`P_ours × P_theirs`.

### Realized score

Plan 007 must expose one pure/shared scoring entry point for an already
simulated result:

```ts
scoreRealizedPair(
  beforeObservation,
  ourAction,
  theirAction,
  simResult,
  scoreWeights,
  effectValuations,
): RealizedPairScore
```

It returns the exact normalized pair delta and attribution diagnostics for that
realized branch. Both one-round evaluation and rollout call the same scorer.

```text
cumulativeRealizedDelta =
  Σ realizedPairDelta for simulated rounds
```

Never add `ChoiceEvaluation.choiceScore`, `expectedRoundScore`, or policy
probability to this sum.

### Outcomes

Use distinct outcomes:

```ts
type RolloutOutcome =
  | 'win'
  | 'loss'
  | 'unknown-frontier'
  | 'turn-cap'
  | 'time-cap'
  | 'cancelled'
  | 'error';
```

- `win`: every one of the six opponent slots is revealed/known and fainted,
  including slots that were unrevealed earlier in the rollout. If any slot
  remains unrevealed, the rollout cannot be a win.
- `loss`: all six of ours are fainted.
- `unknown-frontier`: the next legal state requires an unrevealed species/set,
  or all revealed opponent combatants are exhausted while unrevealed slots
  remain.
- `turn-cap` / `time-cap`: safety limits, not hidden-team draws.
- `cancelled`: preserve completed samples and stop.
- `error`: invalid state/choice; preserve completed samples and report it.

Terminal outcome utility:

```text
win  = +1
loss = -1
```

No win/loss bonus is added to cumulative score. Non-terminal outcomes retain
their `cumulativeRealizedDelta` separately and never receive a terminal label.
`terminalUtility` for ranking is `+1/-1` for terminal outcomes and the bounded
cumulative delta for a frontier/cap. Consumers must inspect `outcome`; a
frontier numeric score is not a win probability.

### Hidden frontier neutrality

An unrevealed slot remains a full-health neutral placeholder in the observation
for six-slot state accounting. It contributes no invented move, item, ability,
or species. When that information is required to continue, stop with
`unknown-frontier`.

Do not:

- switch to Smeargle;
- copy the active set into another slot;
- sample an unrevealed species from the global pool;
- mark the frontier as a win, loss, or ordinary draw.

## Data contract

Extend forecast records additively:

```ts
interface ChoiceForecast {
  // existing fields
  unknownFrontiers: number;
  turnCaps: number;
  timeCaps: number;
  errors: number;
  expectedCumulativeDelta: number;
}

interface BattleForecast {
  // existing fields
  outcomeCounts: Record<RolloutOutcome, number>;
  terminalSamples: number;
  winRate: number | null;
  frontierReason?: string;
}
```

Keep `wins`, `losses`, `draws`, and `capped` temporarily for live schema
compatibility:

- `draws = unknownFrontiers + turnCaps + timeCaps`;
- `capped = turnCaps + timeCaps`;
- label these compatibility aggregates as deprecated in types;
- UI, tests, policy, and ranking logic must read `outcomeCounts`; `draws` is
  only a compatibility alias and must not regain decision semantics.

`winRate` is the empirical terminal win rate:

```text
terminalSamples = wins + losses
winRate = wins / terminalSamples
```

The Wilson interval uses the same `terminalSamples` denominator. When
`terminalSamples == 0`, both `winRate` and its interval are `null`/absent, not
zero. `unknown-frontier`, `turn-cap`, and `time-cap` are neutral unresolved
outcomes and appear only in `outcomeCounts`, completion/resolution diagnostics,
and `expectedCumulativeDelta`; they are neither wins nor Bernoulli failures.
Cancelled/error samples are also excluded. This is empirical under represented
beliefs, not QAOA confidence.

Set `BattleForecast.status` to:

- `complete` when the requested stratified samples ended in represented
  outcomes, including unknown frontiers;
- `partial` for time cap before requested samples complete;
- `cancelled` for cancellation;
- `incomplete-assumptions` before sampling;
- `error` only when no useful result can be returned.

## In scope

- `packages/engine/src/scenario.ts`
- `packages/engine/src/evaluate.ts` only to call/export plan 007's shared
  realized scorer and consume plan 008 policy
- `packages/engine/src/sim.ts` only for rollout-world set injection from plan
  006
- `packages/engine/src/observation.ts`
- `packages/engine/tests/scenario.test.ts`
- `packages/engine/tests/integration.test.ts`
- `packages/engine/tests/forecast.bench.ts`
- `packages/bridge/src/live-state.ts`
- live orchestration in `packages/bridge/src/decide.ts` or
  `packages/cli/src/cli.ts`, whichever already owns the turn/process lifetime
- corresponding focused bridge/CLI tests

## Out of scope

- Inventing hidden opponent species/team composition.
- Exact exhaustive search.
- Training weights from rollout wins/losses; human correction remains plan
  007's only learning input.
- Replacing QAOA with softmax while labeling the result quantum.
- A new cache, statistics, worker, or UI dependency.
- Redesigning the live forecast UI; existing plan 005 fields are reused.
- Doubles or non-Random-Battle formats.

## Implementation steps

### 1. Add failing realized-score and frontier tests

Before modifying the loop, create deterministic fixtures:

1. A root action has two opponent replies with different pair deltas. Force the
   worse reply with a seeded/fake policy and assert the rollout adds that
   realized pair delta, not the root action's expected score.
2. On a second turn choose a different pair and assert cumulative score equals
   the sum of the two realized deltas.
3. A 90/10 active-set belief is sampled once and remains the same after
   switch-out/switch-in.
4. A manual set override is never resampled from public hypotheses.
5. Exhaust all revealed opponent combatants while one hidden slot remains;
   assert `unknown-frontier`, zero fabricated switches, and no win.
6. Reveal and faint all six opponent slots; assert `win` and utility `+1`.
7. Faint all six of ours; assert `loss` and utility `-1`.
8. Turn cap, time cap, cancellation, and error have distinct counts/status.
9. Two states differing only in modifier duration, item, belief mass, learned
   weight, or valuation metadata do not share a cache key.
10. Unknown/cap outcomes do not enter `terminalSamples` or the Wilson
    denominator; zero terminal samples yields a null win rate/interval, and the
    deprecated `draws` alias exactly matches its documented sum.

Use injected fake policy transforms for functional tests. Keep real QAOA in the
benchmark only.

### 2. Extract and reuse realized pair scoring

From plan 007's branch scorer, expose the smallest pure function that accepts a
specific `RoundSimResult`. `evaluateRound` must call it before aggregating
chance/hypothesis branches; `forecastBattle` calls it after each sampled
simulation.

Add a parity test:

```text
one represented deterministic branch:
  evaluateRound pair delta == scoreRealizedPair delta
```

If parity fails, fix the shared scorer. Do not special-case rollouts.

### 3. Sample and freeze rollout beliefs

Add a pure helper that builds `RolloutWorld` from an observation and seeded RNG.
Reuse plan 008's assumption precedence and `canonicalizeSet`.

Store selected sets by stable side + external slot, not active array index.
Pass the selected sets explicitly to simulation every round. After state
transition:

- preserve selected set identity;
- preserve manual/public provenance for diagnostics;
- collapse internal rollout hypotheses to the selected world only;
- never serialize the sampled hidden assumption to live output beyond already
  revealed facts.

Different root samples may choose different public hypotheses according to
belief mass. One sample may not change worlds mid-rollout.

### 4. Classify terminal vs unknown frontier before policy evaluation

Add one pure classifier called:

1. after every simulated round;
2. before requesting a policy at a future state.

Order:

1. all six opponent slots are known and fainted → win; any unrevealed slot
   prevents this classification even if every revealed opponent is fainted;
2. all-six ours fainted → loss;
3. forced active replacement exists among revealed living slots → continue;
4. replacement requires an unrevealed slot → unknown frontier;
5. normal legal actions exist → continue;
6. otherwise → error with state diagnostic.

Do not use “no choices” as an ordinary draw.

### 5. Sample plan 008's conditional policy

At root:

- allocate stratified samples to every our action as today;
- sample one active hypothesis/world consistent with that action's represented
  policy;
- sample opponent response from `P_theirs(*|h)`.

At future states:

- sample our action from `P_ours`;
- use the frozen world's active hypothesis;
- sample opponent response from that hypothesis's conditional distribution.

Delete future independent `pTheir` sampling and old `jointProbs` lookup.
Assert every sampled ID is legal in the frozen world.

### 6. Accumulate realized deltas and classify samples

For each simulated round:

1. score the concrete result with `scoreRealizedPair`;
2. add only its `pairDelta`;
3. apply the simulator result from plan 006;
4. classify outcome/frontier;
5. record turns, cumulative delta, terminal utility, selected hypothesis keys,
   and any unattributed residual diagnostic.

Replace the `+6 × terminal indicator` formula. Terminal utility is exactly
`+1/-1`; no old `[-6,+6]` scale remains.

Ranges and means use actual sample records. Keep min ≤ mean ≤ max and expose
sample counts.

### 7. Make cache keys complete and testable

Extract/export the cache-key helper for tests. Include:

- stable external slot identity and active flag;
- HP/max HP, status, all boosts;
- current item, ability, Tera type/state;
- PP/max PP/disabled, lock, trap;
- modifier name/multiplier/remaining turns;
- all field conditions and durations from plan 006;
- manual/public assumption and normalized hypothesis keys/probabilities;
- both Tera-used flags;
- learned `ScoreWeights`;
- effect-valuation content/version;
- policy mode, shots, and options that affect distribution.

Canonicalize object/map order. A cache hit may reuse an evaluated policy only;
it may not reuse a sampled hypothesis, action, RNG result, or terminal outcome.

If a relevant value cannot be included safely, disable caching for that state
and report a diagnostic.

### 8. Make tests independent of wall-clock QAOA latency

The current focused baseline has 44 tests: 43 pass and the real-QAOA integration
test expects `complete` but receives `partial` after the default 10-second
budget.

Change functional tests to inject a deterministic fake policy and either an
injectable clock or a generous explicit budget. Test time-budget semantics with
a fake clock, not machine speed.

Keep `packages/engine/tests/forecast.bench.ts` as the only real-QAOA performance
gate. It must print:

- cold/warm transform latency;
- time to one complete stratified cycle;
- rollouts/second;
- cache hits/misses;
- unknown-frontier count;
- requested/completed sample counts;
- final status and elapsed time.

Do not assert a universal runtime that the supported machine cannot meet.
Record whether live forecasting remains opt-in based on measured results.

### 9. Wire progressive forecasts outside the live decision path

Reuse `LiveStateWriter.patchForecast`. In the existing CLI/bridge owner:

1. send/sample the live one-round decision without awaiting forecast;
2. start forecast on a second `QuantumPolicyProcess`;
3. cancel/invalidate the prior turn when a new request arrives;
4. forward progress only when room/turn identity still matches;
5. close the dedicated process on detach/SIGINT;
6. preserve live decision operation if forecast errors.

If the Python process cannot cooperatively cancel an in-flight request, ignore
its stale result and restart only the forecast process. Never kill the live
decision process.

Map new outcome counts into existing live fields additively. Do not call unknown
frontiers or QAOA policy mass confidence.

## Verification

```bash
npx vitest run packages/engine/tests/scenario.test.ts packages/engine/tests/integration.test.ts packages/engine/tests/policy.test.ts packages/cli/tests/decide.test.ts packages/cli/tests/live-state.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli
npx vitest run packages/engine/tests/forecast.bench.ts
```

Expected functional results:

- all non-benchmark commands exit 0 without depending on local QAOA speed;
- fixed seed + fixed world produces identical sample records;
- cumulative delta equals the sum of realized pair deltas;
- beliefs are sampled once per rollout and manual assumptions remain fixed;
- future opponent actions are sampled conditionally on the frozen hypothesis;
- hidden slots produce `unknown-frontier`, never Smeargle/copy combatants;
- only all-six elimination produces win/loss;
- terminal utility uses `+1/-1`, not `+6/-6`;
- cache-key sensitivity tests all pass;
- stale forecast progress cannot overwrite a newer turn;
- live decision latency does not await forecasting.

Expected benchmark result:

- exits 0 after producing at least one stratified sample for every root action
  or clearly records why the configured time budget cannot do so;
- prints the required metrics and the opt-in/default recommendation;
- does not silently substitute softmax for a quantum run.

## Drift checks

Before implementation:

1. Confirm rollout still adds `choiceScore` after a concrete simulation.
2. Confirm future actions still sample independent `pOur` and `pTheir`.
3. Confirm terminal utility still adds `6 × (win-loss)`.
4. Confirm hidden slots still pack through `placeholderSet`.
5. Confirm cache key omits weights/valuation/belief mass.
6. Confirm no caller currently invokes `LiveStateWriter.patchForecast`.
7. Re-run the 44-test focused baseline and record whether the timing failure
   remains.

If plan 008 already changed policy result types, consume them directly rather
than adding compatibility reconstruction.

## Escape hatches

- If realized scoring differs from deterministic one-round scoring, STOP at the
  parity test and fix the shared scorer.
- If a rollout needs an unrevealed species to continue, emit
  `unknown-frontier`; do not sample or fabricate one.
- If a sampled public set conflicts with a later simulated revelation, mark the
  sample error and report the seed/world key. Do not switch hypotheses.
- If cache correctness is uncertain, disable caching for that state before
  benchmarking.
- If real QAOA cannot complete one stratified cycle within the configured
  budget, keep live forecasting opt-in and report the benchmark. Do not block
  live actions or relabel softmax as quantum.

## Maintenance

Forecasts are reproducible samples from explicit represented beliefs, not
ground truth about hidden teams. Reviewers should reject expected scores added
after realized simulations, mid-rollout belief resampling, independent
opponent marginals, hidden Smeargle/copy combatants, frontier-as-win/draw
claims, stale cache keys, or terminal bonuses on the obsolete six-point scale.
