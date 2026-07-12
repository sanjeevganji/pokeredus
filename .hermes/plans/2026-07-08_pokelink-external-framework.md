# PokeLink — External Real-Time Intelligence Framework Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a TypeScript/Node external application that downloads PokeRedus knowledge as portable JSON "edges + biases", hosts a pluggable MCTS-style scoring engine, connects to a live Pokémon Showdown battle via websocket, and produces per-turn move recommendations — with the self-evolving intelligence deferred to a later phase (this plan delivers the framework it plugs into).

**Architecture:** Three strictly-separated tiers, matching the user's deployment/runtime-vs-knowledge/ondemand split:
1. **Knowledge Pack** — a one-time export from Python (PokeRedus) to a portable, immutable JSON artifact: species, sets, moves, type chart, ability/item tables, and pre-scored matchup edges ("edges"). Downloaded once, queried at runtime by a local store. Pure data — no logic.
2. **Runtime Engine** (TypeScript, runs in the browser/Node) — the fast path. Loads the Knowledge Pack into an in-memory index, receives a live game state from the battle adapter, and runs a configurable **MCTS-style scorer** with human-tunable biases to rank the 4–9 legal actions per turn in <50ms. Has no knowledge baked in — it only reads the pack and applies math.
3. **Showdown Bridge** — a lightweight websocket client (Node) that maintains a session on `play.pokemonshowdown.com`, parses the battle protocol into a normalized `TurnState`, feeds it to the Runtime Engine, and posts the chosen move back. Uses a minimal headless approach (no heavy browser automation — just the websocket protocol).

**Tech Stack:** TypeScript 5.x, Node 20+ (ESM), `ws` (websocket), `zod` (schema validation), `vitest` (unit tests), `tsx` (dev runner). No React, no Puppeteer, no Playwright — the user asked for a lightweight browser; Showdown's websocket protocol is lighter than DOM scraping and is the canonical real-time path.

---

## Deviation Log (Tier 1 & 2 — intentional, better than the plan)

**Tier 1 (export_knowledge_pack.py) — implemented as noted:**
1. `KnowledgeGraph.load_or_build()` doesn't exist. The exporter builds the KG the same way `build_graph.py` does (`KnowledgeGraph()` + `import_gen9ou`).
2. Edges: the plan suggested loading the 86MB cached matchup graph to reuse edges. `compute_matchup` runs at ~0.1ms/pair, so all 13,806 ordered edges compute in ~1s — recomputation is far cheaper than the 60s+ graph load. Faster and self-contained.
3. `primary_set_id` is never populated by the importer (empty on every Pokémon), so the exporter defines a deterministic "primary" set per species = the "Showdown Usage" stats-set, else the first set. This yields exactly 118 primary sets → 13,806 edges, matching the plan's target.
4. No git commits — per environment memory, this repo has no git tracking and git commands are avoided.

**Tier 2 (runtime engine) — implementation notes:**
- Tasks 5-7 (type-chart, damage, actions) were already stubbed in Tier 1; Tier 2 added their test files and verified them against the real mini pack (no Garchomp/Toxapex — they're absent from the mini pack; tests use the actual 5 species: Venusaur, Clefable, Ninetales, Ninetales-Alola, Arcanine-Hisui).
- BUG FIX in `engine/damage.ts`: the built-in item modifiers (Choice Band / Specs / Life Orb / Eviolite / Assault Vest) compared raw item strings against hyphen-free ids (`'choiceband'`) but the pack stores hyphenated ids (`'choice-band'`). Added a `normItem()` helper that lowercases + strips hyphens before compare. Choice Band/Specs correctly boost the offensive stat now; Life Orb correctly multiplies damage.
- `leaf.ts`: a faithful port of `pick_best_move` (move scoring) and `find_optimal_switch` (switch scoring). The 3D-distance tiebreak from the Python scorer is approximated with a bulk-metric surrogate (HP+def+spd) — a stable monotone proxy; the full `project_to_3d` can be ported later if needed (marked `ponytail:` ceiling comment).
- `scorer.ts`: MCTS-style bounded search. Children are populated into `ScoredAction[]` when `rollout_depth > 0`. The `flipSide` helper reuses the same TurnState for the opponent's reply (a v1 simplicity — we assume perfect information; the bridge can refine this with opponent.team revelation later).
- `biases/`: schema exports a `Biases` type; `defaults.ts` re-exports `DEFAULT_BIASES` (test imports `type Biases` from `schema.ts`). The loader prints overridden keys at load time — a human-tuning audit trail.
- Tier 2 verification: **59 tests pass across 9 files** (`npm test`). `npx tsc` is clean for all Tier-2 files (pre-existing `index.ts` quirks under `noUncheckedIndexedAccess` are Tier 1 carry-over).

**Tier 3 (Showdown Bridge) — implementation notes:**
- Tasks 11-14 implemented and verified; Task 15 is the manual live doc (`docs/LIVE_SETUP.md`).
- `protocol.ts`: Showdown effect messages use a leading dash (`|-damage|`, `|-boost|`, `|-status|`, `|-start|`, `|-end|`, `|-heal|`, `|-unboost|`), so `BattleEvent` discriminators carry the dash (e.g. `'damage'` → `'-damage'`). The bridge parser strips room prefixes (`battle-xxx|…`) and `|split|` wrappers.
- `BattleTracker` is the stateful accumulator (singles-only; one active slot `pXa` per side). It folds events into `TurnState` on demand; `battleStateFromEvents` is the one-shot reducer the plan names. `resolveSetId` maps Showdown species ids (hyphen-stripped, e.g. `arcaninehisui`) onto pack sets (`arcanine-hisui_…`) via `PackIndex.primaryBySpecies`.
- `client.ts`: `ShowdownClient` over `ws` — handles `|challstr|`→`|/trn` (guest or named via `auth.ts` `getAssertion`), auto-joins `battleRoom`, fans out `BattleEvent`s. `decide.ts` wires `scoreTurn` → top-3 log + `|/choose …` post (dry-run logs only).
- `cli.ts`: `render-pack` / `score --replay` (offline, never connects) / `live --battle` (websocket). Lib-only arg parsing (no yargs).
- Tier 3 verification: **65 tests pass across 12 files**; `npx tsc --noEmit` clean; `score` replay on the mini-pack produces a correct top move (Sludge Bomb SE×2 vs Clefable). Live guest battle not run here (documented in `docs/LIVE_SETUP.md` step 5).

---

## Context & Assumptions

### What PokeRedus already has (the source of truth)
- **`pokeredus/unified/__init__.py`** (~1050 lines): `UnifiedState`, `UnifiedAction`, `UnifiedTeamSlot`, `render_scene()`, `recommend_actions()`, `export_training_corpus()`. This is already the bridge between the KG and a textual/JSON model — the external app will consume the *output* of this layer, not reimplement it.
- **AI queries** (`graph/matchup_graph.py:534` `pick_best_move`, `:657` `find_optimal_switch`, `:800` `analyze_game_state`): deterministic heuristic scorers. These return ranked `MoveRanking` / `SwitchRanking` / `TurnPlan` dataclasses with reasoning strings. The external MCTS scorer will *mirror* these as its rollout heuristic policy.
- **`DataResult`** (`graph/damage_calc.py:35`): the damage model — base power, stab, type eff, min/max damage, ttk range, etc. This is the physics the external engine must reproduce for its rollout *without* calling Python at runtime.
- **`GameState` / `PokemonState` / `FieldState`** (`graph/game_state.py`): the dynamic battle model (HP, boosts, status, weather, terrain, hazards).
- **`scripts/export_training_data.py`**: already exports `TrainingSample` JSONL (scene_text, action_text). We extend this *concept* to export the Knowledge Pack.
- **Data on disk**: `data/raw/moves.json` (954 moves, Showdown shape), `data/raw/base_stats.json` (species), `data/raw/abilities.json`, `data/raw/items.json`, `data/sets/**/showdown_usage.yaml` (per-species sets), `data/graphs/ou_matchup_graph.json` (~89MB, the full scored edges).

### What the user explicitly said to defer
> "THIS WE WILL IMPLEMENT LATER BUILD THE REST AS A FRAMEWORK FOR THE INTELLIGENCE."

So the **self-evolving learning loop** (policy gradient, reward assignment, weight updates) is OUT OF SCOPE for this plan. What IS in scope: the interface that future intelligence plugs into — a serialized "biases" blob that the scorer reads, and a `Biases` editor surface so a human can hand-tune while the auto-learner is absent.

### Key design constraints (from the user)
- **Downloadable intelligence**: the scorer's weights/edges must be a file you can download and drop in. → biases live in a JSON file, versioned, loaded at boot.
- **Real-time**: the runtime path must be fast. → pre-index the Knowledge Pack at load; never recompute the type chart; cap MCTS simulations.
- **Knowledge vs. runtime split**: "knowledge based and predefined rules and calculations that is needed on demand" vs. "code that runs efficiently in real time". → The Knowledge Pack is the former (precomputed, immutable); the TypeScript engine is the latter (fast, stateless per turn).

### Repository layout for the new app
The external app lives in a **new top-level sibling directory** so it doesn't pollute the Python package:

```
D:\PokeRedus\
├── pokeredus\              # existing Python (unchanged except one new export script)
│   └── scripts\
│       └── export_knowledge_pack.py   # NEW — emits the Knowledge Pack JSON
└── pokelink\              # NEW — the external TypeScript app
    ├── package.json
    ├── tsconfig.json
    ├── src\
    │   ├── pack\          # Knowledge Pack loader + types
    │   ├── engine\        # MCTS-style runtime scorer
    │   ├── bridge\        # Showdown websocket client
    │   ├── biases\        # human-tunable weights + editor
    │   └── cli.ts         # entrypoint
    └── tests\
```

---

## Proposed Approach

### Tier 1 — Knowledge Pack (Python export → JSON artifact)
A single CLI `scripts/export_knowledge_pack.py` reads the existing on-disk data + loaded `KnowledgeGraph` and emits a versioned `knowledge-pack-{version}.json` (target <15MB; the 89MB raw matchup graph is *summarized*, not copied whole). The pack has five sections:

```jsonc
{
  "version": 1,
  "generated_at": "iso8601",
  "types":        { /* 18x18 chart — already in types.py TYPE_CHART */ },
  "species":      [ /* base_stats.json, normalized */ ],
  "moves":        [ /* moves.json, normalized — BP, type, category, priority, flags */ ],
  "abilities":    [ /* abilities.json */ ],
  "items":        [ /* items.json */ ],
  "sets":         [ /* every data/sets/**/*.yaml → {id, pokemon_id, moves, ability, item, nature, evs, ivs, role, tera} */ ],
  "edges":        [ /* summarized matchup edges: {a_set_id, b_set_id, score, best_move_a_id, ttk_a, ttk_b, dmg_pct_hi, dmg_pct_lo} — one row per (primary set × primary set) pair, ~13.9k rows */ ]
}
```

The `edges` section is the **downloadable intelligence seed**: it's what the MCTS scorer uses as its prior. The future self-evolving learner will *update this file*; the framework just consumes it.

### Tier 2 — Runtime Engine (TypeScript)
Mirrors a *subset* of the Python logic that has to run per-turn:
- **TypeChart**: 18×18 lookup, ported verbatim from `types.py`.
- **DamageModel**: the Gen-9 formula from `damage_calc.py` — `(2*L/5+2)*Power*A/D/50+2`, floor, STAB, type eff, min/max rolls (×0.85/×1.0). **Re-implemented in TS** (not called over a bridge) because it must run in <1ms during rollout.
- **ActionSpace**: given a `TurnState`, emit legal `{move, switch}` actions (respects Taunt/Choice/Truant/fainted). Mirrors `pick_best_move` + `find_optimal_switch`.
- **Scorer**: the core. A configurable weighted sum + bounded-depth tree search:
  - **Leaf eval** reuses `pick_best_move`'s additive heuristic (type eff, STAB, BP, priority, utility) PLUS a **prior from `edges`** (the downloaded intelligence).
  - **MCTS-style expansion**: N random rollouts (default `N=64`), each with depth `D=2`, scoring the resulting `TurnState` with a value function = `win_prob_estimate + bias * edge_prior`.
  - **Biases**: a flat JSON object (`biases.json`) that the user can edit: `{type_eff_weight, stab_weight, bp_weight, priority_weight, utility_weight, edge_prior_weight, rollout_count, rollout_depth, ...}`. Loading overrides the defaults; missing keys fall back.
- **Output**: `ScoredAction[]` — `{action, score, reasoning[], children?}`. Returned to the bridge for posting.

### Tier 3 — Showdown Bridge (Node + `ws`)
Pokémon Showdown exposes a websocket protocol at `wss://sim3.pokemonshowdown.com:443/sockjs/...`. The bridge:
1. Authenticates (guest or named account via `POST /action.php`).
2. Sends `/join battle-{roomid}` to subscribe to a battle's event stream.
3. Parses the line-delimited protocol (`|move|`, `|switch|`, `|-damage|`, `|faint|`, `|-field|`, etc.) into a normalized `TurnState`.
4. When `|request|` arrives (the "choose your move" prompt), calls `engine.score(state)` and replies `|/choose move {id}` or `|/choose switch {slot}`.
5. Emits a `TurnState` event after every parsed message so a UI/CLI can render live.

This is the "maintain a browser session and get live game updates and perform move choices" the user asked for — done with the native websocket (lightest possible), not DOM scraping.

---

## Step-by-Step Plan

Tasks are grouped by tier and ordered to keep each one independently runnable. Each task ends with a runnable check.

### ── Tier 1: Knowledge Pack ──────────────────────────────────────────

#### Task 1: Scaffold the `pokelink/` TypeScript project
**Objective:** A runnable empty TS project with the test runner wired. Nothing PokeRedus-specific yet. **Files:**
- Create: `pokelink/package.json`
- Create: `pokelink/tsconfig.json`
- Create: `pokelink/.gitignore`
- Create: `pokelink/tests/smoke.test.ts`
- Create: `pokelink/src/cli.ts`

**Step 1: Write `package.json`** (ESM, Node 20, vitest, tsx, ws, zod):
```json
{
  "name": "pokelink",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "build": "tsc"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "@types/ws": "^8.5.10",
    "@types/node": "^20.11.0"
  }
}
```

**Step 2: Write `tsconfig.json`** (strict, ESM, `moduleResolution: bundler`, `noUncheckedIndexedAccess: true` — critical for TS safety on the pack arrays).

**Step 3: Write the smoke test:**
```ts
// pokelink/tests/smoke.test.ts
import { describe, it, expect } from 'vitest';
describe('smoke', () => {
  it('runs', () => { expect(1 + 1).toBe(2); });
});
```

**Step 4: Write a trivial `src/cli.ts`** that prints `pokelink v0.1.0`.

**Step 5: Verify.** Run `cd pokelink && npm install && npm test`. Expected: 1 passed. Run `npm run dev`. Expected: prints version.

**Step 6: Commit.** `git add pokelink/` → `chore: scaffold pokelink TS project`.

---

#### Task 2: Define the Knowledge Pack Zod schema and TS types
**Objective:** A single source-of-truth for the pack's shape, validated at load time. **Files:**
- Create: `pokelink/src/pack/schema.ts`

**Step 1: Write theschema.** Mirror the Python `to_dict()` shapes exactly. Use `z.object` for each section:

```ts
// pokelink/src/pack/schema.ts
import { z } from 'zod';

export const TypeChartSchema = z.record(z.string(), z.record(z.string(), z.number()));
export const SpeciesSchema = z.object({
  id: z.string(), name: z.string(),
  types: z.array(z.string()),
  base_stats: z.object({ hp: z.number(), atk: z.number(), def: z.number(), spa: z.number(), spd: z.number(), spe: z.number() }),
  abilities: z.array(z.string()),
  weight: z.number(),
  tier: z.string().optional(),
});
export const MoveSchema = z.object({
  id: z.string(), name: z.string(), type: z.string(),
  category: z.enum(['Physical', 'Special', 'Status']),
  base_power: z.number(),
  accuracy: z.union([z.number(), z.literal(true)]),
  priority: z.number(),
  flags: z.array(z.string()),
  contact: z.boolean(),
  secondary: z.array(z.record(z.string(), z.unknown())).optional(),
});
export const AbilitySchema = z.object({ id: z.string(), name: z.string(), description: z.string(), flags: z.array(z.string()) });
export const ItemSchema     = z.object({ id: z.string(), name: z.string(), description: z.string(), consumed: z.boolean() });
export const SetSchema = z.object({
  id: z.string(), pokemon_id: z.string(), set_name: z.string(),
  moves: z.array(z.string()), ability: z.string(), item: z.string(),
  nature: z.string(), evs: z.object({ hp: z.number(), atk: z.number(), def: z.number(), spa: z.number(), spd: z.number(), spe: z.number(), label: z.string().optional() }),
  ivs: z.object({ hp: z.number(), atk: z.number(), def: z.number(), spa: z.number(), spd: z.number(), spe: z.number() }),
  role: z.string(), tera_type: z.string(),
});
export const EdgeSchema = z.object({
  a_set_id: z.string(), b_set_id: z.string(),
  score: z.number(), best_move_a_id: z.string(),
  ttk_a: z.number(), ttk_b: z.number(),
  dmg_pct_lo: z.number(), dmg_pct_hi: z.number(),
});
export const KnowledgePackSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  types: TypeChartSchema,
  species: z.array(SpeciesSchema),
  moves: z.array(MoveSchema),
  abilities: z.array(AbilitySchema),
  items: z.array(ItemSchema),
  sets: z.array(SetSchema),
  edges: z.array(EdgeSchema),
});
export type KnowledgePack = z.infer<typeof KnowledgePackSchema>;
export type Species = z.infer<typeof SpeciesSchema>;
export type Move = z.infer<typeof MoveSchema>;
export type SetEntry = z.infer<typeof SetSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
```

**Step 2: Test the schema** with a tiny valid + invalid fixture:
```ts
// pokelink/tests/pack-schema.test.ts
import { KnowledgePackSchema } from '../src/pack/schema';
const valid = { version: 1, generated_at: 'x', types: {}, species: [], moves: [], abilities: [], items: [], sets: [], edges: [] };
it('accepts minimal pack', () => expect(KnowledgePackSchema.parse(valid)).toBeDefined());
it('rejects wrong version', () => expect(() => KnowledgePackSchema.parse({ ...valid, version: 2 })).toThrow());
```

**Step 3: Verify.** `npm test`. Expected: 3 passed.

**Step 4: Commit.**

---

#### Task 3: Build `PackIndex` — the in-memory lookup layer
**Objective:** O(1) lookups by id for the engine. **Files:**
- Create: `pokelink/src/pack/index.ts`
- Test: `pokelink/tests/pack-index.test.ts`

**Step 1: Write `PackIndex`** — a class that takes a `KnowledgePack`, builds `Map<string, Move>`, `Map<string, SetEntry>`, `Map<string, Species>`, a `Map<string, Map<string, Edge>>` (a→b→edge), and a `byteSizeMB` getter. No logic, only indexing.

**Step 2: Write fixture loader** that reads `tests/fixtures/pack.mini.json` (hand-authored 3-species, 3-set, 9-edge mini pack — included in the task).

**Step 3: Tests** — `getMove('earthquake')`, `getEdge(a,b)`, `setsForSpecies('garchomp')`, `byteSizeMB`.

**Step 4: Verify.** `npm test`. Expected: all pass.

**Step 5: Commit.**

---

#### Task 4: Python exporter — `scripts/export_knowledge_pack.py`
**Objective:** Emit the real Knowledge Pack from PokeRedus. **Files:**
- Create: `pokeredus/scripts/export_knowledge_pack.py`

**Step 1: Write the exporter.** It:
1. Builds the KG the same way `build_graph.py` does — `kg = KnowledgeGraph()` then `import_gen9ou(kg, json_path=resources/gen9ou.json, ...)`. (DEVIATION: the plan originally said `KnowledgeGraph.load_or_build(...)`, which doesn't exist.)
2. Iterates `kg.get_all_pokemon()`, `kg.get_all_moves()`, `kg.get_all_sets()`, etc., emitting `to_dict()` shapes.
3. For `edges`: iterates the **primary set** of each species only, computing one `Edge` per ordered (a,b) pair via `compute_matchup(a, b, kg)` directly — ~0.1ms/pair, so the full 13,806 ordered matrix computes in ~1s. (DEVIATION: recomputation is far cheaper than loading the 86MB cached graph.) The **primary set** = the "Showdown Usage" stats-set, else the first set — the importer never populates `primary_set_id`, so this deterministic rule yields exactly 118 primary sets → 13,806 edges. Target ~13.9k rows (118²−118).
4. Writes `pokeredus/data/knowledge-pack/knowledge-pack-v1.json` and prints the byte size.

**Step 2: Reuse, don't reimplement.** The exporter uses `compute_matchup`, `get_calculator`, and the existing `to_dict` methods — *zero new domain logic*. This is critical to the ponytail principle.

**Step 3: Add a `--mini` flag** that exports only the first 5 species + their sets + their edges → produces `knowledge-pack-mini.json` for the test fixture (copy this into `pokelink/tests/fixtures/`).

**Step 4: Verify.** Run `cd pokeredus && python scripts/export_knowledge_pack.py --mini`. Expected: a JSON file <1MB, prints row counts. Then run the full export once and note the size (target <30MB).

**Step 5: Copy the mini pack** to `pokelink/tests/fixtures/pack.mini.json` so the TS test fixture always exists.

**Step 6: Commit.** `git add pokeredus/scripts/export_knowledge_pack.py pokeredus/data/knowledge-pack/ pokelink/tests/fixtures/pack.mini.json` → `feat(pack): add knowledge pack exporter`.

---

### ── Tier 2: Runtime Engine ──────────────────────────────────────────

#### Task 5: Port the type chart + effectiveness lookup
**Objective:** TypeScript `TypeChart` with O(1) `effectiveness(moveType, defTypes)`. **Files:**
- Create: `pokelink/src/engine/type-chart.ts`
- Test: `pokelink/tests/type-chart.test.ts`

**Step 1: Copy the `_OFFENSE` dict** from `pokeredus/classes/types.py:39-99` into TS as a `Record<string, Record<string, number>>`. The 18 canonical Pokémon types are: Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy.

**Step 2: Implement `getEffectiveness(moveType: string, defTypes: string[]): number`** — the product over defender types, defaulting to 1.0 for unlisted pairs. Mirrors `get_effectiveness` in `types.py`.

**Step 3: Tests** — water vs fire = 2, fire vs fire = 0.25 (0.5²), ground vs flying = 0, ghost vs normal = 0, normal vs steel = 0.5.

**Step 4: Verify.** `npm test -- type-chart`. Expected: all pass.

**Step 5: Commit.**

---

#### Task 6: Port the Gen-9 damage formula
**Objective:** `computeDamage(attackerSet, defenderSet, move, state)` returning min/max damage + ttk — straight port of `damage_calc.py`. **Files:**
- Create: `pokelink/src/engine/damage.ts`
- Test: `pokelink/tests/damage.test.ts`

**Step 1: Implement `effectiveStat`** — `Math.floor((2*base + iv + Math.floor(ev/4)) * level/100) + (stat === 'hp' ? level + 10 : 5)`, apply nature (×1.1/×0.9/×1.0). Port of `SetClass.effective_stat`. Level defaults to 100 (the user's target tier).

**Step 2: Implement the base formula with floor discipline.** Every intermediate is `Math.floor`-ed exactly as in Python: `base = Math.floor(Math.floor((Math.floor(2*L/5)+2) * Power * A / D) / 50) + 2`. Then `final = Math.floor(base * stab * typeEff * modProduct)`.

**Step 3: Min/max rolls.** `min = Math.floor(final * 0.85)`, `max = final`. `ttk = Math.ceil(effHp / max)` (fewest). Match `DamageResult` fields.

**Step 4: Implement the modifier product** for the subset the runtime must honor at first: STAB (1.5), burn on physical (0.5), Choice Band (1.5 physical), Choice Specs (1.5 special), Life Orb (1.3). Each is a `(set, move, state) => number` predicate → product. Keep this **open for extension** via a `Modifier` interface (mirrors `DamageModifier` from `damage_calc.py`) so future work can add weather/terrain without rewriting.

**Step 5: Tests** — known OU scenarios computed once in Python (`python -c "from pokeredus.graph.damage_calc import DamageCalculator; ..."`) and pinned as expected values in the TS test. At minimum: Garchomp Earthquake vs Toxapex (resisted, 2HKO), Dragapult Shadow Ball vs Garchomp (neutral, ~40%), Garchomp Earthquake vs Heatran (SE, OHKO-ish). Use `np.testing.assert_allclose`-style tolerance of ±2 damage.

**Step 6: Verify.** `npm test -- damage`. Expected: all pass against the pinned Python values.

**Step 7: Commit.**

---

#### Task 7: Action space generator — `enumerateActions(state)`
**Objective:** Produce `{type:'move', moveId}` ×4 `{type:'switch', slot}` × bench legal actions, respecting Choice item lock, Taunt, and fainted bench. Mirrors the action model in `unified/__init__.py:65 UnifiedAction`. **Files:**
- Create: `pokelink/src/engine/actions.ts`
- Test: `pokelink/tests/actions.test.ts`

**Step 1: Define `TurnState`** — the normalized game state passed in from the bridge: `{ side: 'a'|'b', turn, myActive: ActiveMon, myBench: ActiveMon[], oppActive: ActiveMon, field: FieldFlags, teraUsed: boolean }`, where `ActiveMon = { setId, hp, maxHp, status, boosts, pp, lastMove, choiceLock, tauntTurns, fainted }`.

**Step 2: Implement legal move filter** — exclude moves with 0 PP, that fail Taunt (non-damaging), and enforce Choice item lock (only the locked move id). If tera not used, append a `{type:'move', moveId, tera: true}` variant per move (so the engine can score tera tera-typed effectiveness independently).

**Step 3: Implement legal switch filter** — bench mons with `fainted === false`, that aren't currently active.

**Step 4: Tests** — 4-move set yields 4 (or 8 with tera); Choice-locked set yields 1; fainted bench excluded; Taunt removes status moves.

**Step 5: Verify.** `npm test -- actions`. Expected: pass.

**Step 6: Commit.**

---

#### Task 8: Leaf evaluator — the heuristic prior
**Objective:** A `scoreLeaf(state, action, pack, biases) => {score, reasoning[]}` that reproduces the additive heuristic from `pick_best_move` (`matchup_graph.py:534-650`) and `find_optimal_switch` (`:657-795`). **Files:**
- Create: `pokelink/src/engine/leaf.ts`
- Test: `pokelink/tests/leaf.test.ts`

**Step 1: For `move` actions**, port the exact scoring from `pick_best_move`:
- `base = 1.0`
- type effectiveness: immune → −1.0; ≥2 → +0.6; >1 → +0.3; <1 → −0.3
- STAB: +0.5 (non-status)
- BP ≥ 100: +0.2
- status: +0.3 (+0.1 if set has a recovery move, using the same `PIVOT_OR_RECOVERY` id set ported as a TS const)
- priority > 0: +0.2
- **edge prior**: + `biases.edge_prior_weight * edgeScore` where `edgeScore` comes from `pack.getEdge(attackerSetId, defenderSetId)?.score ?? 0`. This is the new hook the downloaded intelligence plugs into.
- **damage rollout** (optional, controlled by `biases.use_damage_rollout`): if a matching edge exists and `best_move_a_id === moveId`, fold the cached `dmg_pct_hi` in: `+ (dmg_pct_hi/100) * biases.damage_weight`.

**Step 2: For `switch` actions**, port `find_optimal_switch`: type-resist vs opponent's STAB, speed advantage from `species.base_stats.spe`, edge lookup, 3D-distance surrogate (a simplified version — we don't need the full 3D graph in TS; approximate with a `pack.sets`-derived bulk metric so the code stays light).

**Step 3: Reasoning strings** are accumulated the same way as Python (`reasons.push(...)`), so the final `ScoredAction` has a human-readable trail — this is what the user meant by "available to human fine tuning and iterative adjustments" — you can *see* why the engine picked something.

**Step 4: Tests** — pin the top move for a known matchup (Garchomp vs Toxapex: expect Swords Dance / Earthquake near top; Dragapult vs Garchomp: expect Draco Meteor) and verify reasons contain expected tokens.

**Step 5: Verify.**

**Step 6: Commit.**

---

#### Task 9: MCTS-style scorer — bounded-depth tree search
**Objective:** `scoreTurn(state, pack, biases): ScoredAction[]` — the main entry the bridge calls. **Files:**
- Create: `pokelink/src/engine/scorer.ts`
- Test: `pokelink/tests/scorer.test.ts`

**Step 1: Implement the search skeleton.**
1. `legal = enumerateActions(state)`
2. For each action: build a *shallow* child `TurnState` via `simulateOneStep(state, action)` (the switch is exact; the move is *expected* damage from the leaf — we don't simulate the opponent's reply beyond a single greedy countermove using the same leaf scorer). Depth default `biases.rollout_depth = 2`.
3. At the leaf of each rollout apply `scoreLeaf`. If `biases.rollout_count > 0`, run that many random-opponent rollouts and average — else just the single best-counter. (Random rollouts are gated behind a bias so a user can disable them for raw speed.)
4. Final per-action score = `leafScore + biases.child_weight * bestChildScore`. The recommended action = `argmax`.

**Step 2: Output `ScoredAction[]`** sorted descending: `{action, score, reasoning[], children?: ScoredAction[]}` (children only populated if `biases.rollout_depth > 0`).

**Step 3: Performance budget.** Add a `byteLength`-aware guard: refuse to run if `pack.byteSizeMB < packMinMB && !state.allowThin` (so the engine never silently runs with a truncated pack). Add a `console.time`/`console.timeEnd` around the top call in the CLI and assert the budget with `expect(scored).toHaveLength(legal.length)` and a soft `expect(elapsed).toBeLessThan(50)` in the test (skip under CI slowness).

**Step 4: Tests** — feed a fixture `TurnState` (Garchomp active vs Toxapex, full bench), assert `scored[0].action.type === 'move'` and `scored[0].score` > 0 and the reasoning mentions Earthquake or Swords Dance. Assert the fainted-bench and Choice-lock paths return the right `legal.length`.

**Step 5: Verify.** `npm test -- scorer`.

**Step 6: Commit.**

---

#### Task 10: Biases file + loader
**Objective:** A versioned `biases.json` that humans can hand-tune; the engine reads it at boot. **Files:**
- Create: `pokelink/src/biases/schema.ts` (zod)
- Create: `pokelink/src/biases/defaults.ts`
- Create: `pokelink/src/biases/loader.ts`
- Create: `pokelink/biases.json` (the downloadable default)
- Test: `pokelink/tests/biases.test.ts`

**Step 1: Define `BiasesSchema`** with defaults baked in via `.default(...)` so partial files are valid:
```ts
export const BiasesSchema = z.object({
  version: z.literal(1),
  type_eff_weight: z.number().default(1.0),
  stab_weight: z.number().default(0.5),
  bp_weight: z.number().default(0.2),
  priority_weight: z.number().default(0.2),
  utility_weight: z.number().default(0.3),
  edge_prior_weight: z.number().default(0.4),   // the downloaded intelligence weight
  damage_weight: z.number().default(0.3),
  use_damage_rollout: z.boolean().default(true),
  rollout_count: z.number().int().min(0).max(1024).default(64),
  rollout_depth: z.number().int().min(0).max(4).default(2),
  child_weight: z.number().default(0.5),
  switch_threshold: z.number().default(0.3),     // mirrors analyze_game_state threshold
});
```

**Step 2: `loadBiases(path?)`** — if no path, use `DEFAULT_BIASES`; if path given, read file, `BiasesSchema.parse(JSON.parse(...))` (zod fills defaults). Print any overridden keys at startup.

**Step 3: Write `pokelink/biases.json`** with interesting-but-sane starting values matching the defaults.

**Step 4: Tests** — missing file → defaults; partial file → merged; bad weight → zod throws.

**Step 5: Verify.** `npm test -- biases`.

**Step 6: Commit.** This `biases.json` IS the "downloadable set of edges and biases" the user named — buffered for the future auto-learner to update.

---

### ── Tier 3: Showdown Bridge ─────────────────────────────────────────

#### Task 11: Showdown protocol parser — `parseBattleMessage(line)`
**Objective:** Convert one raw protocol line (`|move|p1a: Garchomp|earthquake|...`) into a structured event. **Files:**
- Create: `pokelink/src/bridge/protocol.ts`
- Test: `pokelink/tests/protocol.test.ts`

**Step 1: Document the protocol** (a condensed reference comment at the top of `protocol.ts`). Showdown's battle events are `|`-prefixed: `|move`, `|switch`, `|-damage`, `|-heal`, `|-status`, `|-boost`, `|-unboost`, `|-fieldadd`, `|-fieldremove`, `|faint`, `|-sidestart`, `|-weather`, `|request`, `|turn`, `|win`. Major events from the [Showdown protocol cheat sheet](https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md).

**Step 2: Implement `parseLine(line: string): BattleEvent`** returning discriminated-union events: `{type:'move', player, name, moveId, target}` etc. Use zod to validate each shape.

**Step 3: Implement `battleStateFromEvents(events: BattleEvent[], prior: TurnState): TurnState`** — folds events into the normalized `TurnState`. The prior is the previous snapshot; HP deltas apply to `hp`, status/burn set `status`, switch replaces `myActive`/`oppActive`, faint marks `fainted`. **This is the "maintain a browser session and get live game updates" path** — the bridge keeps a `TurnState` and refolds on each batch.

**Step 4: Tests** — pin a 10-line transcript of a real Gen9OU turn (paste from `https://play.pokemonshowdown.com` dev tools once) and assert the resulting `TurnState` matches expectations: Garchomp takes 40%, Exca uses Earthquake, etc.

**Step 5: Verify.**

**Step 6: Commit.**

---

#### Task 12: Showdown websocket client — minimal session
**Objective:** Connect, auth, join a battle, subscribe to events. **Files:**
- Create: `pokelink/src/bridge/client.ts`
- Create: `pokelink/src/bridge/auth.ts`
- Test: `pokelink/tests/client.test.ts` (mocked `ws`)

**Step 1: Implement a thin wrapper over `ws`** (`class ShowdownClient`) with `connect()`, `send(msg)`, `onEvent(handler)`.

**Step 2: Auth flow** — `POST https://play.pokemonshowdown.com/action.php` with `act=login&name=...&pass=...` (or `act=guestlogin` for no-account). Store the assertion token. Send `|/trn {name},0,{assertion}` on the socket.

**Step 3: Join a battle** — `|/join battle-{id}`. Listen for `|request|{...}` which is Showdown's "your turn" prompt (a JSON blob listing legal moves/switches). Pipe it through `parseLine` and fold into `TurnState`.

**Step 4: Mocked test** — use `vitest`'s `vi.mock('ws')` to simulate a server that immediately sends `|request|` containing a Garchomp vs Toxapex scenario. Assert the client's `onRequest` handler fires with the right `TurnState`. **No real network in tests.**

**Step 5: Verify.**

**Step 6: Commit.**

---

#### Task 13: Decision loop — wire engine + bridge
**Objective:** On `|request|`, call `scorer.scoreTurn(state, pack, biases)`, log the top-3 with reasoning, and post `|/choose move {id}` (or `|/choose switch {slot}`). **Files:**
- Create: `pokelink/src/bridge/decide.ts`
- Test: `pokelink/tests/decide.test.ts`

**Step 1: `decideAndAct(client, state, pack, biases)`** — calls `scoreTurn`, prints a one-line `[#1] move:earthquake  score=0.92  (SE×2, STAB, nuke power)` per action to stdout, then `client.send('|/choose move ' + top.action.moveId)`. For switches: `|/choose switch {slot+1}`.

**Step 2: Add a `--dry-run` mode** (biased via `biases.dry_run` or a CLI flag) that logs the decision but does *not* send — so the user can observe the engine choosing without committing to a live battle.

**Step 3: Test** — mocked client asserts that a fixture request produces the expected `|/choose move earthquake` line in `client.sent`.

**Step 4: Verify.**

**Step 5: Commit.**

---

#### Task 14: CLI entrypoint — `cli.ts`
**Objective:** One command to drive everything: `npm run dev -- --pack knowledge-pack-v1.json --biases biases.json --battle <roomid>`. **Files:**
- Create: `pokelink/src/cli.ts` (replaced from the stub in Task 1)

**Step 1: Parse args** with `process.argv` (no `yargs` dep — ponytail: stdlib-only via a tiny `parseArgs` wrapper).

**Step 2: Load pack + biases**, build `PackIndex`, register `decide.ts` as the handler, connect `ShowdownClient`, enter the event loop.

**Step 3: Subcommands:**
- `pokelink score --pack X --replay <transcript.txt>` → reads a saved battle transcript, prints decisions per turn, *never connects to the server*. This is the offline-tuning surface the user needs ("available to human fine tuning and iterative adjustments").
- `pokelink live --pack X --battle <roomid> [--user <user>] [--pass <pass>]` → connects, plays the battle.
- `pokelink render-pack --pack X` → prints quick stats: `#species, #sets, #edges, byteSizeMB, version, generated_at`.

**Step 4: Verify.** Run `npm run dev -- render-pack --pack tests/fixtures/pack.mini.json`. Expected: a clean stats block. Run `npm run dev -- score --replay tests/fixtures/transcript.txt --pack tests/fixtures/pack.mini.json`. Expected: one decision printed per `|turn|` line.

**Step 5: Commit.**

---

#### Task 15: Live-integration smoke (manual, documented)
**Objective:** Prove the end-to-end path works against a real Showdown battle without writing it into the automated suite. **Files:**
- Create: `pokelink/docs/LIVE_SETUP.md`

**Step 1: Document** the exact steps:
1. `python pokeredus/scripts/export_knowledge_pack.py` → produce `knowledge-pack-v1.json`.
2. `cd pokelink && npm install && npm run build`.
3. Open `https://play.pokemonshowdown.com` in a browser, start a Gen9OU battle, copy the room id from the URL.
4. `npm run dev -- live --pack knowledge-pack-v1.json --battle <roomid> --user <guest-name>`.
5. Watch the CLI log decisions; confirm moves are played within 2s of each `|request|`.

**Step 2: Run it once yourself** against a low-ladder guest battle. Capture the audit logs. If the engine makes an obviously wrong choice (e.g., immune move), file it as a follow-up — don't fix here.

**Step 3: Commit** the doc with a "Verified once on <date>" line at the bottom.

---

## Files likely to change (summary)

New:
- `pokelink/**` (entire new TS package, 14 source + 8 test files)
- `pokeredus/scripts/export_knowledge_pack.py`
- `pokeredus/data/knowledge-pack/knowledge-pack-v1.json`, `knowledge-pack-mini.json`
- `pokelink/tests/fixtures/pack.mini.json`, `transcript.txt`
- `pokelink/docs/LIVE_SETUP.md`

Modified in `pokeredus/`:
- `pokeredus/ARCHITECTURE.md` — append a "Phase 9: PokeLink External Framework" section pointing to the new sibling package and the pack schema.
- None of the existing Python domain logic. The exporter is an additive script reading existing `to_dict()` outputs.

---

## Tests / validation

### Unit (vitest, run with `npm test`)
- `smoke.test.ts` — build works
- `pack-schema.test.ts` — schema valid/invalid cases
- `pack-index.test.ts` — O(1) lookups
- `type-chart.test.ts` — 6 effectiveness cases vs Python `TYPE_CHART`
- `damage.test.ts` — ≥3 pinned damage values from the Python `DamageCalculator`
- `actions.test.ts` — Choice/Taunt/faint filter
- `leaf.test.ts` — top-move ordering vs Python `pick_best_move` for ≥2 matchups
- `scorer.test.ts` — full turn decision + performance budget
- `biases.test.ts` — default/merge/reject
- `protocol.test.ts` — 10-line transcript → `TurnState`
- `client.test.ts` — mocked ws, `|request|` → `TurnState`
- `decide.test.ts` — fixture request → `|/choose move ...` line

### Integration (manual, Task 15)
- One live Gen9OU guest battle per the documented steps. Capture audit.

### Ponytail self-check (per AGENTS.md)
- A single runnable `assert` at the bottom of `damage.ts`: `assert(computeDamage(garchompSet, heatranSet, earthquake).ttk <= 1, 'Garchomp EQ should OHKO Heatran')` — runs on every `npm test`. No fixtures beyond the inline constants.

---

## Risks, tradeoffs, and open questions

### Risks
- **R1: Showdown protocol drift.** The protocol is stable but undocumented in places. Mitigation: pin the cheat-sheet URL in `protocol.ts` and add a "last verified protocol date" comment; tests pin a transcript.
- **R2: Damage formula drift vs Python.** Subtle floor differences can break pinned values. Mitigation: derive pinned values from Python at test-authoring time (Task 6 Step 5), so the TS side is the follower, not the source.
- **R3: 89MB matchup graph causes the exporter to take minutes.** Mitigation: only export primary-set pairs (~13.9k rows); benchmark in Task 4 Step 4; if >60s, add `--limit N` and document.
- **R4: WS rate limits / anti-bot.** Showdown will throttle rapid joins. Mitigation: decision throttle (max 1 action per `|request|`), realistic delays (1–3s), single-battle scope in the CLI.
- **R5: `tsconfig` `noUncheckedIndexedAccess` may surface many index-unwrap errors.** This is *desired* — the pack/protocol surfaces are trust boundaries (per AGENTS.md). Lean into it; don't relax the flag.

### Tradeoffs
- **Re-implementing damage in TS vs calling Python over a subprocess.** Chose re-implementation because: (a) latency (subprocess IPC is ~50ms, the whole budget for a turn), (b) portability (no Python dependency at runtime — the pack is downloadable), (c) the damage formula is small and stable (~50 lines). The cost is maintaining parity with `damage_calc.py` — managed by pinning tests and documenting the version correspondence.
- **WS protocol vs Puppeteer DOM scraping.** Chose WS: lighter (no browser process), faster, official. Cost: requires parsing the protocol (Task 11) — but that's a one-time investment with reusable tests.
- **MCTS bounded depth (D=2) vs full search.** Depth 2 = one counterply. Pokemon has high variance (crits, secondary effects); deeper search risks over-committing to a line that won't happen. Bounded depth with tuned biases meets the user's "portable probability based mcts style scoring" without burning compute.

### Open questions (flag for user, do not block implementation)
- **Q1:** Account credentials for live battle — is there an existing test account the user wants hardcoded as a default, or always CLI-prompt?
- **Q2:** Should the pack include the full 72,630 Club edges or just primary-set × primary-set (~13.9k)? Defaulting to the latter for size; the user's "downloadable" framing favors small. They can re-run the exporter with `--full` later (deferred).
- **Q3:** Tier/format scope — Gen9OU only (matches the existing graph), or should the pack be parameterizable? Defaulting to `--format gen9ou` with a no-op default; full multi-format later.
- **Q4:** Where should the self-evolving learner live — same `pokelink/` package behind a `--learn` subcommand, or a separate `pokelink-learner/`? Deferred per the user's instruction; flagged here for Phase 2.

### What is explicitly OUT of scope (per "BUILD THE REST AS A FRAMEWORK")
- No policy/value network training. The scorer uses heuristic + edge prior; the NN slot is a `Biases`-shaped stub.
- No reward assignment or battle-outcome labeling.
- No automatic `biases.json` mutation. Humans edit it; the future learner will write it.
- No multi-format support beyond Gen9OU.
- No replay database / self-play.

---

## Execution handoff

Plan complete and saved to `.hermes/plans/2026-07-08_pokelink-external-framework.md`.

Ready to execute using subagent-driven-development — I'll dispatch a fresh subagent per task with two-stage review (spec compliance then code quality), starting with Task 1 (scaffold). The Python exporter (Task 4) can run in parallel with the TS scaffolding tasks since it only touches `pokeredus/scripts/`.

The 15 tasks are sequenced so the first runnable check appears after Task 1 (~2 minutes), and the end-to-end live battle is demonstrated after Task 15 (~3–4 hours of focused work total, assuming the Knowledge Pack export in Task 4 completes without surprise).

Shall I proceed?
