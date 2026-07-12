# Matchup Graph (3D) — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a 3D matchup graph that maps every Pokémon set (and composites of sets) into a three-axis space — types × offense-vs-defense spectrum × speed/control/utility spectrum — and exposes query helpers that an AI can use to pick optimal moves, types, and switch-ins for a given game state.

**Architecture:**
- New module `pokeredus/graph/matchup_graph.py` defining a pure-Python data layer: `MatchupGraphNode` (per set/team), `MatchupGraph` container, and per-axis projection functions.
- Reuses existing data: `SetClass`, `PokemonClass`, `MoveClass`, `TYPE_CHART`, `MatchupRelation`, `compute_matchup`.
- AI-facing query API in `pokeredus/graph/queries.py` extensions — `project_to_3d(set_id)`, `find_optimal_switch(defender_id, opponent_id)`, `find_type_advantage_neighbors(set_id)`, `team_centroid(team_ids)`.
- Fully serializable (JSON) and deterministically computable from the existing `KnowledgeGraph` so the existing 89 MB matchup graph remains the source of truth.

**Tech Stack:** Python 3.11 stdlib only (no new deps). Pure data classes, no NetworkX coupling in the projection layer (NetworkX is only used in the source `KnowledgeGraph`). Unit tests with pytest.

---

## Design Rationale

### Axis 1 — Types (discrete, 18 values)
A set can have 1–2 types, so the projection is a *multi-hot* vector over `POKEMON_TYPES`. For team composites, the team-type vector is the sum of member-type vectors (capped or normalized to [0, 1] per cell). Each type cell stores:
- `offensive_threat_score`: how hard this set hits that type with its best STAB move.
- `defensive_resist_score`: how well the set resists that type on the defensive side.

### Axis 2 — Offense ↔ Defense spectrum (continuous, [-1.0, +1.0])
A single number where:
- `+1.0` = pure offensive monster (high Atk/SpA, low bulk, frail, wallbreaker).
- `-1.0` = pure defensive wall (high HP/Def/SpD, low Atk/SpA, status/utility).
- `0.0` = balanced (e.g. AV Dragonite, Iron Valiant).

Computed from a weighted blend of `effective_atk / effective_spa` versus `effective_hp * effective_def * effective_spd`, then squashed through `tanh` to [-1, 1]. Offense-leaning if physical/special attack is > 1.2× the corresponding defense or bulk.

### Axis 3 — Speed / Control / Utility (continuous vector → 3D point, normalized)
Three sub-components collapsed into a single 3D point in a 3-simplex:
- `speed_score` — effective Spe normalized to [0, 1] (relative to OU baseline, e.g. 50–150 range).
- `control_score` — pivot & status density: count of moves like `[U-turn, Volt Switch, Parting Shot, Whirlwind, Roar, Haze, Dragon Tail, Recover, Soft-Boiled, Slack Off, Wish]` divided by move count.
- `utility_score` — hazard control, cleric, screens, Trick Room, weather/terrain setting. Proxy: flags on the set (Defog, Rapid Spin, Stealth Rock count) + ability flags.

Each component ∈ [0, 1], and we project into the 3-simplex `(speed + control + utility = 1, all >= 0)` so a node's position on this axis is comparable.

### Team Composites (the generalization)
A team of 1–6 sets projects to:
- **Type axis:** sum of member type vectors, L1-normalized.
- **Offense↔Defense:** weighted average of member axis-2 values, weighted by BST-share.
- **Speed/Control/Utility:** 3-simplex centroid of member axis-3 vectors.

Single-Pokémon and set-level projection is the special case where `n_members = 1`.

### AI Query Helpers (the part that picks moves)
- `project_to_3d(set_or_team_id) -> GraphProjection`
- `find_optimal_switch(defender_set_id, opponent_set_id, candidates) -> list[SwitchRanking]` — ranks candidate switch-ins by minimizing opponent's offense↔ score, maximizing own offense↔ score, and type-cell proximity to opponent's "weakness cell" (types we hit super-effectively).
- `pick_best_move(set_id, opponent_set_id) -> MoveRanking` — ranks the set's 4 moves by expected damage contribution (uses existing TTK data) × type effectiveness × utility (status, priority).
- `analyze_game_state(my_active, opp_active, my_bench) -> TurnPlan` — composed high-level helper that returns a recommended switch + recommended move + reasoning chain (for AI explainability).

---

## Tasks

### Task 1: Define data classes for graph nodes & projections

**Files:**
- Create: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Write failing test** — `test_matchup_graph_node_dataclass_exists`, `test_projection_dataclass_exists`.

**Step 2: Implement** — `@dataclass MatchupGraphNode` (id, kind="set"|"team", label, axis_type_vector: dict[str, float], axis_offdef: float, axis_speed_control_utility: tuple[float,float,float], member_ids: list[str]) and `@dataclass GraphProjection` returned by projection functions.

**Step 3: Verify** — `pytest tests/test_matchup_graph.py -v` → PASS.

**Step 4: Commit** — `git commit -m "feat(matchup-graph): add core dataclasses"`.

### Task 2: Implement type-axis projection

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_type_axis_single_set_known_mon`, `test_type_axis_dual_type_mon`, `test_type_axis_team_sums_members`.

**Step 2: Implement** — `project_type_axis(set_or_team, kg) -> dict[str, float]`. For a set: produce 18-cell vector where each cell T = 0.5 if T in pokemon.types else 0.0 (then `+0.5` per secondary type). Add STAB-threat cells: for each STAB move, cell[type] += 0.3 (or 0.5 for nuke moves with bp >= 100). For a team: average the per-member vectors.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): type-axis projection"`.

### Task 3: Implement offdef-axis projection

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_offdef_known_offensive_mon_positive`, `test_offdef_known_wall_negative`, `test_offdef_balanced_near_zero`, `test_offdef_team_weighted_average`.

**Step 2: Implement** — `project_offdef_axis(set_or_team, kg) -> float`. Use formula:
```
offense = (atk + spa) / 2   # effective at level 100
bulk    = (hp * 0.5) + (def + spd) * 0.75
ratio   = (offense / max(bulk, 1)) - 0.5   # center around 0
score   = tanh(ratio * 2.0)                 # squash to [-1, 1]
```
For teams: weighted average with weight = `member_bst / team_bst`.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): offdef-axis projection"`.

### Task 4: Implement speed/control/utility projection

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_scu_fast_mon_high_speed`, `test_scu_pivot_has_high_control`, `test_scu_hazard_setter_has_high_utility`, `test_scu_project_to_simplex`.

**Step 2: Implement** — `project_scu_axis(set_or_team, kg) -> tuple[float,float,float]`. Constants and rules:
- `speed_score = clamp((effective_spe - 60) / 100, 0, 1)`. Dragapult ~1.0, Toxapex ~0.0.
- `control_score = min(1.0, pivot_or_recovery_moves / 3)`. Pivot/recovery list hard-coded.
- `utility_score = clamp(0.4 * has_hazard_setter + 0.3 * has_hazard_remover + 0.3 * has_screens_or_weather_setter, 0, 1)`. Detect from move list and ability flags.
- Project to simplex: if sum > 1, divide each by sum. Otherwise pad the remainder onto the largest component to satisfy sum=1.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): SCU-axis projection"`.

### Task 5: Compose `project_to_3d` and `MatchupGraph` container

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_project_to_3d_set`, `test_project_to_3d_team`, `test_graph_container_add_and_get`, `test_graph_container_serialize_roundtrip`.

**Step 2: Implement** — `project_to_3d(target, kg) -> MatchupGraphNode` where `target` is a `SetClass | str` (set id) or `list[SetClass|str]` (team). And `MatchupGraph` class with `add(node)`, `get(id)`, `to_json()`, `from_json()`.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): 3D projection + container"`.

### Task 6: AI query — `pick_best_move`

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_pick_best_move_prefers_super_effective`, `test_pick_best_move_prefers_higher_ttk`, `test_pick_best_move_includes_status_for_utility`, `test_pick_best_move_uses_graph_node_context`.

**Step 2: Implement** — For each move in the set's 4-move pool, compute:
- damage score from existing MatchupRelation (min_damage_a_to_b .. max_damage_a_to_b)
- type-effectiveness score (super-effective → 1.5, neutral → 1.0, not-very → 0.5, immune → 0)
- utility bonus (+0.3 if status, +0.2 if priority > 0, +0.1 if has recovery in same set)
Return ranked list with `MoveRanking(move_id, score, reasoning)`.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): pick_best_move"`.

### Task 7: AI query — `find_optimal_switch`

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_find_optimal_switch_prefers_type_resist`, `test_find_optimal_switch_considers_speed`, `test_find_optimal_switch_uses_3d_distance`.

**Step 2: Implement** — For each candidate set, score by:
- `type_resist_score`: product of incoming effectiveness multipliers (0.25, 0.5, 1, 2, 4). Log + invert.
- `speed_advantage`: +1 if candidate.spe > opponent.spe, -1 if opposite, 0 on tie.
- `3d_distance`: Euclidean distance in axis-2 + axis-3 space, smaller is better.
- Return top-N with `SwitchRanking(set_id, score, reasons: list[str])`.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): find_optimal_switch"`.

### Task 8: AI query — `analyze_game_state`

**Files:**
- Modify: `pokeredus/graph/matchup_graph.py`
- Test: `tests/test_matchup_graph.py`

**Step 1: Test** — `test_analyze_game_state_returns_turn_plan`, `test_analyze_game_state_explains_reasoning`.

**Step 2: Implement** — Composes pick_best_move + find_optimal_switch:
- Computes projected 3D nodes for my_active, opp_active, my_bench.
- Decides "stay in" vs "switch" by comparing my_active matchup score vs best bench matchup.
- Returns `TurnPlan(recommended_switch, recommended_move, confidence, reasoning_chain: list[str])`.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): analyze_game_state"`.

### Task 9: Wire into `pokeredus.graph.__init__`

**Files:**
- Modify: `pokeredus/graph/__init__.py`
- Modify: `ARCHITECTURE.md` (add section)

**Step 1: Add imports + __all__** for `MatchupGraphNode`, `GraphProjection`, `MatchupGraph`, `project_to_3d`, `pick_best_move`, `find_optimal_switch`, `analyze_game_state`, `MoveRanking`, `SwitchRanking`, `TurnPlan`.

**Step 2: Update ARCHITECTURE.md** with the new "Matchup Graph (3D)" section under Intelligence Layer.

**Step 3: Verify, commit** — `git commit -m "feat(matchup-graph): wire into public API + docs"`.

### Task 10: Integration test with real data

**Files:**
- Create: `tests/test_matchup_graph_integration.py`

**Step 1: Write integration test** that loads the existing `data/graphs/ou_matchup_graph.json`, picks 3 representative sets (a wall, a sweeper, a pivot), and runs the full pipeline: project_to_3d → pick_best_move → find_optimal_switch. Verify all return non-empty, non-NaN results.

**Step 2: Run full suite** — `pytest tests/ -v`. Verify 0 regressions.

**Step 3: Commit** — `git commit -m "test(matchup-graph): integration with real OU data"`.

---

## Open Design Questions (need user input before implementing)

1. **Should the graph be a real `networkx.Graph` instance, or just a `dict[id, MatchupGraphNode]`?**
   Pros of Graph: free neighbor traversal, graph algorithms (shortest path, community detection), consistent with existing `KnowledgeGraph` style.
   Pros of dict: simpler, no NetworkX dep, no 89MB to reload when projecting on the fly.
   My recommendation: start with dict + helper functions, can wrap in networkx later if AI queries need graph algorithms.

2. **Should we persist projections to disk (under `data/graphs/matchup_graph_3d.json`) or compute on-demand?**
   With ~13K sets in the OU graph, projecting all of them takes maybe 30-60 seconds. Could cache per-set, invalidate when graph changes.
   My recommendation: compute on-demand with a simple `@lru_cache` keyed on `(pokemon_id, set_id, graph_fingerprint)`, and add an explicit `MatchupGraph.build_for_ou(kg)` that precomputes the whole thing.

3. **Speed/Control/Utility as a 3-simplex or as three independent scores?**
   Simplex forces them to sum to 1, which makes "where in the triangle" meaningful but artificially constrains the values. Three independent [0,1] scores are easier to reason about for the AI.
   My recommendation: simplex, because the user said "speed, control, and utility of a team" implying they're a triangle of tradeoffs.

4. **Naming convention for the module.**
   `pokeredus/graph/matchup_graph.py` collides slightly with the existing `pokeredus/graph/matchup_engine.py` / `matchup_scorer.py`. Should I put this in a new package `pokeredus/graph/projection/` or keep it flat in `pokeredus/graph/`?
   My recommendation: flat in `pokeredus/graph/matchup_graph.py` — the existing modules are sibling files too, and a new subpackage is YAGNI for one file.
