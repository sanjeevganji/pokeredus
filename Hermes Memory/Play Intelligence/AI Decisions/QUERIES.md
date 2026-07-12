## AI Decisions — Move Selection, Switching, and Game State Analysis

### Source
`pokeredus/graph/matchup_graph.py` — 3D matchup graph and AI query functions.

### Data Structures

**`MoveRanking`** dataclass
- `move_id`, `move_name`, `score`, `reasoning` (human-readable)
- `type_effectiveness`: multiplier for move's type vs defender.
- `is_stab`: True if STAB for attacker.
- `estimated_damage_pct`: best-case damage roll as % of defender HP (0–100).

**`SwitchRanking`** dataclass
- `set_id`, `pokemon_id`, `set_name`, `score`
- `reasons`: list of human-readable explanations.
- `type_matchup`: product of incoming effectiveness (0–4).
- `speed_advantage`: `"us"`, `"them"`, or `"tie"`.

**`TurnPlan`** dataclass
- `recommended_switch`: `SwitchRanking | None` (None means stay in).
- `recommended_move`: `MoveRanking | None`.
- `confidence`: float in [0, 1].
- `reasoning_chain`: list of human-readable explanations.

### Query 1: `pick_best_move(attacker, defender, kg)`
Ranks every move in the attacker's set against the defender.

**Scoring** (additive, starting from 1.0):
- **Type effectiveness**: +0.6 if super-effective (×2), +0.3 if effective (>×1), -0.3 if resisted (<×1), -1.0 if immune (×0).
- **STAB**: +0.5 if move type matches attacker's types and move is not status.
- **Nuke-tier power**: +0.2 if base_power ≥ 100 and not status.
- **Status utility**: +0.3 if status move; +0.1 extra if attacker has recovery.
- **Priority**: +0.2 if priority > 0.
- **Damage hint**: if existing matchup data exists, adds `damage_pct / 100`.

Returns list sorted by score descending.

### Query 2: `find_optimal_switch(opponent, candidates, kg)`
Ranks candidate switch-ins against a single opponent.

**Scoring** (additive):
- **Type resist** (×0.4 weight): inverse of incoming type effectiveness product.
  - Immune (0): +2.0 score, "immune to opponent's STAB".
  - 4× resist (≤0.25): +2.0.
  - 2× resist (≤0.5): +1.0.
  - Neutral (≤1.0): +0.5.
  - Weak (≤2.0): 0.0.
  - 4× weak (>2.0): -1.0.
- **Speed advantage**: +0.4 if faster, -0.4 if slower, 0 if tie.
- **Precomputed matchup bonus** (×0.4): uses existing `MatchupRelation.score` if available.
- **3D distance penalty**: `-0.1 * euclidean_distance` in (offdef, SCU) space.

Returns list sorted by score descending.

### Query 3: `analyze_game_state(my_active, opp_active, my_bench, kg)`
Composed decision: switch or stay, and which move to use.

**Decision process**:
1. Project both active Pokémon into 3D space.
2. Compute active's matchup score vs opponent.
3. Compute each bench member's matchup score via `find_optimal_switch`.
4. If **best bench score > active score + threshold**, recommend switch; else stay.
5. Always pick a recommended move.
6. Build a reasoning chain documenting each step.

**Return**: `TurnPlan` with recommendations and confidence.

### Switch Threshold
- `SWITCH_ADVANTAGE_THRESHOLD: float = 0.3`
- If the best bench candidate scores at least 0.3 higher than the active's matchup score, the AI switches.

### Move Category Constants

**`PIVOT_OR_RECOVERY`** — moves that enable pivoting or healing:
- U-turn, Volt Switch, Parting Shot, Whirlwind, Roar, Haze
- Dragon Tail, Circle Throw
- Recover, Soft-Boiled, Slack Off, Wish, Roost
- Morning Sun, Moonlight, Synthesis, Milk Drink, Heal Order

**`HAZARD_SETTERS`** — entry hazard moves:
- Stealth Rock, Spikes, Toxic Spikes, Sticky Web

**`HAZARD_REMOVERS`** — hazard removal moves:
- Defog, Rapid Spin, Mortal Spin, Tidy Up

**`FIELD_SETTERS`** — weather, terrain, screens, and room moves:
- Sunny Day, Rain Dance, Sandstorm, Snowscape
- Electric Terrain, Grassy Terrain, Psychic Terrain, Misty Terrain
- Light Screen, Reflect, Aurora Veil, Tailwind, Trick Room

### Utility Scoring Weights
- `CONTROL_DENOMINATOR`: 3.0 (pivot/recovery moves count toward control).
- `UTILITY_HAZARD_SETTER_WEIGHT`: 0.4
- `UTILITY_HAZARD_REMOVER_WEIGHT`: 0.3
- `UTILITY_FIELD_SETTER_WEIGHT`: 0.3

### 3D Matchup Graph Axes
- **Axis 1** — Type affinity vector: 18-cell dict of type_name → [0, 1].
- **Axis 2** — Offense ↔ Defense: continuous [-1, +1] (positive = offensive).
- **Axis 3** — Speed / Control / Utility: 3-simplex summing to 1.
