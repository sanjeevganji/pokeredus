# 004 — Budgeted terminal rollouts with QAOA policy weights

**Status:** TODO  
**Commit:** `a400fd1`  
**Effort:** L  
**Risk:** High — exponential choice growth and quantum-process latency  
**Depends on:** 002, 003

## Why

The repository already has a bounded multi-turn simulator, but it is not a terminal forecast and does not run QAOA at future states:

```ts
export async function estimateWinrate(
  obs: BattleObservation,
  opts?: EvaluateOptions & { n?: number; maxTurns?: number; rng?: () => number },
): Promise<WinrateResult> {
  const n = opts?.n ?? 16;
  const maxTurns = opts?.maxTurns ?? 12;
  // ...
  const evalOpts: EvaluateOptions = { ...opts, chanceSeeds: opts?.chanceSeeds ?? 1, refine: undefined };
}
```

QAOA is currently a one-layer diagonal sampler over classical scores:

```py
costs = np.full(dim, PAD_PENALTY, dtype=float)
for i, s in enumerate(scores):
    costs[i] = -float(s)
```

It does not model battle transitions and its measured mass is not win probability or confidence. Build terminal forecasts from repeated official Showdown simulations, use QAOA only as the policy sampler at each represented state, and derive confidence from rollout samples.

## Scientific contract

1. A rollout is a seeded sequence of official Showdown rounds ending in win, loss, or a safety cap.
2. At each simulated state, all legal joint actions represented by plan 002 are scored. QAOA converts their classical scores into a joint policy distribution; it does not create those scores.
3. A QAOA cost/mixer depth is an optimization hyperparameter. A battle turn is a state transition and must not be described as a QAOA circuit layer.
4. Root choice quality is empirical:

   ```text
   terminalUtility = cumulativeTurnScore + 6 × (winIndicator - lossIndicator)
   rootCost         = -signedLog1p(E[terminalUtility])
   ```

   Six matches the score contract's maximum six one-point full KOs. Preserve raw utility in output.
5. `policyWeight` is QAOA output mass. `winRate` is wins/sample count. `confidence` is a statistical interval over rollout outcomes and always includes sample count.
6. Minimum and maximum are observed branch/rollout extrema, not theoretical guarantees.
7. Missing full sets, safety-cap draws, and stale/cancelled forecasts remain visible in output.

## Data contract

Add to [`packages/engine/src/scenario.ts`](packages/engine/src/scenario.ts), or a focused sibling only if the file becomes difficult to navigate:

```ts
export interface ForecastOptions extends EvaluateOptions {
  rolloutsPerChoice?: number;
  maxTurns?: number;
  timeBudgetMs?: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (partial: BattleForecast) => void;
}

export interface ChoiceForecast {
  actionId: string;
  samples: number;
  wins: number;
  losses: number;
  draws: number;
  capped: number;
  expectedTerminalScore: number;
  minTerminalScore: number;
  maxTerminalScore: number;
  winRate: number;
  winRateLow: number;
  winRateHigh: number;
  policyWeight?: number;
}

export interface BattleForecast {
  turn: number;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'incomplete-assumptions' | 'error';
  choices: ChoiceForecast[];
  totalSamples: number;
  elapsedMs: number;
  assumptionsComplete: boolean;
  diagnostics?: Record<string, unknown>;
  error?: string;
}
```

Do not serialize an `AbortSignal` or callback. Keep those local to the engine/bridge.

Extend `SlotSnapshot` only as required to carry simulation state that currently disappears between rounds:

- move PP/disabled state;
- choice lock/trap state when Showdown exposes it;
- active Tera state/type;
- plan 002's separate Tera-used flags;
- finite field/side-condition duration.

Do not store a raw Showdown `Battle` object in JSON.

## Implementation steps

### 1. Harden the policy process before multiplying calls

In [`packages/engine/src/policy.ts`](packages/engine/src/policy.ts):

- reject a Python response containing `error`, even if `probabilities` is an array;
- reject non-finite, negative, wrong-length, or zero-mass distributions;
- include a request identifier in errors and diagnostics;
- make decision and forecast timeouts explicit options instead of relying on one 5-second default.

In [`quantum-policy/pokeredus_quantum/solver.py`](quantum-policy/pokeredus_quantum/solver.py):

- keep the existing single-request payload compatible;
- add an optional batch payload only if profiling shows JSON/process overhead is material;
- return one diagnostics object per score vector;
- remove dead `QAOA_STEPSIZE`;
- retain exact mode as the correctness default.

Add tests for Python error payloads, illegal distributions, timeout cleanup, and batch/single equivalence if batching is added.

### 2. Make multi-round state transitions faithful

Extend [`packages/engine/src/sim.ts`](packages/engine/src/sim.ts) and [`packages/engine/src/scenario.ts`](packages/engine/src/scenario.ts) so `applySimResult` carries every field listed in the data contract.

`legalFromSlots` must:

- omit moves with zero PP or disabled state;
- respect forced switches and trapped state;
- include Tera move variants only while legal;
- enumerate opponent switches only among known, non-fainted assumed slots;
- fail with `incomplete-assumptions` rather than filling a missing set with Smeargle.

Use deterministic seeded RNG per rollout and turn. The same input observation/options/seed must produce the same forecast in exact QAOA mode.

### 3. Extract a reusable QAOA joint-state policy

Reuse `evaluateRound` and the joint pair construction from [`packages/engine/src/evaluate.ts`](packages/engine/src/evaluate.ts). Do not create a second scoring implementation.

Provide one internal function that:

1. receives a complete observation;
2. evaluates each legal our-action × opponent-reply pair using plan 002;
3. passes all represented pair IDs and `signedLog1p(pairTurnScore)` values to `QuantumPolicyProcess`;
4. returns the normalized joint distribution plus marginals;
5. guarantees every legal root action has represented mass.

Remove or redesign `JOINT_CAP=32`. If a hard cap remains necessary:

- first reserve at least one best pair per our action and per opponent action;
- fill remaining capacity by absolute score;
- report omitted pair count and omitted classical probability mass;
- mark the forecast `partial`;
- never silently renormalize an action out of existence.

### 4. Implement stratified terminal rollouts

Replace the internals of `estimateWinrate` by a shared terminal-rollout core while keeping its public result compatible for existing scenario callers.

For `forecastBattle`:

1. validate all required assumed sets before starting;
2. allocate at least one rollout to every root our action before adding samples to any action;
3. for a root action, sample the opponent reply from the QAOA joint distribution conditional on that action;
4. simulate the root round and add the realized plan-002 turn score to cumulative score;
5. at every following state, calculate the QAOA joint distribution, sample one pair, and simulate it;
6. stop on terminal win/loss, `maxTurns`, abort, or time budget;
7. record capped runs as draws and as `capped`, not as hidden failures;
8. emit progress after each completed stratification cycle, not every inner turn.

Cache future-state policy results within one forecast. The hash must include all score-relevant state: sides/slots, HP/status/boosts, PP, active slots, field durations, revealed/assumed sets, and both Tera-used flags. A cache hit may reuse a joint distribution; it must not reuse a sampled action or terminal outcome.

Use the stdlib Wilson score interval for `winRateLow`/`winRateHigh` with a documented 95% z-score. For wins/losses/draws, define the Bernoulli input as win versus non-win and report draws separately. Add no statistics dependency.

### 5. Compute final root Hamiltonian weights

After each root action has at least one sample, calculate:

```text
meanUtility(action) =
  mean(cumulativeTurnScore + 6 × (winIndicator - lossIndicator))

hamiltonianInput(action) = signedLog1p(meanUtility(action))
```

Send the root action IDs and Hamiltonian inputs through QAOA once to obtain `policyWeight`. This final root distribution is for forecast ranking. Keep it separate from the already sampled live action.

Expose diagnostics:

- raw and scaled utility per root action;
- n qubits, exact/shots, QAOA parameters, and expected cost;
- rollouts requested/completed/capped;
- cache hits/misses;
- omitted pairs/mass;
- elapsed time and cancellation reason.

Do not name these weights `confidence`.

### 6. Run forecasting outside the live decision critical path

In [`packages/bridge/src/decide.ts`](packages/bridge/src/decide.ts) or the live CLI orchestration in [`packages/cli/src/cli.ts`](packages/cli/src/cli.ts):

- send/sample the normal plan-002 decision without awaiting terminal forecasting;
- start a forecast for the same observation using a second `QuantumPolicyProcess`, so a slow forecast cannot queue ahead of a live decision;
- cancel or invalidate the old forecast when a new request/turn arrives;
- write progressive results through a callback that plan 005 will map to live JSON;
- close the forecast process on detach/SIGINT.

If the Python process cannot cooperatively cancel an in-flight QAOA request, mark its result stale and ignore it. Kill/restart only the dedicated forecast process; never interrupt the live policy process.

### 7. Benchmark before enabling defaults

Create the smallest runnable benchmark, for example:

```text
packages/engine/tests/forecast.bench.ts
```

It must print, for a fixed complete 6v6 scenario:

- cold and warm per-state QAOA latency;
- complete rollouts/second;
- cache hit rate;
- time to first partial result;
- total time for the proposed default budget.

Start with conservative configuration exposed through CLI/settings, not hard-coded UI assumptions:

```text
rolloutsPerChoice = 4
maxTurns = 64
timeBudgetMs = 10000
```

These are evaluation defaults, not promises. The executor must adjust them from measured results.

Performance gates:

- a partial containing every root action must appear before the configured time budget;
- live decision latency must be unchanged within measurement noise because forecast uses a separate process;
- memory must remain bounded by the per-forecast cache;
- if QAOA-per-state cannot produce one stratified cycle within 10 seconds on the supported machine, keep terminal forecasting opt-in and scenario-only until optimized. Do not substitute softmax while labeling the result quantum.

## Tests

1. `quantum-policy/tests/test_solver.py`
   - invalid payload and errors;
   - finite normalized outputs;
   - batch/single equivalence if batch exists;
   - diagnostics include cost/parameters.
2. `packages/engine/tests/policy.test.ts`
   - Python error payload rejected;
   - negative/NaN/wrong-length/zero distributions rejected;
   - timeout clears pending request.
3. `packages/engine/tests/scenario.test.ts`
   - deterministic forecast under fixed seed;
   - all root actions receive samples;
   - terminal wins/losses and capped draws counted;
   - Wilson interval contains win rate;
   - cancellation returns partial/cancelled, not throw away completed samples;
   - incomplete assumed sets stop before simulation.
4. `packages/engine/tests/integration.test.ts`
   - Tera is consumed once in a multi-turn path;
   - PP and field state survive consecutive rounds;
   - final policy weights normalize and are not copied into confidence fields.
5. `packages/cli/tests/decide.test.ts` or a focused live orchestration test
   - forecast does not delay/send a move;
   - stale progress from a prior turn is ignored;
   - forecast process closes on shutdown.

## Verification

```bash
npx vitest run packages/engine/tests/policy.test.ts packages/engine/tests/scenario.test.ts packages/engine/tests/integration.test.ts packages/cli/tests/decide.test.ts
python -m unittest discover -s quantum-policy/tests
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli
npx vitest run packages/engine/tests/forecast.bench.ts
```

Expected:

- functional tests exit 0;
- fixed-seed exact forecasts are repeatable;
- each root action has `samples > 0` before any action receives a second stratification cycle;
- `minTerminalScore ≤ expectedTerminalScore ≤ maxTerminalScore`;
- `winRateLow ≤ winRate ≤ winRateHigh`;
- policy weights sum to 1 but differ in name and source from confidence intervals;
- benchmark output records the default/opt-in decision.

## Out of scope

- Exact exhaustive game-tree search.
- A single circuit whose layers are labeled as battle turns.
- Quantum advantage or calibrated-amplitude claims.
- Training score weights from rollout outcomes.
- UI rendering (plan 005).
- Inventing hidden opponent sets (plan 003 supplies explicit assumptions).

## Escape hatches

- If a state transition loses a Showdown mechanic, STOP with a two-turn fixture before trusting terminal output.
- If state hashes cannot include a value that affects legality or score, disable caching for that state rather than accepting collisions.
- If QAOA-per-state misses the performance gate, retain results in Scenarios/opt-in mode and show the benchmark. Do not silently replace it with softmax.
- If the forecast process dies, preserve the live decision process and publish `status='error'` with completed sample count.

## Maintenance

Future policy implementations may replace QAOA only behind the same joint-policy contract. Reviewers should reject forecasts that block live action, omit legal root choices, hide capped draws, call QAOA mass confidence, or report min/max without sample counts.
