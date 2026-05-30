# PokeRedus: Class-Based Pokémon Intelligence Architecture

## Overview

PokeRedus is an object-oriented, class-based AI system for Pokémon Showdown focused on the OU tier. The core primitive is the **Pokémon Set** — not the raw Pokémon species. A Pokémon species (e.g., Garchomp) is a class; a Set (e.g., "Garchomp Swords Dance + Scale Shot") is a *configuration instance* of that class. All intelligence — matchup scoring, team building, threat analysis — operates at the Set level.

The system has three layers:

1. **Knowledge Layer** — class definitions, set templates, imported data
2. **Graph Layer** — matchup relationships between sets, scored and embedded
3. **Intelligence Layer** — algorithms that query the graph to make decisions

---

## 1. Class Hierarchy

### 1.1 Base Classes

```
PokemonClass          — species-level: base stats, typing, abilities, learnset
  └─ SetClass         — a competitive configuration: 4 moves + item + ability + nature + EV spread + role tag

MoveClass             — move properties: type, category, power, accuracy, priority, effects
AbilityClass          — ability name + effect description + activation conditions
ItemClass             — item name + effect + consumed flag
NatureClass           — stat modifiers (+10% / -10%)
EVSpreadClass         — named EV allocations (e.g., "252 Atk / 4 SpD / 252 Spe Jolly")
TypeClass             — one of 18 types, with offensive/defensive multipliers
```

### 1.2 Relation Classes (edges in the knowledge graph)

```
MatchupRelation       — SetClass → SetClass with a score (-1.0 to +1.0)
  subtypes:
    ThreatRelation    — "Set A threatens Set B" (offensive pressure)
    CheckRelation     — "Set A checks Set B" (can switch in and wall/revenge)
    CounterRelation   — "Set A counters Set B" (hard walls, wins 1v1)
    RevengeRelation   — "Set A revenge-kills Set B" (outspeeds + KOs after chip)

HasMove               — SetClass → MoveClass
HasAbility            — SetClass → AbilityClass
HoldsItem             — SetClass → ItemClass
HasNature             — SetClass → NatureClass
HasEVSpread           — SetClass → EVSpreadClass
HasType               — PokemonClass → TypeClass (1 or 2)
```

### 1.3 Extensible Attributes (future-complex, not implemented in MVP)

Each SetClass can later carry dynamically computed fields:

- **Threat Score** — aggregate offensive pressure across the meta
- **Exploitability** — how easily the set is shut down by common checks
- **Survivability** — estimated turns alive against average meta pressure
- **Role Classification** — sweeper, wall, pivot, wallbreaker, stallbreaker, hazard setter, cleric
- **Win Condition Strength** — how reliably the set closes games once ahead
- **Speed Tier** — where the set sits in the speed distribution of the meta

These are computed by algorithms over the matchup graph, not stored statically. They recompute when the graph changes.

---

## 2. Knowledge Graph Structure

### 2.1 Graph Schema

The knowledge graph is a directed, weighted, typed multigraph:

- **Nodes**: instances of PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass, TypeClass
- **Edges**: instances of MatchupRelation and its subtypes, plus HasMove, HasType, etc.
- **Edge weights**: matchup scores (float), confidence (float), sample count (int)

### 2.2 Matchup Scoring

Each MatchupRelation carries:

| Field        | Type    | Description                                         |
|-------------|---------|-----------------------------------------------------|
| score       | float   | -1.0 (set B wins) to +1.0 (set A wins)             |
| confidence  | float   | 0.0 to 1.0, based on sample size and consistency    |
| sample_count| int     | number of observed/analyzed encounters               |
| source      | enum    | "manual", "imported", "learned", "type_calc"        |
| tags        | list    | e.g., ["OHKO", "2HKO", "forced_switch", "setup_fodder"] |

**Initial scoring** is computed from type effectiveness + base stat matchups (a formula). **Refined scoring** comes from battle logs and expert data.

### 2.3 Type Effectiveness Matrix

The foundation of matchup scoring. Stored as a 18×18 matrix (TypeClass × TypeClass → multiplier). Imported from game data. Used to compute raw damage potential before set-specific adjustments.

### 2.4 Storage

- **Static data** (species, moves, abilities, items, types): JSON imports from Smogon/Showdown data repos
- **Set definitions**: YAML or JSON files, editable via GUI
- **Matchup graph**: SQLite with a graph-compatible schema, or NetworkX serialized to JSON for portability
- **Embeddings** (future): numpy arrays stored alongside the graph

---

## 3. Data Import Pipeline

### 3.1 Sources

| Data              | Source                                                  | Format  |
|------------------|---------------------------------------------------------|---------|
| Pokédex (species) | `pokemon-showdown/data/pokedex.ts` or Smogon JSON       | JSON    |
| Moves            | `pokemon-showdown/data/moves.ts`                        | JSON    |
| Abilities        | `pokemon-showdown/data/abilities.ts`                    | JSON    |
| Items            | `pokemon-showdown/data/items.ts`                        | JSON    |
| Type chart        | `pokemon-showdown/data/typechart.ts`                    | JSON    |
| OU Sets (sample)  | Smogon StrategyDex, usage stats, `data/sets/`           | JSON    |
| Natures          | `pokemon-showdown/data/natures.ts`                      | JSON    |

### 3.2 Import Steps

1. Parse raw JSON → instantiate PokemonClass, MoveClass, AbilityClass, ItemClass, TypeClass nodes
2. Build type effectiveness matrix from typechart
3. Import sample sets from Smogon → instantiate SetClass nodes with HasMove, HasAbility, etc. edges
4. Compute initial matchup scores using type chart + base stat heuristics
5. Populate the matchup graph with MatchupRelation edges

### 3.3 OU Tier Filtering

Only import Pokémon and sets that are legal in the current OU tier. The OU pool is ~35-40 Pokémon with ~100-150 viable sets. This keeps the graph small enough for exhaustive pairwise matchup computation.

---

## 4. GUI Architecture — Team Builder

### 4.1 Purpose

A desktop GUI that serves as:
- A **Pokédex browser** — view all Pokémon classes in the OU tier
- A **Set editor** — view, create, edit, delete sets for each Pokémon
- A **Team builder** — assemble 6-Pokémon teams and see aggregate matchup coverage
- A **Matchup viewer** — inspect the graph visually

### 4.2 Technology

**Python + Tkinter** (or optionally PyQt6/PySide6 for richer UI). Rationale:
- Native, no browser dependency
- Fast iteration
- Integrates directly with the knowledge graph Python objects
- Tkinter ships with Python; PyQt6 is a `pip install` away if needed

### 4.3 GUI Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  PokeRedus — OU Intelligence Builder                            │
├──────────┬──────────────────────────────────────────────────────┤
│          │                                                       │
│ POKEMON  │  DETAIL PANEL                                         │
│ LIST     │                                                       │
│          │  [Species Card]                                       │
│ ▸Garchomp│    Type: Dragon/Ground                                │
│ ▸Dragapult│   Base Stats: 108/130/95/80/85/102                  │
│ ▸Heatran │   Abilities: Sand Veil, Rough Skin                   │
│ ▸Toxapex │                                                       │
│ ▸...     │  SETS                                                 │
│          │  ┌──────────────────────────────────┐                │
│ [Add New]│  │ ● Swords Dance + Scale Shot      │                │
│          │  │   Item: Loaded Dice  Ability: ... │                │
│          │  │ ● Specially Defensive             │                │
│          │  │ ● Choice Scarf                    │                │
│          │  │ + Add New Set                     │                │
│          │  └──────────────────────────────────┘                │
│          │                                                       │
│          │  MATCHUP SNIPPET (for selected set)                   │
│          │  Threatens: Dragapult, Iron Valiant...                │
│          │  Checked by: Clefable, Toxapex...                    │
│          │  Counters: Skarmory, Dondozo...                      │
│          │                                                       │
├──────────┴──────────────────────────────────────────────────────┤
│  [Team Builder]  [Matchup Graph]  [Import Data]  [Export]       │
└─────────────────────────────────────────────────────────────────┘
```

### 4.4 GUI Components

| Component          | Function                                                    |
|-------------------|-------------------------------------------------------------|
| PokemonListPanel  | Scrollable list of OU Pokémon. Filter by type. Select → loads detail. |
| DetailPanel       | Shows species card (types, stats, abilities) + list of sets. |
| SetEditor         | Form to create/edit a set: dropdowns for moves, item, ability; fields for EVs and nature. |
| MatchupSnippet    | Mini-table showing threats/checks/counters for the selected set, with scores. |
| TeamBuilderPanel  | Drag-drop or click-to-add 6 sets. Shows aggregate type coverage, hazard support, speed tiers. |
| MatchupGraphPanel | Visual graph (tkinter Canvas or matplotlib embedded) showing Set nodes and MatchupRelation edges, color-coded by score. |
| ImportPanel       | Button to trigger JSON import pipeline. Progress bar. Status log. |

### 4.5 GUI Data Flow

```
[JSON Import] → KnowledgeGraph.add_pokemon() / add_set()
     ↓
[PokemonListPanel] ← KnowledgeGraph.get_ou_pokemon()
     ↓ (user selects)
[DetailPanel] ← KnowledgeGraph.get_sets(pokemon_id)
     ↓ (user selects set)
[MatchupSnippet] ← KnowledgeGraph.get_matchups(set_id)
     ↓ (user edits set)
[SetEditor] → KnowledgeGraph.update_set(set_id, changes) → recompute matchups
```

---

## 5. Graph-Based Matchup Intelligence

### 5.1 Matchup Computation Pipeline

```
Step 1: Type Effectiveness
  For Set A vs Set B:
    - Compute A's STAB moves vs B's typing → damage multiplier range
    - Compute B's STAB moves vs A's typing → damage multiplier range
    - Factor in resistances and immunities

Step 2: Stat Comparison
  - Speed: who moves first? (critical for revenge-killing)
  - Offensive stats vs defensive stats: estimated damage ranges
  - Bulk: HP × Def / HP × SpD

Step 3: Set-Specific Factors
  - Item effects (Choice locked? Leftovers recovery? Heavy-Duty Boots?)
  - Ability interactions (Intimidate, Unaware, Magic Guard)
  - Move coverage (does A have a move that hits B super-effectively?)
  - Setup potential (can A set up on B safely?)

Step 4: Aggregate Score
  score = f(type_advantage, speed_advantage, damage_range, survivability)
  Mapped to [-1.0, +1.0] where positive favors Set A
```

### 5.2 Graph Queries

The intelligence layer exposes these queries:

| Query                     | Returns                                              |
|--------------------------|------------------------------------------------------|
| `best_checks(set_id)`    | Top N sets that check this set, ranked by score      |
| `best_counters(set_id)`  | Top N sets that hard-counter this set                |
| `threats_to(set_id)`     | Top N sets that threaten this set                    |
| `team_coverage(set_ids)` | Aggregate matchup table for a 6-mon team             |
| `gaps(set_ids)`          | Sets in the meta that the team struggles against     |
| `speed_tier(set_id)`     | Where this set falls in the meta speed distribution  |
| `role_summary(set_ids)`  | Role distribution of the team (sweeper/pivot/wall)   |

### 5.3 Scoring System for Team Building

When evaluating a team of 6 sets:

```
team_score = Σ (coverage_bonus[i] for each meta set i)
           - Σ (hard_loss_penalty[j] for each uncountered threat j)
           + synergy_bonus(hazard_setter + remover present)
           + role_balance_bonus(spread across roles)
```

This is a configurable scoring function. The GUI shows a breakdown so the user sees *why* a team scores well or poorly.

---

## 6. Implementation Phases

### Phase 0: Project Scaffolding

- Python package structure
- Dependencies: `networkx`, `tkinter`, `pyyaml`, `requests`
- Config file for tier, import paths, GUI settings

### Phase 1: Data Layer

- Define all class dataclasses (PokemonClass, SetClass, MoveClass, etc.)
- Implement JSON importers for Showdown data
- Implement OU tier filter
- Build the KnowledgeGraph container (NetworkX-backed)
- Unit tests for import + graph queries

### Phase 2: Matchup Engine

- Implement type effectiveness matrix
- Implement matchup scoring formula (type + stat + set factors)
- Build full pairwise matchup graph for OU sets
- Expose graph queries (best_checks, threats_to, team_coverage)
- Unit tests for scoring consistency

### Phase 3: GUI — Pokémon Browser + Set Editor

- Tkinter main window with list panel + detail panel
- Set editor form (create/edit/delete)
- Matchup snippet display
- Import button wired to data layer
- Export sets to JSON

### Phase 4: GUI — Team Builder

- Team slot panel (6 slots)
- Aggregate matchup display (coverage table)
- Gap analysis (what beats this team)
- Role/speed distribution view

### Phase 5: GUI — Matchup Graph Visualization

- Canvas-based graph drawing (nodes = sets, edges = matchups)
- Color-coded edges (green = favorable, red = unfavorable)
- Click node → show matchups
- Filter by role, type, score threshold

### Phase 6: Intelligence Layer (future)

- Survivability, exploitability, threat score algorithms
- Dynamic recalculation when sets or matchup data change
- MCTS-based team optimizer
- Battle log ingestion → learned matchup score updates

---

## 7. Orchestrator Prompt Sequence

These prompts are designed to be given sequentially to a coding agent in Hermes. Each prompt is self-contained and builds on the previous phase's output.

---

### PROMPT 0 — Project Setup

```
You are building PokeRedus, a class-based Pokémon intelligence system for the OU tier.

Set up the Python project:

1. Create the directory structure:
   pokeredus/
   ├── pokeredus/
   │   ├── __init__.py
   │   ├── config.py           # tier settings, paths, constants
   │   ├── classes/
   │   │   ├── __init__.py
   │   │   ├── pokemon.py      # PokemonClass dataclass
   │   │   ├── moves.py        # MoveClass dataclass
   │   │   ├── abilities.py    # AbilityClass dataclass
   │   │   ├── items.py        # ItemClass dataclass
   │   │   ├── natures.py      # NatureClass dataclass
   │   │   ├── types.py        # TypeClass + effectiveness matrix
   │   │   ├── ev_spread.py    # EVSpreadClass dataclass
   │   │   └── sets.py         # SetClass dataclass
   │   ├── graph/
   │   │   ├── __init__.py
   │   │   ├── knowledge_graph.py   # KnowledgeGraph container
   │   │   ├── matchup_engine.py    # Matchup scoring logic
   │   │   └── queries.py           # Graph query functions
   │   ├── importers/
   │   │   ├── __init__.py
   │   │   ├── showdown_importer.py # Parse Showdown JSON data
   │   │   └── smogon_importer.py   # Parse Smogon set data
   │   ├── gui/
   │   │   ├── __init__.py
   │   │   ├── app.py              # Main Tkinter application
   │   │   ├── pokemon_panel.py    # Pokemon list + detail
   │   │   ├── set_editor.py       # Set creation/editing form
   │   │   ├── matchup_panel.py    # Matchup display
   │   │   ├── team_builder.py     # Team assembly panel
   │   │   └── graph_view.py       # Matchup graph visualization
   │   └── utils/
   │       ├── __init__.py
   │       └── data_io.py         # JSON/YAML read/write helpers
   ├── data/
   │   ├── raw/                   # Imported JSON from Showdown
   │   ├── sets/                  # User-defined set YAML files
   │   └── graphs/                # Serialized matchup graphs
   ├── tests/
   │   ├── test_classes.py
   │   ├── test_graph.py
   │   ├── test_matchup.py
   │   └── test_import.py
   ├── pyproject.toml
   └── README.md

2. pyproject.toml dependencies: networkx, pyyaml, requests
3. Create a minimal config.py with TIER = "gen9ou", DATA_DIR paths
4. Create empty __init__.py files everywhere
5. Create a README with the project description

Do not implement any logic yet — just the skeleton and config.
```

---

### PROMPT 1 — Data Classes

```
Phase 1: Define the class hierarchy for PokeRedus.

Implement the following as Python dataclasses (using @dataclass or pydantic if preferred):

1. TypeClass:
   - name: str (e.g., "Fire")
   - effectiveness: dict[str, float]  # target_type → multiplier

2. MoveClass:
   - id: str
   - name: str
   - type: str
   - category: str  # "Physical", "Special", "Status"
   - base_power: int
   - accuracy: int
   - priority: int
   - pp: int
   - target: str
   - flags: list[str]  # "contact", "protectable", etc.
   - secondary_effects: list[dict]  # optional

3. AbilityClass:
   - id: str
   - name: str
   - description: str
   - flags: list[str]  # "on_switch_in", "persistent", etc.

4. ItemClass:
   - id: str
   - name: str
   - description: str
   - consumed: bool  # one-time use like berries

5. NatureClass:
   - name: str
   - increased_stat: str | None  # "atk", "def", "spa", "spd", "spe"
   - decreased_stat: str | None

6. EVSpreadClass:
   - hp: int, atk: int, def: int, spa: int, spd: int, spe: int
   - label: str  # e.g., "252 Atk / 4 SpD / 252 Spe"
   - validate(): sum must be ≤ 508, each ≤ 252

7. PokemonClass:
   - id: str
   - name: str
   - types: list[str]
   - base_stats: dict  # hp, atk, def, spa, spd, spe
   - abilities: list[str]  # ability IDs
   - weight: float
   - tier: str

8. SetClass:
   - id: str  # auto-generated: "{pokemon_id}_{set_name}"
   - pokemon_id: str
   - set_name: str  # e.g., "Swords Dance"
   - ability: str
   - item: str
   - nature: NatureClass
   - evs: EVSpreadClass
   - moves: list[str]  # 4 move IDs
   - ivs: dict  # defaults to 31
   - role: str  # "sweeper", "wall", "pivot", "wallbreaker", etc.
   - tera_type: str  # for Gen 9

9. MatchupRelation:
   - set_a_id: str
   - set_b_id: str
   - score: float  # -1.0 to +1.0
   - confidence: float  # 0.0 to 1.0
   - sample_count: int
   - source: str  # "manual", "type_calc", "learned"
   - tags: list[str]

Each class should have:
- A unique ID field
- A to_dict() method for serialization
- A from_dict() classmethod for deserialization
- Proper __repr__

Place each in its corresponding file under pokeredus/classes/.
```

---

### PROMPT 2 — Knowledge Graph

```
Phase 2: Implement the KnowledgeGraph container and type effectiveness system.

1. Type effectiveness matrix in pokeredus/classes/types.py:
   - Build the full 18×18 type chart as a dict-of-dicts
   - Import from the standard Pokémon type chart (0, 0.25, 0.5, 1, 2, 4)
   - Function: get_effectiveness(attacking_type, defending_types) → float
   - Function: get_best_effectiveness(attacker_types, defender_types) → (best_type, multiplier)

2. KnowledgeGraph in pokeredus/graph/knowledge_graph.py:
   - Use NetworkX DiGraph as the backing store
   - Node types: "pokemon", "set", "move", "ability", "item", "type"
   - Edge types: "has_type", "has_move", "has_ability", "holds_item", "has_nature", "has_ev_spread", "matchup"
   - Methods:
     - add_pokemon(PokemonClass) → adds node + has_type edges
     - add_set(SetClass) → adds node + edges to pokemon, moves, ability, item
     - add_matchup(MatchupRelation) → adds weighted edge between two set nodes
     - get_pokemon(pokemon_id) → PokemonClass
     - get_sets(pokemon_id) → list[SetClass]
     - get_set(set_id) → SetClass
     - get_ou_pokemon() → list[PokemonClass]  # filter by tier
     - get_matchups(set_id, min_confidence=0.5) → list[MatchupRelation]
     - remove_set(set_id) → removes node + all edges
     - to_json() / from_json() → serialize/deserialize entire graph

3. Persistence:
   - Save/load graph to data/graphs/ou_matchup_graph.json
   - Save individual sets as YAML files in data/sets/{pokemon_id}/{set_name}.yaml

Include unit tests in tests/test_graph.py that verify:
- Adding a pokemon and retrieving it
- Adding a set and querying it by pokemon
- Adding a matchup and querying it by set
- Serialization round-trip
```

---

### PROMPT 3 — Data Import

```
Phase 3: Implement data importers to populate the knowledge graph from Showdown data.

1. showdown_importer.py:
   - Download or load from local files:
     - pokedex data (species, types, base stats, abilities)
     - moves data (name, type, power, accuracy, category, priority)
     - abilities data
     - items data
     - natures data
   - Parse into the class dataclasses
   - Filter to OU tier only
   - Load into KnowledgeGraph
   - Function: import_showdown_data(graph: KnowledgeGraph, data_dir: str)

2. smogon_importer.py:
   - Import sample competitive sets from Smogon strategy data
   - Can be hardcoded YAML/JSON format initially
   - For each OU Pokémon, include 1-3 standard sets with:
     - Standard moveset, item, ability, nature, EVs, role tag
   - Function: import_smogon_sets(graph: KnowledgeGraph, sets_dir: str)

3. Matchup computation in pokeredus/graph/matchup_engine.py:
   - Given two SetClass instances, compute a matchup score using:
     a. Type effectiveness (STAB moves vs opponent's typing)
     b. Speed comparison (who moves first)
     c. Offensive power vs defensive bulk (estimated damage %)
     d. Coverage moves (does the set have super-effective coverage?)
     e. Item and ability modifiers (Choice Scarf speed, Intimidate, etc.)
   - Score mapped to [-1.0, +1.0]
   - Function: compute_matchup(set_a: SetClass, set_b: SetClass, graph: KnowledgeGraph) → MatchupRelation
   - Function: compute_all_matchups(graph: KnowledgeGraph) → fills in all pairwise matchups for OU sets

4. CLI entry point: scripts/build_graph.py
   - Imports all data, computes matchups, saves graph
   - Prints summary: N pokemon, N sets, N matchup edges

Include unit tests in tests/test_import.py and tests/test_matchup.py.
```

---

### PROMPT 4 — GUI: Pokémon Browser + Set Editor

```
Phase 4: Build the first GUI layer using Tkinter.

Create pokeredus/gui/app.py as the main application window with:

1. PokemonListPanel (left sidebar):
   - Scrollable list of all OU Pokémon loaded from KnowledgeGraph
   - Each entry shows: name + type icons (text abbreviations like "DG" for Dragon/Ground)
   - Filter bar at top: text search + type dropdown filter
   - Click → populates DetailPanel

2. DetailPanel (right main area):
   - Top section: species card
     - Name, types (colored labels), base stats (mini bar chart or text table)
     - Abilities listed
   - Middle section: sets list
     - Each set shown as a card: set name, item, ability, first move
     - "Edit" and "Delete" buttons per set
     - "+ Add New Set" button at bottom
   - Bottom section: matchup snippet for selected set
     - Table: "Threatens" (top 5), "Checked by" (top 5), "Counters" (top 5)
     - Each row: set name + score bar (green to red)

3. SetEditor (popup dialog or embedded panel):
   - Triggered by "Add New Set" or "Edit"
   - Fields:
     - Set name (text entry)
     - Ability (dropdown from PokemonClass.abilities)
     - Item (dropdown from all items)
     - Nature (dropdown from all natures)
     - EVs (6 number entries with labels, or a text field for "252 Atk / 4 SpD / 252 Spe")
     - Tera Type (dropdown of 18 types)
     - 4 Move slots (dropdowns filtered by learnset)
     - Role (dropdown: sweeper, wall, pivot, wallbreaker, etc.)
   - Save button → KnowledgeGraph.add_set() or update_set()
   - After save, recompute matchups for this set against all others

4. Menu bar:
   - File → Import Data, Export Graph, Exit
   - Edit → Preferences (set tier, theme)
   - View → Show Matchup Graph (opens graph_view, Phase 6)

5. Status bar at bottom: shows current graph stats (X Pokémon, Y sets, Z matchups)

Style: clean, functional. Use tkinter ttk widgets for a modern look. No need for fancy graphics — information density matters more than aesthetics.
```

---

### PROMPT 5 — GUI: Team Builder

```
Phase 5: Add a Team Builder panel to the GUI.

Create pokeredus/gui/team_builder.py:

1. TeamBuilderPanel:
   - 6 team slots displayed horizontally or in a 2×3 grid
   - Each slot shows: Pokémon name, set name, sprite placeholder (text), typing
   - Click empty slot → opens Pokémon/set selector (reuse PokemonListPanel filtering)
   - Click filled slot → shows detail + option to change/remove

2. Aggregate Analysis Panel (below team slots):
   - Type Coverage Matrix: 18×6 grid showing each team member's offensive coverage
   - Defensive Profile: for each of the 18 types, show how many team members resist/are weak to it
   - Speed Tier Chart: horizontal bar showing each set's speed stat, sorted
   - Role Distribution: pie chart or text summary (2 sweepers, 1 wall, 2 pivots, 1 wallbreaker)

3. Matchup Table:
   - Rows: each OU meta threat (top ~30 sets by usage/threat score)
   - Columns: each of the 6 team members
   - Cells: matchup score (color-coded green/yellow/red)
   - Right column: "Best Answer" — which team member handles this threat best
   - Bottom row: team's aggregate score against each threat

4. Gap Analysis:
   - Highlight threats where no team member has a favorable matchup (score > 0.3)
   - Suggest Pokémon/sets that would cover the gap (query graph for sets that counter the uncovered threats)

5. Team Save/Load:
   - Save team as YAML: { team_name, sets: [set_ids...] }
   - Load team from YAML
   - Export team as text (Pokémon Showdown importable format)

This panel is a tab in the main notebook layout alongside the Pokémon browser.
```

---

### PROMPT 6 — GUI: Matchup Graph Visualization

```
Phase 6: Add a visual matchup graph viewer.

Create pokeredus/gui/graph_view.py:

1. GraphCanvas:
   - Tkinter Canvas widget
   - Each SetClass is a node, drawn as a colored circle with text label
   - Node color: based on role (sweeper=red, wall=blue, pivot=green, wallbreaker=orange)
   - Node size: based on threat score (bigger = more threatening)

2. MatchupEdges:
   - Draw edges between sets that have MatchupRelations
   - Edge color: green (favorable for source) to red (unfavorable)
   - Edge thickness: based on confidence
   - Only show edges above a configurable confidence threshold (slider control)

3. Interaction:
   - Click node → highlight all its matchup edges, show matchup details in sidebar
   - Hover → tooltip with set summary
   - Zoom in/out with mouse wheel or +/- buttons
   - Pan by click-drag on empty space
   - Filter controls: by role, by type, by score range

4. Layout:
   - Use NetworkX spring layout (fruchterman_reingold) for initial positioning
   - Button to re-layout
   - Button to center on selected node

5. Subgraph Views:
   - "Show team matchups" button: filter graph to only show nodes/edges relevant to the current team
   - "Show meta threats" button: show only the top N most-connected nodes
   - "Show counters to [selected]" button: show the selected set and all its counters/threats

This is a visualization aid, not a primary interaction surface. Keep it performant for ~150 nodes and ~5000 edges (the OU meta is small enough).
```

---

## 8. Directory Structure Summary

```
pokeredus/
├── pokeredus/
│   ├── __init__.py
│   ├── config.py
│   ├── classes/
│   │   ├── __init__.py
│   │   ├── pokemon.py
│   │   ├── moves.py
│   │   ├── abilities.py
│   │   ├── items.py
│   │   ├── natures.py
│   │   ├── types.py
│   │   ├── ev_spread.py
│   │   ├── sets.py
│   │   └── matchup.py
│   ├── graph/
│   │   ├── __init__.py
│   │   ├── knowledge_graph.py
│   │   ├── matchup_engine.py
│   │   └── queries.py
│   ├── importers/
│   │   ├── __init__.py
│   │   ├── showdown_importer.py
│   │   └── smogon_importer.py
│   ├── gui/
│   │   ├── __init__.py
│   │   ├── app.py
│   │   ├── pokemon_panel.py
│   │   ├── set_editor.py
│   │   ├── matchup_panel.py
│   │   ├── team_builder.py
│   │   └── graph_view.py
│   └── utils/
│       ├── __init__.py
│       └── data_io.py
├── data/
│   ├── raw/
│   ├── sets/
│   └── graphs/
├── scripts/
│   └── build_graph.py
├── tests/
│   ├── test_classes.py
│   ├── test_graph.py
│   ├── test_matchup.py
│   └── test_import.py
├── pyproject.toml
└── README.md
```

---

## 9. Key Design Decisions

1. **Sets, not species, are the unit of intelligence.** A Pokémon species is a container; a Set is what you actually play. All matchups, scores, and queries operate at the Set level.

2. **The matchup graph is the core data structure.** Everything — team building, threat analysis, strategy — is a query over this graph. The graph is small enough (~150 nodes for OU) to be fully materialized and queried in real time.

3. **Type effectiveness is the foundation, not the ceiling.** Initial matchup scores come from type math. The architecture supports plugging in learned scores from battle data later, but the system works without any ML from day one.

4. **GUI is a first-class component, not an afterthought.** The team builder is the primary user interface for building and validating the knowledge base. It must be usable before any battle automation exists.

5. **Extensibility via computed attributes.** Fields like survivability, exploitability, and threat score are not stored — they are computed by algorithms over the matchup graph. New algorithms can be added without changing the class schema.

6. **Data import is batch, not streaming.** Import all Showdown data once, compute all matchups once, then incrementally update as the user edits sets. No real-time data dependency.
