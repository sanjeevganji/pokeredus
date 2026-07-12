# PokeRedus Architecture Overview

## System Overview

PokeRedus is a class-based Pokémon intelligence system for competitive Gen 9 OU analysis. The system represents Pokémon knowledge as an explicit object/class graph where Pokémon species, sets, moves, abilities, items, and matchups are all first-class typed objects with relations.

**Current Phase**: Phase 8 complete (3D Matchup Graph + AI Query Layer)
**Next Phase**: Phase 9 - Battle Simulation & Decision Engine

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