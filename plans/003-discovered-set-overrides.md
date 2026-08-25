# 003 — Discover, edit, and persist assumed sets

**Status:** TODO  
**Commit:** `a400fd1`  
**Effort:** M  
**Risk:** Medium — bad assumptions directly affect simulations  
**Depends on:** 002

## Why

Public Random Battle data provides candidate sets, not the hidden opponent's true team. The current live path chooses the most frequent compatible set and cannot be corrected from the browser. The requested workflow needs:

- a visible distinction between revealed facts and an assumed full set;
- candidate sets from the existing empirical pool;
- a small editor for item, ability, moves, level, nature, and Tera type;
- persistence shared by the Vite server and the separately spawned live CLI.

Do not claim public data reveals unrevealed Pokémon or exact hidden sets.

## Current state

[`packages/bridge/src/protocol.ts`](packages/bridge/src/protocol.ts) creates opponent hypotheses from only the latest move and selects the first hypothesis:

```ts
const facts = {
  species: m.speciesId,
  moves: m.lastMove ? [m.lastMove] : [],
};
let hypotheses: SetHypothesis[] = [];
try {
  hypotheses = initialBelief(pool, facts);
} catch (err) {
  console.error(`[pokeredus] ${err instanceof Error ? err.message : err}`);
}
// ...
set: hypotheses[0]?.set,
```

[`packages/engine/src/beliefs.ts`](packages/engine/src/beliefs.ts) already has the correct candidate filtering boundary:

```ts
export function initialBelief(pool: RandomSetPool, facts: RevealedFacts): SetHypothesis[] {
  return updateBeliefs(hypothesesForSpecies(pool, facts.species), facts);
}
```

[`packages/web/server/games.ts`](packages/web/server/games.ts) already owns the live CLI process and passes shared-file locations through environment variables:

```ts
const env = {
  ...process.env,
  POKELINK_STATE: this.liveStatePath(),
  POKEREDUS_WEIGHTS: path.join(this.root, 'score-weights.json'),
};
```

[`packages/web/src/pages/BattleLive.tsx`](packages/web/src/pages/BattleLive.tsx) renders six slots but does not expose set provenance or editing.

## Contract

### Truth labels

Use these labels consistently:

- **Revealed** — a fact observed from the Showdown protocol.
- **Assumed** — the full `CanonicalSet` currently used for simulation.
- **Public candidate** — a compatible row from the generated Random Battle pool.
- **Incomplete assumptions** — one or more required team slots has no full set.

Never label candidate frequency, QAOA mass, or a manual selection as certainty/confidence.

### Persistence

Add a local, ignored file at repository root:

```text
set-overrides.json
```

Allow `POKEREDUS_SET_OVERRIDES` to replace that path, matching the weights/live-state pattern.

Use the minimum versioned shape:

```json
{
  "version": 1,
  "overrides": {
    "gen9randombattle": {
      "garchomp": {
        "species": "Garchomp",
        "level": 80,
        "item": "Leftovers",
        "ability": "Rough Skin",
        "moves": ["Earthquake", "Dragon Claw", "Swords Dance", "Stone Edge"],
        "nature": "Jolly",
        "teraType": "Steel"
      }
    }
  }
}
```

One override per format + species is intentional:

```ts
// ponytail: Random Battles do not contain duplicate species; move to room+slot assignments if another format needs them.
```

Do not edit the generated pool. Add `set-overrides.json` to `.gitignore`.

## Implementation steps

### 1. Add a shared validated store

Create [`packages/engine/src/set-overrides.ts`](packages/engine/src/set-overrides.ts) and export it from `packages/engine/src/index.ts`.

Implement only:

- `defaultSetOverridesPath()`;
- `validateCanonicalSet(raw)` returning a normalized `CanonicalSet` or throwing an actionable error;
- `loadSetOverrides(path?)`;
- `getSetOverride(store, format, species)`;
- `saveSetOverride(format, species, set, path?)`;
- `deleteSetOverride(format, species, path?)`.

Validation at this file boundary must enforce:

- non-empty species, ability, nature, and one to four non-empty moves;
- finite level in `[1, 100]`;
- strings only for item and optional Tera type;
- finite integer EV/IV entries in legal ranges when present;
- the stored species normalizes to the route/assignment species;
- no unknown top-level keys are copied into the saved object.

Use Node stdlib and existing engine types; add no dependency. Write atomically using a temporary sibling file followed by rename so a crash cannot truncate the user's assumptions.

### 2. Apply overrides when observations are built

Widen `BattleTracker.toObservation` in [`packages/bridge/src/protocol.ts`](packages/bridge/src/protocol.ts) to accept an override map/path alongside the pool and our sets.

For each revealed opponent slot:

1. build cumulative `RevealedFacts` as required by plan 002;
2. calculate compatible public hypotheses;
3. load the format+species override, if any;
4. reject the override for this observation if it conflicts with revealed facts, emit a visible warning, and continue with the top compatible public candidate;
5. otherwise set `slot.set` to the override and retain public hypotheses for display.

For our side, prefer the full set supplied by `--our-sets`; otherwise build the best complete set possible from the Showdown request. If nature/EVs remain unavailable, mark the slot incomplete instead of silently using Smeargle.

The CLI must reload the tiny override file on each request. No watcher or cache invalidation mechanism is needed.

Add `POKEREDUS_SET_OVERRIDES` to the environment passed by [`packages/web/server/games.ts`](packages/web/server/games.ts), and add a matching CLI flag only if tests or direct terminal use require it.

### 3. Expose candidate and override endpoints

Keep live-game APIs together in [`packages/web/server/games.ts`](packages/web/server/games.ts). Add:

```text
GET    /api/games/sets/:format/:species
PUT    /api/games/sets/:format/:species
DELETE /api/games/sets/:format/:species
```

`GET` returns:

```ts
{
  species: string;
  format: string;
  override?: CanonicalSet;
  candidates: Array<{
    set: CanonicalSet;
    count: number;
    probability: number;
    compatible: boolean;
  }>;
}
```

Sort candidates by probability descending, then existing `canonicalizeSet` order. Return all candidates available for that species; the browser can show the first few without losing data.

`PUT` accepts exactly `{ set: unknown }`, validates through the engine helper, and returns the saved normalized set. `DELETE` removes only that format+species override. Reject path traversal by normalizing format/species to IDs and never using route text as a filename.

Add typed calls and mirrored `CanonicalSet` fields to [`packages/web/src/lib/games.ts`](packages/web/src/lib/games.ts). Do not expose filesystem paths to the browser.

### 4. Carry provenance to live JSON

Extend [`packages/bridge/src/live-state.ts`](packages/bridge/src/live-state.ts) and the mirrored web types with:

```ts
setSource?: 'revealed' | 'manual' | 'public' | 'incomplete';
assumedSet?: CanonicalSet;
candidateProbability?: number;
setComplete: boolean;
```

`candidateProbability` means frequency in the generated pool and must be labeled that way. Do not call it confidence.

For unrevealed opponent slots, keep identity hidden and `setComplete=false`. Do not leak a sampled/generated species into the live UI.

### 5. Add the discovery drawer

In [`packages/web/src/pages/BattleLive.tsx`](packages/web/src/pages/BattleLive.tsx):

- make a revealed bench slot's set/provenance control a real button with a 44px target;
- open a right-side drawer, 320–480px on desktop and full-width on mobile;
- display revealed facts first, then a candidate select, then editable fields;
- use visible labels above inputs, a single-column form, and one primary `Save assumed set` action;
- include X, `Cancel`, Escape dismissal, focus trapping, and focus return;
- on Save, update the server, close the drawer, announce success, and let the next live poll reflect the recalculated decision;
- provide `Reset to public candidate` using DELETE;
- prevent changing the species field from this drawer.

Candidate selection fills the form but does not save until the primary action is used. Show inline validation on blur and server errors next to the form; never disable Save without explaining the invalid field.

Use existing custom CSS in [`packages/web/src/theme.css`](packages/web/src/theme.css); no Tailwind or modal library.

## Tests

1. `packages/engine/tests/set-overrides.test.ts`
   - valid round trip;
   - malformed/truncated file falls back visibly without data loss;
   - invalid level/moves/EVs rejected;
   - atomic rewrite preserves the previous file if rename/write fails;
   - format/species normalization.
2. `packages/cli/tests/protocol.test.ts`
   - compatible manual override wins over the public top candidate;
   - conflicting override is rejected for that observation;
   - no override retains existing public hypothesis behavior;
   - incomplete slots remain explicit.
3. Server handler tests, following any existing games/scenario handler pattern:
   - GET candidates;
   - PUT validation;
   - DELETE reset;
   - route text cannot escape the configured file.
4. `packages/cli/tests/live-state.test.ts`
   - provenance and completeness survive JSON mapping;
   - unrevealed identity remains hidden.

## Verification

```bash
npx vitest run packages/engine/tests/set-overrides.test.ts packages/engine/tests/beliefs.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/live-state.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli --workspace @pokeredus/web
npm run build --workspace @pokeredus/web
```

Browser checks:

1. Open a live battle with one revealed opponent.
2. Open its set drawer by mouse and keyboard.
3. Select a public candidate, edit Tera/moves, save, and verify the next snapshot shows `manual`.
4. Reveal a conflicting move and verify the UI warns and simulation falls back rather than using an impossible set.
5. Reset to public; verify the manual override disappears.
6. Repeat at 375px and 1440px; Escape closes and returns focus.

## Out of scope

- Guessing unrevealed species/team composition.
- Editing the generated public pool.
- Cloud synchronization, accounts, or per-room history.
- A generic form framework or new dependency.
- Terminal rollouts (plan 004) and forecast chart work (plan 005).

## Escape hatches

- If the Showdown request cannot produce a complete set for our side, keep `setComplete=false` and require `--our-sets` or the editor. Do not manufacture nature/EVs.
- If a manual override conflicts with newly revealed facts, preserve it on disk for future battles but do not apply it to the current observation.
- If Vite and the CLI resolve different roots, pass one absolute override path through `POKEREDUS_SET_OVERRIDES`; do not duplicate files.

## Maintenance

Reviewers should verify that every displayed full opponent set is labeled `Assumed`, every revealed fact remains immutable in the editor, and generated pool data is never rewritten. New formats with duplicate species must replace the documented format+species ceiling with room+slot assignment rather than silently sharing an override.
