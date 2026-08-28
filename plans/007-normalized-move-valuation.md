# 007 — Normalize move valuation and learn from human reordering

**Status:** DONE  
**Commit:** `b97a334`  
**Effort:** L  
**Risk:** High — these values directly drive both side policies  
**Depends on:** 006  
**Supersedes:** unresolved CTA/CTS, modifier, and score-weight work in 002  

## Why

The current evaluator mixes CTA/TTK units, HP fractions, modifier deltas, and
switch state deltas. It exposes editable score weights and already has a
Scenario move-reordering UI, but the evaluator ignores those weights when it
sets `choiceScore`. Human corrections are persisted, yet cannot change the
ranking that the live model uses.

This plan makes one branch-tested move valuation trustworthy first, then
connects the existing reordering input to it as a small online preference
learner. “Self-learning” here means deterministic, bounded updates from explicit
human rankings saved across sessions. It does not mean autonomous training,
hidden labels, or a new ML dependency.

## Current state at `b97a334`

[`packages/engine/src/math.ts`](../packages/engine/src/math.ts) averages log
modifiers:

```ts
for (const m of mods) {
  const mult = Math.max(m.multiplier, EPS);
  s += Math.log(mult) * m.remainingTurns;
}
return s / mods.length;
```

Independent multiplicative effects should add in log space. Dividing by the
number of effects lets a neutral or weak effect dilute a strong one.

The same file clamps health and modifier value together, so setup at full HP
has no value:

```ts
return mon.L * clamp(mon.h + 0.5 * Math.tanh(mon.M), 0, 1);
```

[`packages/engine/src/evaluate.ts`](../packages/engine/src/evaluate.ts) scores
damage as `CTA / TTK`, then adds healing and modifier values in different units:

```ts
const ttk = expectedTtk(hpFrac(foe, foeIdx), dmgToFoe);
const dmg = tel.hit ? damageScore(success, ttk) : 0;
const heal = healSelf - healFoe - selfLost;
const value = finiteOrZero(dmg + heal + mod);
```

Most importantly, `assemble` receives weights as `_weights` and ignores them:

```ts
_weights: ScoreWeights,
// ...
const raw = finiteOrZero(mixed.turn);
```

The existing correction path is already constructed:

- [`packages/web/src/pages/Scenarios.tsx`](../packages/web/src/pages/Scenarios.tsx)
  provides drag-and-drop plus keyboard up/down reordering for both sides;
- [`packages/web/server/scenario-handlers.ts`](../packages/web/server/scenario-handlers.ts)
  sends ordered rows into `elasticUpdate`, saves `score-weights.json`, and
  reevaluates;
- [`packages/engine/src/weights.ts`](../packages/engine/src/weights.ts) performs
  bounded regularized pair updates;
- Scenario JSON retains `rankOurs` and `rankTheirs`;
- Reset-to-defaults already exists.

Because evaluation ignores weights, the reevaluation at the end of the request
returns the same score ordering.

Editable effect descriptions already exist in:

- `pokeredus/data/effects/moves.json`
- `pokeredus/data/effects/abilities.json`
- `pokeredus/data/effects/items.json`

They describe mechanics-like attributes, but there is no validated
battle-valuation schema or engine loader. Showdown must remain authoritative
for whether an effect is legal and what actually happens.

## Valuation contract

All values use our perspective unless explicitly marked as opponent
perspective.

### State components

For one side with six slots:

```text
health(side) =
  Σ clamp(currentHP / maxHP, 0, 1)

logModifier(slot) =
  Σ ln(multiplier) × probability × expectedTurns

modifier(slot) =
  0.5 × tanh(logModifier(slot))

modifier(side) =
  Σ modifier(living slot on side)
```

Composition is therefore:

```text
combinedMultiplier =
  exp(Σ ln(multiplier) × probability × expectedTurns)
  = product(multiplier ^ (probability × expectedTurns))
```

Do not divide the log sum by the number of modifiers. Health and modifier value
stay separate; neither is clamped into the other.

For one actor's attributed effects in a realized branch:

```text
actorHealthFeature =
  ((health(actorSideAfter) - health(actorSideBefore))
   - (health(foeSideAfter) - health(foeSideBefore))) / 6

actorModifierFeature =
  ((modifier(actorSideAfter) - modifier(actorSideBefore))
   - (modifier(foeSideAfter) - modifier(foeSideBefore))) / 6
```

These are actor-positive features: damaging the foe or healing/boosting the
actor is positive for either actor. `ChoiceEvaluation.features` contains our
actor-local features; `ReplyEvaluation.features` contains opponent actor-local
features. The rank handler must not flip them again.

Partition effects once:

- slot boosts, status, ability, and item future multipliers go to
  `modifierFeature`;
- hazards, screens, weather, terrain, and other side/field values go to
  `secondaryFeature`;
- immediate HP, recoil, and drain go to `healthFeature`;
- `switchRisk` and `sacrifice` are recomputed actor-locally from that actor's
  telemetry/outcome.

No effect may appear in two features. A whole-branch our-perspective net health
or modifier delta may remain as a diagnostic, but it is not a second score and
is not the feature vector used by `elasticUpdate`.

Apply the persisted `ScoreWeights` exactly once:

```text
conditionalValue =
  clamp(
      healthWeight × actorHealthFeature
    + modifierWeight × actorModifierFeature
    + secondaryWeight × secondaryFeature
    + sacrificeWeight × sacrificeFeature
    - switchRiskWeight × switchRiskFeature,
    -1, +1
  )
```

Every input feature must be finite and individually bounded to `[-1,+1]`
(`switchRisk` and `sacrifice` may use `[0,1]`). The final selected-action,
opponent-action, pair, choice, and round deltas are bounded to `[-1,+1]`.
`signedLog1p` remains a policy/display transform only.

### CTA and CTS

CTA and CTS are computed probabilities, not user-editable coefficients.

```text
CTA(move) =
  P(executes ∧ hit/succeeds ∧ actor alive at resolution)

moveScore =
  CTA × E[conditional attributed value | successful move]

CTS(switch) =
  P(legal switch completes)

switchScore =
  CTS × E[conditional attributed value | completed switch]
```

A forced legal revenge switch has `CTS=1`. A miss/fail/faint-before-action has
zero successful mass. Do not average zero-valued failure branches and then
multiply by CTA again.

Use action telemetry to attribute health/modifier/field changes. Recoil, drain,
and pivot effects may touch both sides. Residual effects that cannot be
attributed to either submitted action remain excluded from move score and
visible in diagnostics.

Compute both action values with the same actor-local scorer:

```text
ourActionScore =
  CTA_or_CTS × E[weighted our-actor features | success]

opponentActionScore =
  CTA_or_CTS × E[weighted opponent-actor features | success]

D(i,j,h) = PairScore.score =
  clamp(ourActionScore - opponentActionScore, -1, +1)
```

`D` is always our-perspective. `ChoiceEvaluation.choiceScore` is
`ourActionScore`; `ReplyEvaluation.choiceScore` is `opponentActionScore`.
Both are actor-positive `scoredChoice(...)` values used by the existing
reordering/correction workflow. Policy-expected utility across opposing
branches is a separate field computed by plan 008. Plan 007 must not choose an
opponent policy.

### Effect probability: apply it once

There are two valid paths:

1. If Showdown chance branches include “effect happened” and “effect did not
   happen”, use branch mass for the probability and use `probability=1` inside
   the realized effect branch.
2. If the one-round state cannot expose a future conditional effect, use the
   Showdown Dex/default or validated metadata override in `logModifier`.

Never apply both branch occurrence mass and the same metadata probability.
A 30% burn must be worth 30% of its conditional value, not 9%.

## Editable valuation schema

Extend existing entries additively with an optional `valuation` object. Do not
replace the existing graph/attribute fields:

```json
{
  "valuation": {
    "multiplier": 0.5,
    "expectedTurns": 3,
    "probabilityOverride": 0.3
  }
}
```

For entries with multiple effects, `valuation` may live on each effect object.
Semantics:

- `multiplier`: finite and greater than zero; `<1` is harmful to the affected
  side, `>1` is beneficial;
- `expectedTurns`: finite in `[0, 32]`;
- `probabilityOverride`: optional finite value in `[0,1]`;
- absent override: use Showdown Dex/simulation probability;
- absent valuation: neutral future valuation, with a diagnostic for an
  effectful but unvalued ID.

Add the smallest engine module warranted, for example
`packages/engine/src/effect-valuation.ts`, to load and validate all three files.
Use Node stdlib and existing ID normalization. Add no schema dependency and no
editor UI.

The loader must reject malformed explicit valuation with a path such as
`moves.scald.valuation.expectedTurns`. It must not silently coerce strings or
NaN. File edits may require process restart; a watcher is out of scope.

Showdown Dex/simulation remains authoritative for:

- move/ability/item mechanics;
- legality and target;
- accuracy and default secondary chance;
- immunities and conditions;
- actual HP, status, field, and boost transitions.

The editable JSON supplies future valuation only. For example, Life Orb's
immediate damage and recoil come from Showdown and must not be multiplied by
1.3 again.

## Human-correction contract

The existing Scenario list is the input. Preserve its drag, keyboard, reset,
and per-side workflows.

1. Top means “the actor should prefer this action” for both lists.
2. Our rows contain our actor-local features from the shared scorer.
3. Opponent rows already contain opponent actor-local features from the same
   scorer with the opponent passed as actor. Do not negate or flip them again
   in the rank handler or `weights.ts`.
4. The server accepts only a complete permutation of the currently evaluated
   legal action IDs: same length, no unknown IDs, no duplicates, no omissions.
5. Recompute each ranked row's score from its features and the current weights;
   do not trust a stale displayed `choiceScore`.
6. For each adjacent human-preferred pair, update only when the model violates
   the ordering/margin. Keep the existing small learning rate, shrinkage toward
   defaults, and `[WEIGHT_LO, WEIGHT_HI]` bounds.
7. One identical correction from the same starting weights is deterministic.
8. Save weights atomically using the existing Windows-safe temp/backup/rename
   pattern in `set-overrides.ts`.
9. Reevaluate with the new weights and return the updated ordering. The
   corrected pair's aggregate ranking loss must decrease, or diagnostics must
   explicitly report `boundHit` and/or `shrinkageDominated`.
10. Reset remains a full, visible rollback to defaults.

Do not add a training framework or a second feedback database. Persisted
`score-weights.json` is the learned model; saved Scenario `rankOurs`/
`rankTheirs` arrays are the existing correction record.

## In scope

- `packages/engine/src/math.ts`
- `packages/engine/src/evaluate.ts`
- `packages/engine/src/weights.ts`
- `packages/engine/src/observation.ts`
- `packages/engine/src/index.ts`
- one focused valuation loader file if needed
- export `scoreRealizedPair(before, ourAction, theirAction, simResult, weights,
  valuations)` for both `evaluateRound` and plan 009
- `packages/web/server/scenario-handlers.ts`
- `packages/web/src/lib/scenarios.ts` only for additive diagnostics/types
- the three `pokeredus/data/effects/*.json` files
- `packages/engine/tests/math.test.ts`
- `packages/engine/tests/weights.test.ts`
- `packages/engine/tests/integration.test.ts`
- one focused valuation/config test
- one small `packages/web/server/scenario-rank.test.ts` following the pure
  handler style in `packages/cli/tests/games-sets.test.ts`

## Out of scope

- Redesigning the existing reordering UI.
- Automatic learning from wins, losses, clicks, or sampled actions.
- Per-user/cloud models, correction history services, optimizers, or new
  dependencies.
- Reimplementing Showdown mechanics in JSON.
- Filling metadata for every ordinary damaging move; unvalued effects fall back
  neutrally and are diagnosed.
- Opponent policy/fixed-point aggregation (plan 008).
- Terminal rollouts (plan 009).

## Implementation steps

### 1. Replace mixed-unit helper tests first

Add failing tests for:

- two independent `1.5×` modifiers for two turns compose as
  `1.5^(2+2)`, not an average;
- adding a neutral `1×` modifier does not dilute another modifier;
- a positive setup modifier retains positive value at full HP;
- six-Pokémon health delta normalization and `[-1,+1]` bounds;
- side symmetry: swapping ours/theirs negates the delta;
- all empty/no-op branches are finite zero;
- terminal outcome is not injected into move value.

Remove or rewrite old assertions whose purpose is specifically
`damageScore = CTA/TTK`. Keep `hitsToKill` only as a display diagnostic if it
still has a caller.

### 2. Load and validate valuation metadata

Add representative `valuation` entries for:

- a guaranteed setup move;
- a chance status move such as Scald;
- a persistent field move such as Stealth Rock or Reflect;
- a conditional ability;
- a persistent/recovery item.

Implement a pure validator plus a stdlib loader. Tests must cover:

- defaults from Showdown when `probabilityOverride` is absent;
- explicit zero and one probability;
- multiplier `<=0`, probability outside `[0,1]`, non-finite values, and
  excessive/negative turns rejected;
- an absent entry returns neutral value plus a coverage diagnostic;
- a mechanics field is not mistaken for a valuation field.

Inject a registry through `EvaluateOptions` for tests. Production may load the
default registry once at the process boundary; do not read three files inside
every branch.

### 3. Calculate normalized branch features

In `math.ts`, make modifier composition a summed log and expose pure helpers for
the normalized health, slot-modifier, and side/field-effect deltas.

In `evaluate.ts`, replace `actorValue`'s CTA/TTK/HP addition with one branch
feature calculation. Preserve action telemetry attribution and explicitly
track:

- successful branch mass;
- conditional feature sums;
- failure/no-op mass;
- unattributed residual delta;
- metadata coverage warnings.

Aggregate conditional feature means first, multiply by CTA/CTS once, and clamp
the final score. Opponent action scoring must call the same function with
opponent side/foe inputs so it emits actor-local features; do not copy the
formula or negate an already actor-local vector.

Export that function as `scoreRealizedPair`. It returns both actor-local
scores/features and our-perspective `pairDelta`. `evaluateRound` calls it before
aggregation; plan 009 calls the same function after each concrete rollout
round.

Keep `hitsToKill` and raw HP parts only as diagnostics/UI fields. They must not
feed the normalized score.

### 4. Apply weights in the shared score path

Delete the `_weights` placeholder. The function that produces each
`ChoiceEvaluation.choiceScore` and `ReplyEvaluation.choiceScore` must reuse the
existing `weightedRaw`/`scoredChoice` helpers. `PairScore.score` is the clamped
difference of those actor-local action scores returned by
`scoreRealizedPair(...).pairDelta`. Do not add a second weighted scorer.

Assert:

- default weights preserve expected sign for representative damage, recovery,
  setup, status, switch-risk, and sacrifice cases;
- changing one weight changes only rows with a non-zero corresponding feature;
- all live, scenario, and rollout callers receive the same weighted scores;
- `expectedImpact` remains an unweighted diagnostic if retained and is labeled
  accordingly.

### 5. Make CTA/CTS branch probabilities

Replace the logistic `cts(afterSwitch, stay, forced)` helper. Compute both
probabilities from represented branch mass:

- move success requires executed, not missed/failed, and alive at resolution;
- switch success requires legal completion;
- forced legal switch returns one;
- unavailable/illegal branches were removed by plan 006 and contribute no fake
  zero outcome.

Add partition tests:

- 80% hit with conditional value `0.5` yields `0.4`;
- the same chance represented through branch mass and metadata-only probability
  yields the same value;
- the 30% example is not squared;
- faint-before-action has CTA and score zero;
- setup at full HP has positive score;
- a forced revenge switch has CTS one;
- min/mean/max stay within `[-1,+1]`.

### 6. Repair elastic updates

In `weights.ts`:

- compute model scores from current weights and supplied features;
- update adjacent inversions in the human order;
- consume already actor-local features for either list; do not flip opponent
  features in `weights.ts` or the rank handler;
- validate finite `lr` and `lambda`;
- retain default shrinkage and hard weight bounds;
- return diagnostics including `lossBefore`, `lossAfter`, changed keys,
  `boundHit`, and `shrinkageDominated`;
- write atomically by reusing/extracting the already-tested
  `set-overrides.ts` pattern, not a second unsafe implementation.

Tests must prove:

1. a human-preferred setup move moved above a raw-damage move increases the
   responsible modifier contribution;
2. an opponent-side correction follows opponent perspective, not ours;
3. repeated corrections reduce aggregate adjacent inversion loss until
   convergence, a bound, or an explicitly reported shrinkage-dominated step;
4. weights remain finite and within bounds after 1,000 synthetic corrections;
5. save/load round-trips and reset restores defaults;
6. the same input and starting weights produce the same output.

### 7. Validate and apply the existing reordering request

In `scenario-handlers.ts`:

1. evaluate with current weights;
2. choose our or opponent rows, which `evaluate.ts` already emits in
   actor-local feature space;
3. validate `order` as an exact permutation;
4. run the elastic update;
5. atomically save;
6. reevaluate with the returned weights;
7. save the accepted order on the Scenario;
8. return updated evaluation, weights, and learning diagnostics.

Invalid order input returns a 400 response without modifying either file.
Do not silently filter malformed IDs as the current code does.

Add a request-level test that reorders two deliberately separable choices and
asserts:

- the stored weight changes;
- reevaluated scores change;
- the human-preferred pair gap improves;
- reopening/reloading uses the learned weight;
- reset restores the original score ordering/weights.

## Verification

```bash
npx vitest run packages/engine/tests/math.test.ts packages/engine/tests/weights.test.ts packages/engine/tests/integration.test.ts packages/engine/tests/effect-valuation.test.ts packages/web/server/scenario-rank.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/web
```

Focused valuation/config tests live in `packages/engine/tests/effect-valuation.test.ts`.
The rank handler test is `packages/web/server/scenario-rank.test.ts`.

Expected:

- every command exits 0;
- all valuation and score outputs are finite and in `[-1,+1]`;
- modifier composition uses summed logs;
- CTA/CTS multiply conditional value once;
- setup at full HP retains value;
- malformed metadata and malformed ranking permutations fail visibly;
- a valid human reorder changes persisted weights and the reevaluated ranking;
- reset restores defaults;
- no new dependency or UI component is added.

This plan guarantees that learned weights change normalized
`choiceScore`/`PairScore.score`. Plan 008 must separately prove the same
persisted weights change `P_ours`, `P_theirs(*|h)`, and `roundScore`.

## Drift checks

Before implementation:

1. Confirm `meanModifier` still divides by `mods.length`.
2. Confirm `pokemonValue` still clamps `h + modifier`.
3. Confirm `assemble` still names the argument `_weights`.
4. Confirm Scenario rank requests still call `elasticUpdate` and reevaluate.
5. Confirm the three effect JSON files still have no validated `valuation`
   contract.

If the UI reordering control has moved, preserve its behavior and update only
the request/type path.

## Escape hatches

- If Showdown branch logs cannot distinguish whether a conditional effect
  occurred, STOP with one move/seed fixture. Do not apply both sampled and
  metadata probability.
- If an effect is already fully represented in HP/state, omit its metadata
  contribution and add a regression test; never double count.
- If a correction cannot reduce inversion loss because every responsible
  weight is at a bound or regularization dominates the step, return that
  diagnostic instead of exceeding bounds or claiming success.
- If changing weights still cannot change `choiceScore`, STOP and trace the
  shared scorer before touching policy code.
- If JSON location differs between source and packaged runtime, inject one
  resolved root at startup; do not copy the data files.

## Maintenance

The official simulator owns mechanics; the effect JSON owns editable future
valuation; `score-weights.json` owns learned human preferences. Reviewers should
reject duplicated mechanics, probabilities applied twice, TTK mixed into
normalized utility, direct unbounded weight edits, correction requests that
silently drop actions, or any evaluator path that bypasses the shared weighted
scorer.
