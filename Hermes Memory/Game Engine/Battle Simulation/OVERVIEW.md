## Battle Simulation Overview

### Source
`pokeredus/graph/battle_simulator.py` — MCTS-style matchup analysis between Pokémon species.

### SpeciesProfile
- Aggregates the **best stats across all sets** of a species (at level 100).
- Fields: `pokemon_id`, `pokemon_name`, `max_hp`, `best_atk`, `best_def`, `best_spa`, `best_spd`, `best_spe`.
- Tracks which set ID provided the best value for each stat (e.g. `hp_set_id`, `atk_set_id`).
- Collects the **union of all move IDs** across all sets in `all_move_ids`.
- Collects all distinct `items` and `abilities` seen across sets.
- Stores a `primary_set_id` (the star set used as base for damage calc).
- `bst` property: sum of all best stats.

### MoveEvaluation Dataclass
- Fields: `move_id`, `move_name`, `move_type`, `move_category` (Physical/Special), `base_power`, `priority`.
- `min_damage` / `max_damage` / `avg_damage` — damage range across 16 rolls.
- `min_ttk` / `max_ttk` / `avg_ttk` — turns-to-kill range.
- `type_effectiveness`, `stab`, `is_immune`.
- `weight` (0.0–1.0): viability weight relative to the best move.

### SpeciesMatchupResult Dataclass
- Fields: `our_id`, `their_id`, `our_name`, `their_name`.
- `our_moves` / `their_moves`: lists of `MoveEvaluation`.
- `our_effective_ttk` / `their_effective_ttk`: weighted average TTK.
- `our_best_move`, `their_best_move`, best damage values.
- `our_speed`, `their_speed`, `speed_advantage` (`"us"`, `"them"`, `"tie"`).
- `score`: decimal MCTS score in [-1.0, +1.0].
- `category`: string label from `_categorize`.
- `eval_text`: human-readable summary.

### Damage Rolls
- **16 discrete damage rolls** from 0.85 to 1.00:
  `[0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1.00]`
- TTK per roll: `ceil(defender_hp / damage)`.

### Turn Model
- Each turn both Pokémon act.
- **Faster Pokémon** (higher speed stat) or **higher priority move goes first**.
- Dead Pokémon cannot act.
- Attribute modifiers (from items/abilities) affect speed, damage, defense.

### Weighted TTK Calculation
- Move weights assigned by inverse average TTK: `weight = inv_ttk / best_inv_ttk`.
- Immune moves get weight 0.
- Weighted effective TTK = `sum(avg_ttk * weight) / total_weight`.

### Score Computation (`_compute_score`)
- **TTK differential** (primary signal): `their_ttk - our_ttk`, normalized with `tanh(diff / 2.5)`.
- **Speed advantage** bonus (±0.12) when TTK diff < 1.5.
- **Move pool depth** bonus (±0.05) for having >1 more viable moves.
- **Priority move** bonus (±0.08).
- Final score clamped to [-1.0, +1.0].

### Category Thresholds (`_categorize`)
| Range          | Label         |
|----------------|---------------|
| `score >= 0.6` | `counter`     |
| `score >= 0.2` | `check`       |
| `score >= -0.2`| `neutral`     |
| `score >= -0.6`| `checked_by`  |
| else           | `countered_by`|

### Damage Formula (Standard Gen 9)
- `Base = floor(((2 * level / 5 + 2) * power * A / D) / 50 + 2)`
- `Final = floor(Base * STAB * TypeEff * ItemMult * Roll)`

### Attribute Modifier Integration
- Items and abilities from the profile are looked up through `attribute_manager`.
- Modifier types: `damage_mod`, `speed_mod`, `stat_mod`.
- Applied to: `damage_mult`, `physical_mult`, `special_mult`, `speed_mult`, `defense_mult`, `spdef_mult`.
