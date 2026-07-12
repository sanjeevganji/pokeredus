## Team Archetypes Overview

### Source
`pokeredus/gui/team_builder.py` — 6-slot team construction.
`pokeredus/graph/queries.py` — Coverage and weakness analysis.

### Team Structure
- **6 Pokémon** per team, arranged in a **2×3 grid** (2 columns, 3 rows).
- Constants: `TEAM_SIZE = 6`, `SLOT_ROWS = 3`, `SLOT_COLS = 2`.
- Each slot is a `TeamSlotCard` showing: sprite, name, set name, type badges, role badge, item, ability, moves (2-column grid), and speed stat.

### Team Builder UI (`TeamBuilderPage`)
- **Top bar**: Back button, team name (editable), Export and Save buttons.
- **Left half** (~50%): 2×3 grid of team slot cards.
- **Right half** (~50%): Team analysis panel (placeholder for future features).
- Auto-save on changes; export to Pokémon Showdown format.

### Pokemon/Set Selector Dialog
- Modal dialog for selecting a Pokémon + set combo for a slot.
- **Search bar** (by name) and **type filter** (dropdown of all 18 types).
- Left pane: scrollable list of Pokémon with sprites, names, type badges, set count.
- Right pane: shows available sets for selected Pokémon (set name, role badge, item, ability, nature, moves).
- Confirm button to add to team.

### Team Slot States
- **Empty**: Shows "+" icon and slot number. Click to open selector.
- **Filled**: Shows full Pokémon detail with Change/Remove buttons and primary-star toggle.

### Coverage Analysis (`queries.py`)
All functions operate on a `KnowledgeGraph` instance.

**`best_checks(kg, set_id, top_n=5)`**
- Returns sets that **check** the target (inbound matchups with `score > 0.2`).

**`best_counters(kg, set_id, top_n=5)`**
- Returns sets that **counter** the target (inbound matchups with `score >= 0.6`).

**`threats_to(kg, set_id, top_n=5)`**
- Returns sets that the target **threatens** (outbound matchups with `score > 0.2`).

**`weaknesses_of(kg, set_id, top_n=5)`**
- Returns sets that the target **loses to** (outbound matchups with `score < -0.2`).

### Team-Wide Analysis

**`team_coverage(kg, set_ids)`**
- Returns a dict mapping each team member to its favorable matchups (`score > 0.2`).

**`team_weaknesses(kg, set_ids)`**
- Returns a dict mapping each team member to its unfavorable matchups (`score < -0.2`).

**`gaps(kg, set_ids)`**
- Finds meta threats that **no team member handles well** (`best_score < 0.3`).
- Returns list of `{threat_id, threat_name, pokemon_id, best_answer, best_score}`.

### Team Composition Concepts
- **Type Distribution**: Team summary shows all unique types across team members.
- **Role Distribution**: Count of each role on the team (via `role_summary()`).
- **Speed Tier Chart**: All sets sorted by effective speed (via `speed_ranking()`).
- The analysis pane (right half) lists upcoming planned features:
  - Type Coverage Matrix
  - Defensive Profile
  - Speed Tier Chart
  - Role Distribution
  - Matchup Table vs Meta
  - Gap Analysis & Suggestions

### 3D Matchup Graph Projection (Team Level)
- Teams can be projected into the 3D matchup graph space via `project_to_3d()`.
- Type axis: element-wise mean of per-member type vectors.
- Offense/Defense axis: BST-weighted average of member scores.
- Speed/Control/Utility axis: mean of member SCU tuples.
