# PokeRedus Architecture - Intelligence Layer

## Query Functions (queries.py)

- best_checks(kg, set_id): Sets that check the given set
- best_counters(kg, set_id): Sets that counter the given set
- threats_to(kg, set_id): Sets threatened by the given set
- weaknesses_of(kg, set_id): Sets that the given set is weak to
- team_coverage(kg, team_set_ids): Coverage analysis for a team
- team_weaknesses(kg, team_set_ids): Weaknesses not covered by team
- gaps(kg, team_set_ids): Missing coverage in team
- speed_tier(kg, set_id): Speed ranking among all sets
- speed_ranking(kg): Full speed tier list
- role_summary(kg): Sets grouped by role
- species_threats(kg, pokemon_id): Threats to a species
- species_favorable(kg, pokemon_id): Favorable matchups for a species
- set_comparison(kg, set_a_id, set_b_id): Direct comparison of two sets

## Analytics (analytics.py)

- SetStats: Per-set statistics (avg_score, win_rate, avg_ttk, etc.)
- SpeciesMatchup: Aggregated matchup between two species
- SetRanking: Ranked list of sets by composite score
- compute_set_stats(kg, set_id): Compute stats for a single set
- compute_all_set_stats(kg): Compute stats for all sets
- aggregate_matchups_by_species(kg): Species-level matchup aggregation
- rank_sets(kg): MCTS-style ranking (win_rate + ttk + speed)
- get_best_set_per_species(kg): Best set for each species
- matchup_matrix(kg): Species × species matchup matrix

## 3D Matchup Graph (matchup_graph.py) — AI Decision Layer

### Purpose
Map every set (and team of sets) into a three-axis space for fast AI decision-making. The graph generalizes to single Pokémon, sets, and full teams.

### Three Axes

#### Axis 1 (Types): 18-cell discrete vector
- One per Pokémon type with type affinity, STAB coverage, and nuke-power bonuses
- Each cell ∈ [0, 1]
- Projection: project_type_axis(target, kg)

#### Axis 2 (Offense ↔ Defense): Continuous float in [-1, +1]
- `+1.0` = pure sweeper, `-1.0` = pure wall, `0.0` = balanced
- Formula: `tanh((offense/bulk - 0.5) * 2)`
- For teams: BST-weighted average
- Projection: project_offdef_axis(target, kg)

#### Axis 3 (Speed / Control / Utility): 3-tuple in a 3-simplex (sum = 1, all ≥ 0)
- Speed is calibrated for level 100 (`(eff_spe - 100) / 150` clamped)
- For teams: mean of member SCU tuples, then projected to simplex
- Projection: project_scu_axis(target, kg)

### Data Structures
- `MatchupGraphNode`: a single point in 3D space with all three axes + member_ids
- `MatchupGraph`: container (plain dict) with `add()`, `get()`, `build_for_ou()`, JSON serialization

### AI Queries (return ranked dataclass lists with reasoning)
- `pick_best_move(attacker, defender, kg) → list[MoveRanking]`: ranks the attacker's 4 moves by combining type effectiveness, STAB, base power, status utility, priority, and existing matchup damage data
- `find_optimal_switch(opponent, candidates, kg) → list[SwitchRanking]`: ranks bench members using type-resist, speed advantage, precomputed matchup, and 3D distance
- `analyze_game_state(my_active, opp_active, my_bench, kg) → TurnPlan`: composed decision: stay vs switch (threshold 0.3), with a full reasoning chain explaining the choice

### Generalization
All three axis projections accept `SetClass | str | list[SetClass | str]`, so they work uniformly for individual Pokémon, sets, and full teams.

## Polygonal-Solid Matchup Graph (matchup_graph.py) — Visual Layer

### Purpose
Map every set (and team of sets) into an 8-attribute × 18-type matrix that the GUI renders as a 2D radial polygon or 3D cylinder of stacked type-discs.

### 8 Attributes (base → compound)
- **Base (4)**: `attack` (highest STAB BP), `utility` (setup/status moves), `defense` (bulk from HP/def/SpD), `speed` (eff Spe normalized)
- **Compound (4)**: `counter = attack + defense`, `sponge = utility + defense`, `threat = attack + speed`, `punish = utility + speed`

### Per-type matrix (8 × 18)
Each cell is the attribute value * weight(type, attribute); type weight depends on STAB and type effectiveness vs the 18 canonical types

### Per-set role weight (`WEIGHT_TABLE`)
`sweeper / wall / pivot / cleric / staller / lead / default` — rebalances the 8 attributes for a given archetype before the type weighting

### Vase sort
Types are reordered into ascending type-area permutation so the resulting 2D polygon / 3D cylinder is symmetric (the "vase" silhouette)

### Volume
= `Σ_types (counter·sponge + threat·punish) · bias`; `bias = 0.5 + 0.5·mcts_composite` so well-ranked sets are visibly fuller

### Data structures
- `SetMatchupNode`: 8×18 `np.float32` attribute matrix + `vase_order` (list[int]) + `bias` (float) + `weights` (list[float]) + `pokemon_id`, `set_id`, `mcts_composite`
- `compose_team_node(set_nodes)`: attributes sum, weights averaged, vase order = max-frequency union, bias = mean bias
- `volume_of(attributes, bias)`: scalar volume

### Per-set on-disk cache
`data/graphs/nodes/{pokemon_id}/{set_id}.json` (+ `.meta.json` for mcts/bias/vase). Hooked into `KnowledgeGraph.save_set_yaml` so saving a set also caches the node

### GUI
`pokeredus/gui/matchup_graph_view.py` exposes `MatchupGraph2D` (radial polygon, "elaborate by types" toggle), `MatchupGraph3D` (stacked-disc cylinder, arrow keys / drag / wheel / click-to-pick), and `MatchupGraphView` (combined 2D/3D toggle with `set_set(pokemon_id, set_id)` and `set_team(set_ids, kg=None)`)

### Wrappers
`MatchupGraphPage` in the same file is the page wrapper used by `app._open_matchup_graph_page` (toolbar + set-list sidebar + view body)