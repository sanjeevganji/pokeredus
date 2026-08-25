# 002 — Correct battle scoring, ranges, and Tera legality

**Status:** TODO  
**Commit:** `a400fd1`  
**Effort:** L  
**Risk:** High — this changes the values that drive the live policy  
**Depends on:** 001 (DONE)

## Why

The live theater is already present, but its inputs are not yet trustworthy enough for cumulative forecasting:

- the official Showdown counterfactual starts without the observed field;
- `pHit` and `pExecute` are hard-coded to 1;
- voluntary switch CTS is calculated by moving HP between two Pokémon;
- chance branches are collapsed to means before ranges can be reported;
- Tera is a display-only counterfactual and cannot be sampled by the live policy.

Fix these shared engine boundaries before adding rollout or UI logic. Do not patch individual callers.

## Current state

[`packages/engine/src/sim.ts`](packages/engine/src/sim.ts) returns stub execution evidence:

```ts
return {
  afterOurs,
  afterTheirs,
  afterField,
  pHit: 1,
  pExecute: 1,
  aliveAtExecution: oursAfterActive && hpBefore > 0 ? aliveAtExecution : 0,
  weWin,
  theyWin,
};
```

[`packages/engine/src/evaluate.ts`](packages/engine/src/evaluate.ts) implements voluntary switching by swapping HP:

```ts
const tmpHp = incoming.hp;
incoming.hp = outgoing.hp;
incoming.maxHp = outgoing.maxHp;
incoming.fainted = outgoing.fainted;
outgoing.hp = tmpHp;
```

[`packages/engine/src/actions.ts`](packages/engine/src/actions.ts) reads `canTerastallize` but emits only ordinary move actions:

```ts
for (const mv of req.active[0].moves ?? []) {
  if (!mv?.id || mv.disabled || mv.pp <= 0) continue;
  actions.push({ id: actionId({ type: 'move', moveId: mv.id }), type: 'move', moveId: mv.id, tera: false });
}
```

[`packages/engine/src/math.ts`](packages/engine/src/math.ts) already has the intended primitives and side-local parts:

```ts
export function cta(pExecute: number, pHit: number, aliveAtExecution: number): number {
  return clamp(pExecute * pHit * aliveAtExecution, 0, 1);
}

export function hitsToKill(hBefore: number, hAfter: number): number | null {
  const damage = hBefore - hAfter;
  if (!(damage > EPS) || !(hBefore > EPS)) return null;
  return Math.ceil(hBefore / damage);
}
```

## Score contract

Document this contract next to the implementation and in `README.md`:

1. Scores use our perspective. Positive is favorable to us; negative is favorable to the opponent.
2. Each simulated branch records effects attributed to each submitted action. A move contributes only effects it caused on the side it damaged, healed, or modified. Recoil and drain may legitimately affect both sides.
3. For a damaging action:

   ```text
   damageScore = CTA / expectedTTK
   CTA = P(executes) × P(hit | executes) × P(alive when action resolves)
   ```

   `expectedTTK` is at least 1 and is calculated against the target's current HP from damage in branches where the move hits. Therefore a guaranteed move that acts first and KOs from the current HP has `CTA=1`, `TTK=1`, and `damageScore=+1` for us (or `-1` for the opponent).
4. Effective healing is scored as restored HP divided by max HP, excluding overheal. Attribute passive end-of-turn healing separately from the selected move.
5. A modifier contributes the delta of:

   ```text
   modifierValue = 0.5 × tanh(mean(log(multiplier) × expectedRemainingTurns))
   ```

   Use actual known duration when Showdown exposes it. Otherwise retain the existing documented estimates in one place. Do not add weather as a blanket `1.5` modifier to every Pokémon.
6. Pair turn score is our attributed action value minus the opponent's attributed action value.
7. A switch follows the requested definition:

   ```text
   switchScore = stateScore(after switch round) - stateScore(before)
                 - attributedOpponentActionScore
   ```

   This includes entry hazards and other switch consequences produced by Showdown. Forced-switch success remains 1.
8. Keep raw scores in engine/live output. Use `signedLog1p` only for the Hamiltonian input and display scaling.

## Data contract

Extend [`packages/engine/src/observation.ts`](packages/engine/src/observation.ts) additively:

- Replace `BattleObservation.teraUsed` with `teraUsedOurs` and `teraUsedTheirs`. Read old `teraUsed` as `teraUsedOurs` while fixtures migrate.
- Add branch range fields to `ChoiceEvaluation` and `ReplyEvaluation`: `minTurnScore`, `maxTurnScore`, `meanPostScore`, `minPostScore`, `maxPostScore`, `sampleCount`.
- Add `expectedRoundScore`, `minRoundScore`, and `maxRoundScore` to `RoundEvaluation`. Keep `roundScore` as a temporary alias of `expectedRoundScore` until plan 005 migrates live snapshots.
- Keep `probability` as a policy weight, not confidence.

Inside [`packages/engine/src/evaluate.ts`](packages/engine/src/evaluate.ts), retain branch observations until after min/max/sample count are calculated. Do not derive a range from already averaged `PairCell` values.

`expectedRoundScore` must be weighted by the final joint policy distribution, not the current uniform mean over our legal choices. Minimum and maximum are the extrema of represented chance/hypothesis/reply branches and must report the sample count used.

## Implementation steps

### 1. Characterize the current boundary

Add focused tests before changing production logic:

- `packages/engine/tests/sim.test.ts` if a new file is warranted; otherwise extend `integration.test.ts`.
- A weather or screen changes damage in the cloned battle.
- Stealth Rock remains present after a no-change round and damages a switch-in.
- An 80%-accuracy move has lower CTA than a 100%-accuracy move across deterministic seeds.
- A faster guaranteed OHKO scores +1; a slower attacker that faints before moving has CTA 0.
- A 2HKO scores 0.5 when CTA is 1.

Expected before the fix: at least the field, accuracy, and slower-attacker assertions fail.

### 2. Restore the observed Showdown field

In [`packages/engine/src/sim.ts`](packages/engine/src/sim.ts):

- apply weather and terrain through Showdown's field APIs;
- apply Trick Room as the corresponding pseudo-weather;
- add hazards and screens through side-condition APIs to the correct p1/p2 side;
- preserve remaining screen turns where available;
- call these helpers after players are initialized and before HP/status snapshots are applied.

Do not assign undocumented internal objects directly when a Showdown method exists.

In [`packages/bridge/src/protocol.ts`](packages/bridge/src/protocol.ts):

- parse `|-sidestart|`/`|-sideend|` for Reflect and Light Screen as well as hazards;
- parse `|-fieldstart|move: Trick Room` and `|-fieldend|...` from the correct protocol field;
- retain all revealed opponent moves instead of overwriting one `lastMove`;
- carry revealed item, ability, level, and Tera type into `RevealedFacts` when the protocol provides them;
- remove the localhost debug ingest/log calls while touching this hot path.

### 3. Capture action execution evidence

Use the official battle's emitted protocol log after `makeChoices` to capture:

- whether each selected move was announced;
- which side acted first;
- whether it missed or failed;
- damage, healing, boost/unboost, status, recoil, drain, hazards, and residual events;
- which submitted action or field source caused each effect when Showdown tags it.

Add typed action telemetry to `RoundSimResult`; keep the raw battle log private to `sim.ts`.

If the pinned Showdown build does not expose enough event/source information to distinguish selected-action effects from residuals, STOP and report the missing event examples. Do not add a second damage or speed model.

### 4. Calculate side-local branch scores

In [`packages/engine/src/math.ts`](packages/engine/src/math.ts):

- add the smallest pure helpers needed for TTK-scaled damage, effective healing, and modifier delta;
- return finite values for empty/no-damage branches;
- keep all action values side-local before combining them into our perspective;
- delete `switchStayScores` once all callers use simulated post-switch state.

In [`packages/engine/src/evaluate.ts`](packages/engine/src/evaluate.ts):

- score every hypothesis × reply × chance branch with the contract above;
- aggregate mean/min/max/sample count only after branch scoring;
- use the same success semantics for our actions and replies;
- preserve every legal joint action when constructing QAOA input. If a cap is still required, aggregate omitted tail mass explicitly and keep each root action represented; never silently give an action zero probability because all its pairs were dropped.

### 5. Make Tera a real legal action

In [`packages/engine/src/actions.ts`](packages/engine/src/actions.ts):

- when `canTerastallize` is truthy and our Tera is unused, emit both ordinary and `:tera` variants for each enabled move;
- never add a Tera switch action;
- keep Tera variants absent after use.

Track both sides independently in protocol and simulation. `theirActions` may add Tera variants only when the opponent's Tera is unused and the assumed set has a Tera type.

In [`packages/bridge/src/decide.ts`](packages/bridge/src/decide.ts), remove separate unrefined `teraOurs`/`teraTheirs` policy paths after Tera is included in the main joint evaluation. The sampled `:tera` action must pass through `formatChoice` and send `terastallize`.

## Tests

Add or update:

1. `packages/engine/tests/math.test.ts`
   - OHKO + CTA, 2HKO, healing cap, modifier duration/sign, switch formula.
2. `packages/engine/tests/actions.test.ts`
   - Tera variants only while available; ordinary variants remain.
3. `packages/engine/tests/integration.test.ts`
   - field fidelity, branch ranges, asymmetric CTA, all scores finite.
4. `packages/cli/tests/protocol.test.ts`
   - screens, Trick Room, cumulative moves, item/ability/Tera facts, separate Tera-used flags.
5. `packages/cli/tests/decide.test.ts`
   - a sampled Tera action sends the correct command.

## Verification

```bash
npx vitest run packages/engine/tests/math.test.ts packages/engine/tests/actions.test.ts packages/engine/tests/beliefs.test.ts packages/engine/tests/integration.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/decide.test.ts
python -m unittest discover -s quantum-policy/tests
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli
```

Expected:

- all commands exit 0;
- a guaranteed faster OHKO is exactly +1 before logarithmic scaling;
- min ≤ expected ≤ max for every choice and round;
- Tera actions appear and can be sampled only while legal;
- no debug HTTP request or debug-log write remains in protocol/belief evaluation.

## Out of scope

- Terminal/full-battle rollouts (plan 004).
- Persisting manually selected opponent sets (plan 003).
- Live graph/UI changes (plan 005).
- A new damage calculator, speed model, chart library, or dependency.
- Claims that QAOA policy weights are win probabilities.

## Escape hatches

- If applying the observed field requires unsupported Showdown internals, STOP with the smallest failing fixture and exact missing API.
- If source attribution is ambiguous for a mechanic, expose it as residual/unattributed and exclude it from selected-action score; do not guess.
- If chance seeds do not cover deterministic accuracy outcomes, increase a test-local seed set first. Do not globally raise live latency without a benchmark.
- If old `teraUsed` snapshots are encountered, support them at the read boundary only; do not keep two internal truth fields.

## Maintenance

Any future effect that changes battle score must enter through simulator telemetry and the pure scoring helpers. Reviewers should reject caller-specific score patches, duplicated battle mechanics, ranges derived from means, or UI labels that call policy mass “confidence.”
