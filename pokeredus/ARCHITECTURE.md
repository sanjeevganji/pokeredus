# PokeRedus Architecture

## Overview

PokeRedus is a class-based Pokémon intelligence system for competitive Gen 9 OU analysis. The system represents Pokémon knowledge as an explicit object/class graph where Pokémon species, sets, moves, abilities, items, and matchups are all first-class typed objects with relations.

**Current Phase**: Phase 8 complete (3D Matchup Graph + AI Query Layer)
**Next Phase**: Phase 9 - Battle Simulation & Decision Engine

---

## Core Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    GUI Layer (Tkinter)                       │
│  Team Builder | Pokémon Browser | Matchup Analysis | Graph  │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                  Intelligence Layer                          │
│  Queries | Analytics | MCTS Ranking | Coverage Analysis     │
│  3D Matchup Graph | AI Queries (pick_best_move,             │
│  find_optimal_switch, analyze_game_state)                   │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                     Graph Layer                              │
│  KnowledgeGraph (NetworkX) | MatchupEngine | DamageCalc     │
│  MatchupCache | TTK-based Scoring | Modifier System         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                   Knowledge Layer                            │
│  PokemonClass | SetClass | MoveClass | AbilityClass         │
│  ItemClass | NatureClass | EVSpreadClass | TypeClass        │
└─────────────────────────────────────────────────────────────┘
```

---

## Domain Classes (Knowledge Layer)

### PokemonClass
- **Purpose**: Represents a Pokémon species (e.g., Garchomp, Toxapex)
- **Key Fields**: id, name, types, base_stats, abilities, weight, tier
- **Classifications**: is_mega, is_paradox, is_legendary, is_pseudo
- **Relations**: has_type, has_set (inverse)

### SetClass
- **Purpose**: A competitive configuration for a Pokémon species
- **Key Fields**: pokemon_id, moves, ability, item, nature, evs, ivs, role, tera_type
- **Unit of Intelligence**: All matchups, scoring, and queries operate at the Set level
- **Computed Stats**: effective_stat(stat, base_stats, level=50)

### MoveClass
- **Purpose**: A single move with type, power, accuracy, priority, effects
- **Key Fields**: id, name, type, category, base_power, accuracy, priority, pp, flags
- **Properties**: is_status, is_physical, is_special, is_contact, has_perfect_accuracy
- **Secondary Effects**: List of dicts describing additional effects (flinch, burn, etc.)

### AbilityClass
- **Purpose**: A Pokémon ability with effect description and trigger flags
- **Key Fields**: id, name, description, flags
- **Flags**: "on_switch_in", "persistent", "on_contact", "weather", "terrain"

### ItemClass
- **Purpose**: A held item with optional single-use (consumed) flag
- **Key Fields**: id, name, description, consumed

### NatureClass
- **Purpose**: A nature with +10% / -10% stat modifiers
- **Key Fields**: name, increased_stat, decreased_stat
- **Method**: modifier(stat) → returns 1.1, 0.9, or 1.0

### EVSpreadClass
- **Purpose**: EV distribution across six stats with validation
- **Key Fields**: hp, atk, def_, spa, spd, spe, label
- **Validation**: Total ≤ 508, per-stat ≤ 252

### TypeClass
- **Purpose**: One of 18 Pokémon types with effectiveness multipliers
- **Key Fields**: name, effectiveness (dict of type → multiplier)
- **Global Chart**: TYPE_CHART (18×18 matrix)

### MatchupRelation
- **Purpose**: Scored relationship between two SetClass instances
- **Key Fields**: set_a_id, set_b_id, score (-1.0 to +1.0), confidence, tags
- **TTK Fields**: turns_to_kill_a/b, speed_advantage, best_move_a/b_id
- **Damage Range**: min/max damage, damage_pct, min/max TTK

---

## Graph Layer

### KnowledgeGraph (NetworkX DiGraph)
- **Node Types**: pokemon, set, move, ability, item, nature, type
- **Edge Types**: has_type, has_move, has_ability, holds_item, has_nature, has_ev_spread, matchup
- **Secondary Indexes**: _pokemon_index, _set_index, _move_index, etc.
- **Primary Set Management**: get_primary_set(), set_primary_set(), build_composite_set()
- **Serialization**: to_json() / from_json() for persistence

### DamageCalculator
- **Purpose**: Compute damage using Gen 9 formula with pluggable modifiers
- **Formula**: Base = floor(((2*Level/5 + 2) * Power * A / D) / 50 + 2)
- **Modifier System**: DamageModifier base class with priority-ordered hooks
- **Modifier Hooks**:
  - modify_offense(stat_value, context)
  - modify_defense(stat_value, context)
  - modify_damage(base_damage, context)
  - modify_type_effectiveness(effectiveness, context)
  - modify_stab(stab, context)
  - should_skip(context) → for immunities

### Built-in Modifiers
- ChoiceBandModifier (priority=50): Physical moves ×1.5
- ChoiceSpecsModifier (priority=50): Special moves ×1.5
- LifeOrbModifier (priority=80): All damage ×1.3
- EvioliteModifier (priority=50): Def/SpD ×1.5 for NFE
- AssaultVestModifier (priority=50): SpD ×1.5 for special moves

### MatchupEngine
- **Purpose**: Compute matchup scores using TTK-based scoring
- **Pipeline**:
  1. Compute TTK for A→B and B→A via DamageCalculator
  2. Factor in speed advantage (who attacks first)
  3. Map TTK differential to [-1.0, +1.0] score using tanh
  4. Generate tags (OHKO, 2HKO, outsped, immune, etc.)
- **Scoring Function**: _compute_ttk_score(ttk_ab, ttk_ba, speed_adv)
  - Special cases: mutual wall (0.0), one-sided win (±1.0)
  - Base score: tanh(ttk_diff / 2.5)
  - Speed adjustment: ±0.10 (±0.15 on TTK tie)

### MatchupCache
- **Purpose**: Precomputed pairwise matchup results for O(1) lookup
- **Key**: (attacker_id, defender_id) tuple
- **Fingerprinting**: SHA256 hash of Pokémon IDs, primary_set_ids, and move lists
- **Build**: Iterates all Pokémon pairs, computes best_move via DamageCalculator
- **Persistence**: JSON serialization with automatic invalidation on graph changes

---

## Intelligence Layer

### Query Functions (queries.py)
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

### Analytics (analytics.py)
- SetStats: Per-set statistics (avg_score, win_rate, avg_ttk, etc.)
- SpeciesMatchup: Aggregated matchup between two species
- SetRanking: Ranked list of sets by composite score
- compute_set_stats(kg, set_id): Compute stats for a single set
- compute_all_set_stats(kg): Compute stats for all sets
- aggregate_matchups_by_species(kg): Species-level matchup aggregation
| rank_sets(kg): MCTS-style ranking (win_rate + ttk + speed)
| get_best_set_per_species(kg): Best set for each species
| matchup_matrix(kg): Species × species matchup matrix

### 3D Matchup Graph (matchup_graph.py) — AI decision layer

- **Purpose**: Map every set (and team of sets) into a three-axis space for fast AI decision-making. The graph generalizes to single Pokémon, sets, and full teams.
- **Three Axes**:
  - **Axis 1 (Types)**: 18-cell discrete vector (one per Pokémon type) with type affinity, STAB coverage, and nuke-power bonuses. Each cell ∈ [0, 1].
  - **Axis 2 (Offense ↔ Defense)**: Continuous float in [-1, +1]. `+1.0` = pure sweeper, `-1.0` = pure wall, `0.0` = balanced. Formula: `tanh((offense/bulk - 0.5) * 2)`. For teams: BST-weighted average.
  - **Axis 3 (Speed / Control / Utility)**: 3-tuple in a 3-simplex (sum = 1, all ≥ 0). Speed is calibrated for level 100 (`(eff_spe - 100) / 150` clamped). For teams: mean of member SCU tuples, then projected to simplex.
- **Data structures**:
  - `MatchupGraphNode`: a single point in 3D space with all three axes + member_ids
  - `MatchupGraph`: container (plain dict) with `add()`, `get()`, `build_for_ou()`, JSON serialization
- **AI Queries** (return ranked dataclass lists with reasoning):
  - `pick_best_move(attacker, defender, kg) → list[MoveRanking]`: ranks the attacker's 4 moves by combining type effectiveness, STAB, base power, status utility, priority, and existing matchup damage data
  - `find_optimal_switch(opponent, candidates, kg) → list[SwitchRanking]`: ranks bench members using type-resist, speed advantage, precomputed matchup, and 3D distance
  - `analyze_game_state(my_active, opp_active, my_bench, kg) → TurnPlan`: composed decision: stay vs switch (threshold 0.3), with a full reasoning chain explaining the choice
- **Generalization**: All three axis projections accept `SetClass | str | list[SetClass | str]`, so they work uniformly for individual Pokémon, sets, and full teams.

### Polygonal-Solid Matchup Graph (matchup_graph.py) — visual layer

- **Purpose**: Map every set (and team of sets) into an 8-attribute × 18-type matrix that the GUI renders as a 2D radial polygon or 3D cylinder of stacked type-discs.  The visual is intuitive: bigger, well-shaped polygons = stronger sets; bright large discs in the cylinder = types the set dominates.
- **8 Attributes** (base → compound):
  - **Base (4)**: `attack` (highest STAB BP), `utility` (setup/status moves), `defense` (bulk from HP/def/SpD), `speed` (eff Spe normalized)
  - **Compound (4)**: `counter = attack + defense`, `sponge = utility + defense`, `threat = attack + speed`, `punish = utility + speed`
- **Per-type matrix** (8 × 18): each cell is the attribute value * weight(type, attribute); type weight depends on STAB and type effectiveness vs the 18 canonical types
- **Per-set role weight** (`WEIGHT_TABLE`): `sweeper / wall / pivot / cleric / staller / lead / default` — rebalances the 8 attributes for a given archetype before the type weighting
- **Vase sort**: types are reordered into ascending type-area permutation so the resulting 2D polygon / 3D cylinder is symmetric (the "vase" silhouette)
- **Volume** = `Σ_types (counter·sponge + threat·punish) · bias`; `bias = 0.5 + 0.5·mcts_composite` so well-ranked sets are visibly fuller
- **Data structures**:
  - `SetMatchupNode`: 8×18 `np.float32` attribute matrix + `vase_order` (list[int]) + `bias` (float) + `weights` (list[float]) + `pokemon_id`, `set_id`, `mcts_composite`
  - `compose_team_node(set_nodes)`: attributes sum, weights averaged, vase order = max-frequency union, bias = mean bias
  - `volume_of(attributes, bias)`: scalar volume
- **Per-set on-disk cache**: `data/graphs/nodes/{pokemon_id}/{set_id}.json` (+ `.meta.json` for mcts/bias/vase). Hooked into `KnowledgeGraph.save_set_yaml` so saving a set also caches the node
- **GUI**: `pokeredus/gui/matchup_graph_view.py` exposes `MatchupGraph2D` (radial polygon, "elaborate by types" toggle), `MatchupGraph3D` (stacked-disc cylinder, arrow keys / drag / wheel / click-to-pick), and `MatchupGraphView` (combined 2D/3D toggle with `set_set(pokemon_id, set_id)` and `set_team(set_ids, kg=None)`)
- **Wrappers**: `MatchupGraphPage` in the same file is the page wrapper used by `app._open_matchup_graph_page` (toolbar + set-list sidebar + view body)

---

## GUI Layer

### App Structure (app.py)
- Main window with navigation tabs
- Pokémon Browser (pokemon_panel.py)
- Team Builder (team_builder.py)
- Graph View (graph_view.py) - placeholder

### Pokémon Panel (pokemon_panel.py)
- Sidebar: Scrollable Pokémon list with filters
- Detail Panel: Species card, base stats, abilities, sets, matchups
- Filters: RegexSearchFilter, TypeFilter, ClassificationFilter
- Sprite Management: PIL-based with async download

### Team Builder (team_builder.py)
- 6-slot team grid (2×3 layout)
- TeamSlotCard: Empty or filled (sprite, name, set, type badges, moves)
- Set Selector Dialog: Modal for choosing Pokémon + set
- Save/Load: YAML serialization
- Showdown Export: Text format for Pokémon Showdown

### Set Editor (set_editor.py)
- Create/edit/duplicate/delete sets
- Form fields: moves, ability, item, nature, EVs, IVs, role, tera_type
- Matchup recomputation on save

---

## Data Flow

```
1. Import Phase (scripts/build_graph.py)
   Showdown/Smogon JSON → Importers → KnowledgeGraph → Save to JSON

2. Matchup Computation Phase
   KnowledgeGraph → MatchupEngine → MatchupRelation edges → Save to JSON
   KnowledgeGraph → MatchupCache → CachedMatchup entries → Save to JSON

3. Query Phase
   User Query → Intelligence Layer → KnowledgeGraph → Results

4. GUI Phase
   User Action → GUI Layer → Intelligence Layer → KnowledgeGraph → Display
```

---

## Current Limitations

### 1. Static Modifier System
- Modifiers are hardcoded classes (ChoiceBandModifier, LifeOrbModifier)
- No dynamic state tracking (boosts, status conditions, weather)
- No conditional logic (e.g., "if burned, physical damage ×0.5")

### 2. No Battle State Representation
- No GameState class to track active Pokémon, HP, status, boosts
- No turn-by-turn simulation capability
- Matchups are computed in isolation (no context)

### 3. Simplified Damage Calculation
- No stat stage modifiers (+1 Atk, -2 Def, etc.)
- No status condition effects (burn halves physical damage)
- No weather/terrain modifiers
- No multi-hit move averaging
- No critical hit consideration

### 4. No Complex Condition Handling
- No volatile conditions (confusion, flinch, trapping)
- No non-volatile conditions (burn, paralysis, poison, sleep, freeze)
- No field effects (weather, terrain, hazards)
- No ability/item interactions beyond static modifiers

### 5. No Learning/Feedback Loop
- Matchup scores are computed once and cached
- No mechanism to update scores based on battle outcomes
- No embedding vectors for semantic similarity
- No policy/value networks

---

## File Structure

```
pokeredus/
├── pokeredus/
│   ├── __init__.py
│   ├── config.py                    # Configuration constants
│   ├── classes/
│   │   ├── __init__.py              # Exports all classes
│   │   ├── pokemon.py               # PokemonClass
│   │   ├── sets.py                  # SetClass
│   │   ├── moves.py                 # MoveClass
│   │   ├── abilities.py             # AbilityClass
│   │   ├── items.py                 # ItemClass
│   │   ├── natures.py               # NatureClass + STANDARD_NATURES
│   │   ├── ev_spread.py             # EVSpreadClass
│   │   ├── types.py                 # TypeClass + TYPE_CHART
│   │   └── matchup.py               # MatchupRelation
│   ├── graph/
│   │   ├── __init__.py              # Exports graph functions
│   │   ├── knowledge_graph.py       # KnowledgeGraph (NetworkX)
│   │   ├── damage_calc.py           # DamageCalculator + DamageModifier
│   │   ├── matchup_engine.py        # compute_matchup, compute_all_matchups
│   │   ├── matchup_cache.py         # MatchupCache + CachedMatchup
│   │   ├── analytics.py             # SetStats, rankings, aggregation
│   │   └── queries.py               # Query functions
│   ├── gui/
│   │   ├── __init__.py
│   │   ├── app.py                   # Main application
│   │   ├── pokemon_panel.py         # Pokémon browser
│   │   ├── team_builder.py          # Team builder
│   │   ├── set_editor.py            # Set editor
│   │   ├── graph_view.py            # Graph visualization (placeholder)
│   │   ├── matchup_panel.py         # Matchup display
│   │   ├── theme.py                 # GUI theme constants
│   │   ├── sprites.py               # Sprite management
│   │   └── team_store.py            # Team persistence
│   ├── importers/
│   │   ├── __init__.py
│   │   ├── showdown_importer.py     # Import from Showdown JSON
│   │   └── smogon_importer.py       # Import from Smogon
│   └── utils/
│       ├── __init__.py
│       └── data_io.py               # I/O helpers
├── data/
│   ├── raw/                         # Imported JSON data
│   ├── sets/                        # User-created sets (YAML)
│   ├── graphs/                      # Serialized knowledge graphs
│   ├── teams/                       # Saved teams (YAML)
│   └── cache/                       # Matchup cache
├── scripts/
│   ├── build_graph.py               # Build knowledge graph
│   ├── fetch_moves.py               # Fetch move data from Showdown
│   ├── fetch_base_stats.py          # Fetch base stats from PokeAPI
│   ├── download_sprites.py          # Download sprites
│   └── launch.py                    # Launch GUI
├── tests/
│   ├── test_classes.py              # Domain class tests
│   ├── test_graph.py                # Knowledge graph tests
│   ├── test_matchup.py              # Matchup engine tests
│   ├── test_import.py               # Importer tests
│   └── test_phase5.py               # Phase 5 tests
├── pyproject.toml
└── README.md
```

---

## Key Design Decisions

### 1. Set-Level Intelligence
All intelligence operates at the Set level, not the species level. "Garchomp" is a PokemonClass; "Garchomp Swords Dance + Scale Shot w/ Loaded Dice" is a SetClass. This allows precise matchup analysis.

### 2. NetworkX for Knowledge Graph
NetworkX provides a flexible, well-tested graph library with built-in serialization. The DiGraph structure supports typed nodes and edges with arbitrary attributes.

### 3. Pluggable Modifier System
The DamageCalculator uses a priority-ordered modifier system. This allows items, abilities, and other effects to hook into the damage calculation without modifying the core formula.

### 4. TTK-Based Scoring
Matchup scores are derived from turns-to-kill differentials and speed advantage, producing more accurate predictions than pure type-effectiveness heuristics.

### 5. Composite Sets for Caching
The MatchupCache uses composite sets (primary set stats + union of all moves) to represent each species. This balances accuracy with cache size.

### 6. Fingerprint-Based Invalidation
The MatchupCache embeds a SHA256 fingerprint of the graph. When the graph changes, the cache is automatically invalidated and rebuilt.

---

## Performance Characteristics

- **Knowledge Graph**: ~118 Pokémon, ~270 sets, ~954 moves, ~89 MB serialized
- **Matchup Graph**: ~72,630 pairwise edges (270 × 270 - 270)
- **Matchup Cache**: ~13,924 entries (118 × 118 - 118), ~2 MB
- **Graph Build Time**: ~90 seconds for full matchup computation
- **Query Time**: O(1) for indexed lookups, O(n) for filtered queries
- **GUI Load Time**: <2 seconds for 118 Pokémon with sprites

---

## Dependencies

- **networkx**: Graph data structure
- **pyyaml**: Set/team serialization
- **requests**: Fetching Showdown/Smogon data
- **tkinter**: GUI (ships with Python)
- **PIL (Pillow)**: Sprite processing and gradient generation

---

## Future Directions

### Phase 7: Intelligence Layer Enhancements
1. **Dynamic State System**: Track battle state (HP, status, boosts, weather, terrain)
2. **Attribute/Effect System**: Generalized conditions and modifiers
3. **Turn Simulation**: Step-by-step battle simulation with state transitions
4. **Event System**: Trigger-based effects (on_switch_in, on_damage, on_faint)

### Phase 8: Learning & Adaptation
1. **Battle Logging**: Record battle outcomes and decisions
2. **Embedding Vectors**: Learned representations for semantic similarity
3. **Policy/Value Networks**: Neural networks for action selection
4. **Class Refinement**: Automatic set splitting/merging based on performance

### Phase 9: MCTS Integration
1. **GameState Representation**: Full battle state for MCTS
2. **Action Space**: 4 moves + switches
3. **Rollout Policy**: Heuristic + learned policy
4. **Value Estimation**: Position evaluation

### Phase 10: Battle Automation
1. **poke-env Integration**: Connect to Pokémon Showdown server
2. **Agent Class**: Wrap MCTS + knowledge graph
3. **Browser Automation**: Optional DOM-based play
4. **Self-Play Training**: Improve through practice
