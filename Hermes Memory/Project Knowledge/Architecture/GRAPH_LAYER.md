# PokeRedus Architecture - Graph Layer

## KnowledgeGraph (NetworkX DiGraph)

- **Node Types**: pokemon, set, move, ability, item, nature, type
- **Edge Types**: has_type, has_move, has_ability, holds_item, has_nature, has_ev_spread, matchup
- **Secondary Indexes**: _pokemon_index, _set_index, _move_index, etc.
- **Primary Set Management**: get_primary_set(), set_primary_set(), build_composite_set()
- **Serialization**: to_json() / from_json() for persistence

## DamageCalculator

- **Purpose**: Compute damage using Gen 9 formula with pluggable modifiers
- **Formula**: Base = floor(((2*Level/5 + 2) * Power * A / D) / 50 + 2)
- **Modifier System**: DamageModifier base class with priority-ordered hooks

### Modifier Hooks
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

## MatchupEngine

- **Purpose**: Compute matchup scores using TTK-based scoring
- **Pipeline**:
  1. Compute TTK for A→B and B→A via DamageCalculator
  2. Factor in speed advantage (who attacks first)
  3. Map TTK differential to [-1.0, +1.0] score using tanh
  4. Generate tags (OHKO, 2HKO, outsped, immune, etc.)

### Scoring Function: _compute_ttk_score(ttk_ab, ttk_ba, speed_adv)
- Special cases: mutual wall (0.0), one-sided win (±1.0)
- Base score: tanh(ttk_diff / 2.5)
- Speed adjustment: ±0.10 (±0.15 on TTK tie)

## MatchupCache

- **Purpose**: Precomputed pairwise matchup results for O(1) lookup
- **Key**: (attacker_id, defender_id) tuple
- **Fingerprinting**: SHA256 hash of Pokémon IDs, primary_set_ids, and move lists
- **Build**: Iterates all Pokémon pairs, computes best_move via DamageCalculator
- **Persistence**: JSON serialization with automatic invalidation on graph changes