# PokeRedus — Project Status & Framework Summary

_Updated 2026-07-12 after TypeScript rewrite. Active codebase is the npm monorepo under `packages/`; Python under `pokeredus/` is frozen legacy (data + reference only)._

---

## 0. READ FIRST — TypeScript monorepo (current)

| Location | State |
|---|---|
| `packages/calc` | **Active.** Sole `@smogon/calc` adapter (Gen 9 damage physics). |
| `packages/core` | **Active.** KG, matchup, battle sim, MCTS, attributes, unified API. |
| `packages/engine` | **Active.** `scoreTurn` / leaf heuristics (consumes calc). |
| `packages/pack` | **Active.** Knowledge Pack Zod schema + `PackIndex`. |
| `packages/cli` | **Active.** `render-pack`, `export-pack`, `export-training`, `score`, `live`. |
| `packages/web` | **Active.** React 19 + Vite GUI (team builder, graph, simulator). |
| `packages/bridge` | **Active.** Showdown websocket client. |
| `pokeredus/` | **Frozen legacy.** On-disk data (`data/knowledge-pack/`, `data/teams/`), golden reference; no new domain logic. See `pokeredus/LEGACY.md`. |
| `pokelink/` | **Superseded.** Original TS prototype; functionality lives in `packages/*`. |

**Verification (2026-07-12):**
```bash
npm install
npm test                    # 97 tests (calc, cli, core, engine, pack)
npm run typecheck --workspaces --if-present
npm run build -w @pokeredus/web
npm run dev -w @pokeredus/cli -- export-pack --mini
npm run dev -w @pokeredus/cli -- export-training --max-pairs 10
```

**Architecture:** All damage paths use `@pokeredus/calc` → npm `@smogon/calc`. Intelligence = Knowledge Pack edges + `biases.json` via `scoreTurn`. Self-evolving learner still deferred.

---

## 0b. Historical — pre-rewrite state (2026-07-12 recovery)

_Generated 2026-07-12 (regenerated after source recovery). Covers both projects,
feature status, what remains, and the framework designed for future automated-play-bot
development._

The previous version of this document (2026-07-12) reported that a large portion of the
source was missing — only compiled `.pyc` artifacts and `node_modules` remained. **That
recovery is now complete.** The user restored the missing files; this regeneration reflects
the actual on-disk state after restoration.

Verified facts (via terminal + build):

| Location | State |
|---|---|
| `pokelink/` | **Fully restored.** All source present: `src/` (biases, bridge, engine, pack), `tests/` (12 `.test.ts`), `docs/LIVE_SETUP.md`, `package.json`, `tsconfig.json`, `biases.json`, and test fixtures. `node_modules` present. |
| `pokeredus/scripts/` | **9 scripts present**, including the previously-absent Tier-1 exporter `export_knowledge_pack.py` plus new `download_item_sprites.py`, `export_training_data.py`, `sync_obsidian_configs.py`. |
| `pokeredus/pokeredus/unified/` | `unified/__init__.py` restored (43.7 KB — `UnifiedState`/`recommend_actions` bridge). |
| `pokeredus/pokeredus/graph/` | **All 23 `.py` modules present as source** (the 15 that were `.pyc`-only are recovered, and a new `matchup_scorer.py` was added). |
| `data/knowledge-pack/` | **Present.** `knowledge-pack-v1.json` (2.69 MB) + `knowledge-pack-mini.json` (71 KB). |
| `data/graphs/` | **ABSENT.** The ~89 MB `ou_matchup_graph.json` is not on disk. The exporter recomputes pair edges from the KG rather than loading this file, so it is not blocking for the exporter — but the cached graph artifact itself is missing. |

**Verification (re-run after restore):**
- `cd pokelink && npx tsc --noEmit` → exit 0 (clean).
- `cd pokelink && npm test` → **12 test files, 65 tests passing** (vitest).
- PokeRedus `.py` source present for all graph/unified modules (no longer `.pyc`-only).

_The rest of this document describes what was built (design + verified behavior)._

---

## 0c. READ FIRST — Current on-disk state (verified 2026-07-12) [superseded by §0]

## 1. Executive overview

Two sibling projects under `D:\PokeRedus`:

- **PokeRedus** (`pokeredus/`) — Python. The knowledge base, deterministic heuristic
  scorers, damage model, attribute system, GUI, and the exporter that produces the
  downloadable Knowledge Pack. This is the _source of truth_ for intelligence.
- **PokeLink** (`pokelink/`) — TypeScript/Node. The _runtime_ that consumes the Knowledge
  Pack, scores legal actions in <50 ms per turn via an MCTS-style engine, and a lightweight
  websocket bridge to live Pokémon Showdown battles.

The split mirrors the user's intent: **knowledge/predefined rules** (immutable, downloaded
JSON) vs **code that runs efficiently in real time** (stateless TS per turn). The
self-evolving learner was explicitly **deferred** — the framework is built so it can be
plugged in later by updating two JSON blobs: the **Knowledge Pack edges** and the **Biases**.

---

## 2. PokeRedus (Python) — directory roles & file briefs

### `pokeredus/scripts/` (repo root)
| File | Role |
|---|---|
| `build_graph.py` | Builds the `KnowledgeGraph` from on-disk data + `import_gen9ou`. |
| `launch.py` | App/launcher entrypoint. |
| `fetch_moves.py` | Fetches `data/raw/moves.json` (954 moves) from the Showdown API. |
| `fetch_base_stats.py` | Fetches `data/raw/base_stats.json` (species). |
| `download_sprites.py` | Downloads species sprites. |
| `download_item_sprites.py` | Downloads item sprites. |
| `export_knowledge_pack.py` | **(Tier 1, restored)** Emits the portable Knowledge Pack JSON from the KG + on-disk data (~2.6 MB at `pokeredus/data/knowledge-pack/knowledge-pack-v1.json`). |
| `export_training_data.py` | Exports training/observation corpus (e.g. unified-app training data). |
| `sync_obsidian_configs.py` | Bridges formulas/weights from the Obsidian vault (`.md`) into Python. |

### `pokeredus/pokeredus/` (package)
| Path | Role | On disk? |
|---|---|---|
| `config.py` | Global config / paths. | ✅ |
| `classes/` | Domain models (10 modules + `__init__.py`): `pokemon.py`, `sets.py` (`SetClass.effective_stat`), `matchup.py`, `attributes.py`, `ev_spread.py`, `natures.py`, `items.py`, `abilities.py`, `moves.py`, `types.py` (the 18×18 `TYPE_CHART`). | ✅ |
| `graph/damage_calc.py` | `DamageCalculator` / `DataResult` — Gen-9 damage model (base power, STAB, type eff, min/max, TTK). The physics the TS engine ports. | ✅ |
| `graph/knowledge_graph.py` | `KnowledgeGraph` — species/sets/moves index; `compute_matchup`, `get_calculator`, `import_gen9ou`. | ✅ |
| `graph/matchup_engine.py` | `matchup_engine.compute_matchup` — pair-scorer (~0.1 ms/pair) used by the exporter. | ✅ |
| `graph/matchup_cache.py` `graph/queries.py` `graph/analytics.py` | Caching, graph queries, analytics helpers. | ✅ |
| `graph/matchup_graph.py` | **Heuristic scorers**: `pick_best_move` (move scoring), `find_optimal_switch`, `analyze_game_state`. Returns ranked `MoveRanking`/`SwitchRanking`/`TurnPlan` with reasoning. | ✅ (recovered) |
| `graph/matchup_scorer.py` | **(new)** Additional matchup scoring layer. | ✅ |
| `graph/game_state.py` | `GameState`/`PokemonState`/`FieldState` — dynamic battle model (HP, boosts, status, weather, terrain, hazards). | ✅ (recovered) |
| `graph/probabilistic_engine.py` `graph/mcts_graph.py` `graph/battle_simulator.py` `graph/dynamic_engine.py` | Probabilistic / MCTS / simulation engines over the graph. | ✅ (recovered) |
| `graph/attribute_*` `graph/common_attributes.py` `graph/synergy_detector.py` `graph/radar_attributes.py` | Attribute system (8-attribute radar, registry, manager, factory, synergy detection). Powers the 3D matchup graph. | ✅ (recovered) |
| `graph/species_matchup_cache.py` `graph/matchup_cache_provider.py` | Per-species matchup caching. | ✅ (recovered) |
| `unified/__init__.py` | `UnifiedState`, `UnifiedAction`, `UnifiedTeamSlot`, `render_scene()`, `recommend_actions()`, `export_training_corpus()` — the bridge between the KG and textual/JSON model output. | ✅ (recovered, 43.7 KB) |
| `importers/showdown_importer.py` | Imports Showdown team/data formats. | ✅ |
| `importers/smogon_importer.py` | **(additional)** Smogon data importer. | ✅ |
| `utils/data_io.py` | **(new package `utils/`)** Data I/O helpers. | ✅ |
| `gui/` | tkinter app: `app.py`, `theme.py` (neon theme), `team_builder.py`, `team_store.py`, `pokemon_panel.py`, `pokemon_set_list.py`, `set_editor.py`, `attribute_editor.py` **(new)**, `attribute_tuner.py`, `matchup_panel.py`, `matchup_graph_view.py` (3D), `sprites.py`, `simulator_page.py` (dual-phase sim + damage ranges), `team_analysis_cache.py`, `unified_app.py`. **16 `.py` files** (the old `graph_view.py` is no longer present — superseded by `matchup_graph_view.py`). | ✅ |

---

## 3. PokeLink (TypeScript) — the external framework

_Architecture (Tiers 1–3) as designed and **re-verified 2026-07-12**: `tsc --noEmit` clean,
`npm test` → 65 passed across 12 test files. Source is fully present on disk._

### `package.json` / `tsconfig.json`
ESM, Node ≥20. Deps: `ws` (websocket), `zod` (schema). Dev: `tsx`, `typescript`, `vitest`,
`@types/ws`, `@types/node`. `tsconfig` is strict with `noUncheckedIndexedAccess: true`.

### `src/pack/` — Knowledge Pack loader
| File | Role |
|---|---|
| `schema.ts` | Zod schemas + inferred types (`KnowledgePack`, `Species`, `Move`, `SetEntry`, `Edge`). Validation at load time. |
| `index.ts` | `PackIndex` — O(1) `Map` lookups for moves/sets/species, a `Map<a,Map<b,Edge>>` edge index, plus `setsBySpecies` / `primaryBySpecies` (primary = "Showdown Usage" set else first) for Showdown→set resolution. `byteSizeMB` getter. |
| `load.ts` | `loadKnowledgePack(path)` — read + zod-parse → `PackIndex`. |

### `src/engine/` — MCTS-style runtime scorer (the fast path)
| File | Role |
|---|---|
| `state.ts` | `TurnState` / `ActiveMon` / `Action` normalized types (the contract the bridge feeds in). |
| `type-chart.ts` | Port of `classes/types.py` 18×18 `_OFFENSE` chart; `getEffectiveness(moveType, defTypes)`. |
| `damage.ts` | Gen-9 formula port (`effectiveStat`, `(2L/5+2)*P*A/D/50+2`, floor discipline, min/max rolls ×0.85, TTK). `Modifier` interface (STAB, burn, Choice Band/Specs, Life Orb) — open for extension. `normItem()` fix for hyphenated item ids. |
| `actions.ts` | `enumerateActions(state)` — legal `{move}`×4 + `{switch}`×bench, respecting Choice lock, Taunt, fainted bench, and appending tera variants. |
| `leaf.ts` | `scoreLeaf` — additive heuristic mirroring `pick_best_move` (type eff, STAB, BP, priority, utility) + **edge prior** (`biases.edge_prior_weight * edgeScore`) + optional cached damage rollout. Switch scoring mirrors `find_optimal_switch` with a 3D-distance bulk surrogate. Accumulates human-readable `reasons[]`. |
| `scorer.ts` | `scoreTurn(state, pack, biases): ScoredAction[]` — MCTS-style bounded search (N rollouts × D depth), `argmax`, sorted descending, `children` populated when `rollout_depth>0`. Soft <50 ms budget. |

### `src/biases/` — human/auto-tunable weights (the "downloadable intelligence" seed)
| File | Role |
|---|---|
| `schema.ts` | `BiasesSchema` (zod, `.default()`-backed) + `type Biases`. |
| `defaults.ts` | `DEFAULT_BIASES` (version 1, sane weights). |
| `loader.ts` | `loadBiases(path?)` — defaults or merge partial file; prints overridden keys at boot (tuning audit trail). |
| `biases.json` | The on-disk default blob a human (or future learner) edits. |

### `src/bridge/` — Showdown websocket client (Tier 3)
| File | Role |
|---|---|
| `protocol.ts` | `parseLine` tokenizer + `BattleEvent` discriminated union (Showdown effect lines carry a leading dash: `|move|`, `|-damage|`, `|-boost|`, `|-status|`, `|-start|`, `|-end|`, `|faint|`, `|switch|`, `|request|`, …). `BattleTracker` folds events into `TurnState`; `battleStateFromEvents` one-shot reducer; `resolveSetId` maps Showdown species ids → pack set ids. Singles-only. |
| `auth.ts` | `guestName(prefix)` + `getAssertion(user, pass, challstr)` (POST to `action.php`). |
| `client.ts` | `ShowdownClient` over `ws`: `|challstr|`→`|/trn` handshake, auto-join `battle-{id}`, fan-out of parsed events. |
| `decide.ts` | `decideAndAct(client, state, pack, biases)` — scores turn, logs top-3 with reasoning, posts `|/choose move …` / `|/choose switch …`. Respects `biases.dry_run` (log only). |

### `src/cli.ts`
Stdlib-only arg parsing (no yargs). Subcommands:
- `render-pack --pack <json>` — prints pack stats.
- `score --replay <transcript.txt> --pack <json> [--dry-run]` — offline replay; never connects.
- `live --battle <roomid> --pack <json>` — websocket live play.

### `tests/` (vitest)
`smoke`, `pack-schema`, `pack-index`, `type-chart`, `damage`, `actions`, `leaf`, `scorer`,
`biases`, `protocol`, `decide`, `client` (mocked `ws`, no network) + fixtures
(`pack.mini.json`, `decide-pack.json`, `transcript.txt`). **12 test files / 65 tests passing**
(re-verified 2026-07-12).

### `docs/LIVE_SETUP.md`
Manual runbook: export full pack → `render-pack` → `score --replay` (offline tuning) →
`live --battle` (real guest battle). The documented step for verifying a live match end-to-end.

---

## 4. Knowledge & data artifacts (the portable intelligence)

- **Knowledge Pack** (`pokeredus/data/knowledge-pack/knowledge-pack-v1.json`, 2.69 MB; `knowledge-pack-mini.json`, 71 KB): versioned, immutable JSON with `types`, `species`, `moves`, `abilities`, `items`, `sets`, and `edges`. The `edges` section (~13.8k ordered `primary-set × primary-set` rows: `score`, `best_move_a_id`, `ttk_a/b`, `dmg_pct_lo/hi`) is the **downloadable intelligence seed** the scorer uses as its prior.
- **Biases** (`pokelink/biases.json`): the tunable weights the scorer reads. The future self-learner's output target.

Both are plain files you can download, edit, and drop in — satisfying the "downloadable
intelligence" constraint.

> **Note:** the cached full matchup graph `data/graphs/ou_matchup_graph.json` (~89 MB,
> ~72,630 edges) is **not currently on disk** (see §0). The exporter and scorer do not
> require it — the pack edges are recomputed/embedded — but if you want the 89 MB on-disk
> graph back, re-run `scripts/build_graph.py`.

---

## 5. Feature status matrix

| Feature | Tier | Status |
|---|---|---|
| Knowledge Pack exporter (Python) | 1 | Built (restored, verified on disk) |
| Pack Zod schema + `PackIndex` | 1/2 | Built (TS, verified) |
| Type chart port | 2 | Built (verified) |
| Gen-9 damage model port | 2 | Built (verified; `normItem` fix) |
| Action-space enumerator | 2 | Built (verified) |
| Leaf heuristic + edge prior | 2 | Built (verified) |
| MCTS-style scorer | 2 | Built (verified, 65 tests) |
| Biases file + loader | 2 | Built (verified) |
| Showdown protocol parser | 3 | Built (verified) |
| Websocket client + auth | 3 | Built (verified, mocked) |
| Decision loop (engine↔bridge) | 3 | Built (verified) |
| CLI (render/score/live) | 3 | Built (verified offline) |
| Live end-to-end guest battle | 3 | **Documented, not yet run** |
| Self-evolving learner (policy gradient, reward, weight updates) | — | **Deferred (out of scope by design)** |
| Doubles support | — | Deferred (singles-only tracker) |
| Weather/terrain damage modifiers | — | Stubbed via `Modifier` interface |
| Full `project_to_3d` distance | — | Surrogate bulk metric in TS |
| Opponent team revelation (bridge) | — | `flipSide` perfect-info simplification |

---

## 6. What's left to implement

1. **Restore the cached matchup graph (optional)** — re-run `scripts/build_graph.py` to
   regenerate `data/graphs/ou_matchup_graph.json` (~89 MB). Not required for the exporter or
   PokeLink, but restores the on-disk graph artifact. _(Source recovery from §0 is done.)_
2. **Run a live guest battle** end-to-end (per `docs/LIVE_SETUP.md` step 5) and add a
   "Verified on <date>" line.
3. **Self-evolving intelligence loop** (the deferred core): a `learner/` module that consumes
   `(TurnState, chosenAction, outcome)` tuples, assigns reward (did the chosen move win the
   exchange / match?), and rewrites `biases.json` + the Knowledge Pack `edges`. This is the
   "automated play bot" evolution the framework is built to receive.
4. **Persisted learning**: accumulate battle outcomes to a replay corpus; periodically
   re-export/refresh the Knowledge Pack as the metagame shifts.
5. **Doubles support**: extend `BattleTracker` to 2 active slots/side.
6. **Weather/terrain modifiers**: fill in the `Modifier` interface in `engine/damage.ts`.
7. **Full 3D projection** in TS (currently a monotone bulk surrogate).
8. **Opponent team revelation**: replace the `flipSide` perfect-info assumption with real
   team parsing from the battle stream.
9. **GUI integration**: surface PokeLink's top-3 recommendations + reasoning inside the
   PokeRedus tkinter simulator.
10. **Replay integration test**: feed a real Showdown battle log through `score --replay` and
    assert decisions match a hand-labeled baseline.

---

## 7. Framework for future automated play bots

The architecture is deliberately **pluggable** so an automated bot can be layered on without
rewriting the engine:

```
            ┌─────────────────────┐      download/drop-in      ┌──────────────────┐
            │  PokeRedus (Python) │ ─── knowledge-pack-v1.json ─▶│  PokeLink (TS)  │
            │  knowledge + exporter│      biases.json              │  runtime engine  │
            └─────────────────────┘                              └────────┬─────────┘
                                                                         │ scoreTurn()
                                                                         ▼
            ┌─────────────────────┐                              ┌──────────────────┐
            │  Pokémon Showdown    │ ◀── |/choose move … ─────── │  Bridge (ws)     │
            │  (live battle)       │ ─── |move|,|-damage|,… ───▶│  protocol parser │
            └─────────────────────┘                              └──────────────────┘
```

**Extension points (where a bot plugs in):**
- **Knowledge Pack `edges`** — the prior. A bot improves by *updating these rows* from
  observed outcomes (the learner writes a new `knowledge-pack-v2.json`).
- **`biases.json`** — the weights. The learner's direct output: tune `edge_prior_weight`,
  `rollout_count`, `switch_threshold`, etc. to change play style.
- **`engine/leaf.ts` rollout policy** — swap or extend the additive heuristic.
- **`engine/damage.ts` `Modifier` interface** — add weather/terrain/ability interactions.
- **`bridge/decide.ts`** — the single point where `scoreTurn` becomes an action; a bot can
  intercept to add meta-logic (e.g., forfeits, team-preview lead selection).
- **Offline `score --replay` loop** — the training/eval surface: feed transcripts → score →
  compare to what was actually played → assign reward → update biases/edges. No live account
  needed.

**Suggested next module** (`src/learner/`): `observe(state, action, outcome)` →
`rewardAssignment()` → `updateBiases()` + `updateEdges()`, emitting a new `biases.json` and
`knowledge-pack` revision. This keeps the human-tunable file as the single source of truth
the runtime consumes — exactly the "downloadable intelligence" contract.

---

## 8. Recommended immediate actions

1. **(Optional) Regenerate the cached graph** — `cd pokeredus && python scripts/build_graph.py`
   if you want `data/graphs/ou_matchup_graph.json` back on disk. Source recovery is otherwise
   complete and verified.
2. **Run a live guest battle** end-to-end (per `pokelink/docs/LIVE_SETUP.md` step 5) and add
   a "Verified on <date>" line to §5.
3. Proceed with §6 items, starting with the offline replay loop + the `learner/` module
   to make the framework actually self-improving.
4. **Periodic re-verify PokeLink** after edits: `cd pokelink && npx tsc --noEmit && npm test`.
