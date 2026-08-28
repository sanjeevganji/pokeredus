# 006 — Reconstruct faithful simulator state and legal revenge switches

**Status:** TODO  
**Commit:** `b97a334`  
**Effort:** L  
**Risk:** High — every later score and rollout depends on this state boundary  
**Depends on:** implemented portions of 002  
**Supersedes:** unresolved simulator-state and forced-switch work in 002 and 004

## Why

The engine uses the official Showdown simulator, but it does not reconstruct the
observed mid-battle state faithfully. A counterfactual can therefore execute
with the wrong active Pokémon, revive cleared weather/terrain, restore a
consumed item, ignore current PP, or let a fainted active use a move instead of
choosing a revenge switch. These are upstream correctness defects: scoring
changes cannot compensate for a branch that never existed.

This plan repairs the shared observation → Showdown state → legal action
boundary before plans 007–009 consume it. Do not patch individual evaluators or
rollout callers.

## Current state at `b97a334`

[`packages/engine/src/sim.ts`](../packages/engine/src/sim.ts) packs parties in
stored slot order and accepts Showdown's default lead:

```ts
const [t1, t2] = packObservation(obs, theirSets);
const battle = new PS.Battle({ formatid: 'gen9customgame', seed });
// ...
battle.setPlayer('p1', { name: 'p1', team: p1Team });
battle.setPlayer('p2', { name: 'p2', team: p2Team });
```

`applyHp` then copies state by array index and omits accuracy/evasion, current
item/ability, move PP/disabled state, lock/trap state, and active Tera state:

```ts
p.boosts.atk = s.boosts.atk;
p.boosts.def = s.boosts.def;
p.boosts.spa = s.boosts.spa;
p.boosts.spd = s.boosts.spd;
p.boosts.spe = s.boosts.spe;
```

Cleared weather and terrain are resurrected from the previous snapshot:

```ts
const weather = normalizeWeather(idOf(battle.field?.weather)) || prev.weather;
const terrain = normalizeTerrain(idOf(battle.field?.terrain)) || prev.terrain;
```

Illegal choices are silently converted into unchanged branches:

```ts
try {
  battle.makeChoices(p1Choice, p2Choice);
} catch {
  // illegal in this hypothesized state — treat as no-op branch
}
```

[`packages/engine/src/actions.ts`](../packages/engine/src/actions.ts) derives
slot-based actions without treating a fainted active as a forced switch, then
falls back to Splash when no action exists:

```ts
if (moves.length) return [...moves, ...switches];
if (switches.length) return switches;
return [{ id: 'move:splash', type: 'move', moveId: 'splash' }];
```

[`packages/bridge/src/protocol.ts`](../packages/bridge/src/protocol.ts) captures
our request PP, but `toObservation` does not put `moveSlots`, `choiceLock`, or
`trapped` on the emitted slots. It also preserves a consumed item:

```ts
case '-enditem': {
  const mon = this.findMon(ev.side, ev.identity);
  if (mon && ev.item && !mon.item) mon.item = ev.item;
  break;
}
```

The engine typecheck passes. The combined engine/bridge typecheck fails because
[`packages/bridge/src/index.ts`](../packages/bridge/src/index.ts) star-exports
two public functions named `toId`, one from `protocol.ts` and one from
`lobby.ts`.

## Required invariants

1. `SlotSnapshot.slot` remains the stable external slot identity used by
   observations, action IDs, UI, logs, and rollouts.
2. The simulation may reorder its private packed party so the observed active
   is Showdown's lead, but every switch action must be translated through an
   explicit external-slot → packed-index map. Never mutate observation slot
   numbers to match a temporary simulator order.
3. Exactly the observed active is active on each non-terminal side. If the
   active is fainted, no move is legal and every healthy bench switch is
   `forced: true`, regardless of stale trap/choice-lock flags.
4. Only revealed, living bench Pokémon may be selected for opponent switches.
   Unrevealed species remain neutral and unavailable; this plan does not invent
   them.
5. `undefined` means an item/ability fact is unknown. An empty item string means
   it is known to be absent or consumed. Do not refill a known-empty item from
   the assumed set.
6. Current PP, disabled moves, choice lock, trap state, boosts including
   accuracy/evasion, status, HP, ability, item, Tera type/state, hazards,
   screens, weather, terrain, and Trick Room survive a reconstruction whenever
   the protocol exposes them.
7. A cleared field value remains clear after the branch. Missing information
   may remain unknown; stale information may not be substituted.
8. An illegal Showdown choice is a programming/data error with action IDs and
   state context. It is never a scored no-op.
9. Win/loss remains all-six fainted. A side with unrevealed, non-fainted neutral
   slots is not terminal.

## In scope

- `packages/engine/src/observation.ts`
- `packages/engine/src/actions.ts`
- `packages/engine/src/sim.ts`
- `packages/engine/src/evaluate.ts` only to reject/propagate invalid branches
- `packages/bridge/src/protocol.ts`
- `packages/bridge/src/index.ts` and/or `packages/bridge/src/lobby.ts` for the
  duplicate export
- `packages/engine/tests/actions.test.ts`
- `packages/engine/tests/integration.test.ts` or one focused `sim.test.ts`
- `packages/cli/tests/protocol.test.ts`

## Out of scope

- Move valuation, learned score weights, and effect metadata (plan 007).
- Opponent policy weighting and hypothesis aggregation (plan 008).
- Terminal rollout semantics and cache redesign (plan 009).
- Doubles, team preview optimization, non-Random-Battle formats, or duplicate
  species formats.
- A second damage, speed, or battle-mechanics model.
- UI changes or a new dependency.

## Implementation steps

### 1. Add failing state-reconstruction fixtures

Before production changes, add fixtures that fail at `b97a334`:

1. Build an observation whose active is slot 3 while slot 0 is alive. Assert a
   move is executed by slot 3 and a switch to external slot 1 reaches the
   correct Pokémon.
2. Set non-zero accuracy/evasion boosts and assert the cloned Pokémon has them.
3. Start with rain/terrain, use a clearing move, and assert `afterField` contains
   empty values rather than the previous values.
4. Give the active one move at 0 PP, one disabled move, and one usable move.
   Assert only the usable move is legal and PP decreases across a round.
5. Mark an item consumed and assert the packed/cloned Pokémon has no item.
6. Mark a Pokémon already Terastallized and assert its current defensive type
   and one-use legality survive reconstruction.
7. Mark the active fainted with two living revealed bench slots. Assert only
   two forced switch actions exist and no move/Splash exists.
8. Submit an intentionally invalid choice directly to `simulateRound`; assert
   it throws an error containing both action IDs.

Keep these deterministic with fixed Showdown seeds. Expected before the fix:
the active-slot, field-clearing, item, forced-switch, and invalid-choice tests
fail.

### 2. Build a simulation-only party layout

In `sim.ts`, replace the tuple-only packing path with the smallest internal
layout object needed for each side:

```ts
interface SimPartyLayout {
  packedTeam: string;
  packedIndexBySlot: Map<number, number>;
  slotByPackedIndex: number[];
}
```

For each side:

1. find the single observed active;
2. order the private packed party as active first, then remaining slots in
   stable `slot` order;
3. record both mappings;
4. pack the reordered sets;
5. translate `switch:<external slot + 1>` through
   `packedIndexBySlot` before calling Showdown;
6. map snapshots back to the original `SlotSnapshot.slot` order.

Reuse the repository's documented Random Battles no-duplicate-species
assumption for species matching only as a checked invariant. If duplicate
species are encountered, throw an actionable unsupported-format error instead
of guessing.

Do not expose simulator packed indices in `LegalAction`, live JSON, or scenario
files.

### 3. Restore all already-modeled Pokémon state once

Replace `applyHp` with one `applyPokemonState` boundary. It must apply:

- proportional HP/faint state and status;
- all seven boost keys, including accuracy/evasion;
- move PP and disabled flags by normalized move ID;
- known current item/ability, preserving unknown vs known-empty semantics;
- active Tera state/type;
- any Showdown-supported lock state required for the selected legal action.

Use public methods from pinned `pokemon-showdown@0.11.10` when available.
Direct internal assignment is acceptable only when:

1. no public API exists;
2. a focused round-trip test proves `Battle.toJSON`/`fromJSON` retains it; and
3. a `ponytail:` comment names the pinned-version ceiling and the upgrade path.

Trap and choice-lock facts must always constrain action enumeration. Do not
invent a volatile condition merely to make Showdown agree if the observed
source/condition is unknown.

### 4. Emit the state from the protocol boundary

In `protocol.ts`:

- retain each request move's `pp`, `maxpp`, and `disabled`;
- set `SlotSnapshot.moveSlots` for our active and any side where facts exist;
- carry `RequestActive.trapped` to the active slot;
- clear a consumed item's current value on `|-enditem|` while retaining enough
  revealed fact information for belief filtering;
- carry `terastallized` separately from `teraType`;
- clear choice lock when the request once again exposes multiple usable moves
  or the Pokémon switches out;
- reset boosts and temporary lock/trap state on switch as Showdown does;
- decrement inferred screen/field durations once per new turn and clear them on
  explicit end events.

The protocol does not reveal every duration or trap source. Keep unknown values
unknown and expose an assumption diagnostic if a default duration is used.
Do not claim inferred duration is observed truth.

### 5. Make forced/revenge legality shared

Refactor `legalFromSlots` so it derives:

```text
forced = active is missing, fainted, or hp <= 0
```

When forced:

- emit no moves;
- ignore stale trap and choice-lock flags;
- emit every living revealed bench switch with `forced: true`;
- return `[]` if no switch exists.

When not forced, retain PP/disabled/lock/trap/Tera checks. Remove the synthetic
Splash fallback from legal enumeration. A real assumed Splash remains legal if
it is in the set.

Make opponent action enumeration in `evaluate.ts` call this shared legality
logic after overlaying the active hypothesis. Do not maintain a second,
slightly different switch implementation.

### 6. Stop scoring invalid branches

Remove the catch-and-no-op behavior in `simulateRound`. Throw a typed error (or
an ordinary error with a stable prefix) containing:

- our action ID;
- opponent action ID;
- active external slots/species;
- Showdown's original error message.

`evaluateRound` may reject a branch only when the action was unavailable under
that specific set hypothesis and its probability mass is explicitly removed
and renormalized. Any other illegal choice must fail evaluation visibly.

Add a diagnostic count for hypothesis-unavailable actions. It must not be
reported as a zero-impact outcome.

### 7. Fix the bridge export baseline

There is one normalization implementation needed publicly. Prefer either:

- make `lobby.ts`'s `toId` private and reuse/import the protocol helper; or
- explicitly export aliases from `packages/bridge/src/index.ts`.

Search all callers first. Do not change normalization behavior while fixing the
name collision.

## Verification

Run after each numbered step's focused test, then run:

```bash
npx vitest run packages/engine/tests/actions.test.ts packages/engine/tests/integration.test.ts packages/cli/tests/protocol.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge
```

Expected:

- all commands exit 0;
- a non-zero observed active slot executes its move;
- external switch slot IDs select the same Pokémon before and after private
  simulator reordering;
- a cleared weather/terrain value stays empty;
- PP, disabled/current item, all boosts, Tera state, lock, and trap facts
  survive where modeled;
- a fainted active has forced switches and no moves;
- invalid choices throw instead of producing a no-op score;
- the duplicate `toId` TypeScript error is gone.

## Drift checks

Before implementation:

1. Confirm HEAD is still `b97a334` or re-read every cited function.
2. Confirm `simulateRound` still swallows `makeChoices` errors.
3. Confirm `snapshotField` still falls back to `prev.weather/terrain`.
4. Confirm `legalFromSlots` still returns synthetic Splash.
5. Confirm the bridge still fails on duplicate `toId`.

If any is already fixed, retain its regression test and remove only the
obsolete implementation step.

## Escape hatches

- If pinned Showdown cannot restore active Tera state faithfully through a
  tested API/internal field, STOP with a minimal two-type damage fixture. Do
  not approximate Tera damage.
- If private party reordering cannot translate switches without changing
  external slot identity, STOP with the active-slot fixture. Do not renumber
  observations.
- If a protocol fact is not observable, record it as unknown. Do not infer a
  consumed item, exact trap source, or extended screen duration.
- If a mechanic is lost across `toJSON`/`fromJSON`, disable that
  counterfactual and report the smallest failing fixture before proceeding to
  plan 007.

## Maintenance

The observation and simulator layout are the only state-reconstruction
boundaries. Future mechanics must be added there with a round-trip test.
Reviewers should reject caller-specific legality guards, hidden-species
invention, stale field fallback, swallowed Showdown errors, or simulator packed
indices leaking into public action IDs.
