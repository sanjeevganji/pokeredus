# Attribute System Overview

## Purpose
A generalized, class-based attribute/effect system that can represent dynamic game conditions (status, boosts, weather, terrain, abilities, items) and enable intelligent matchup prediction with complex state interactions.

**Key Principle**: Data-driven and self-evolving — no hardcoded Pokémon-specific logic. All effects are defined as reusable Attribute classes that can be composed, learned, and refined through feedback.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Battle State Layer                        │
│  GameState | TeamState | PokemonState | FieldState          │
│  (tracks: HP, status, boosts, weather, terrain, hazards)    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                   Attribute System                           │
│  Attribute (base class)                                      │
│  ├─ StatModifierAttribute (boosts, burns, choice items)     │
│  ├─ DamageModifierAttribute (life orb, expertise, crits)    │
│  ├─ SpeedModifierAttribute (paralysis, scarf, tailwind)     │
│  ├─ ConditionAttribute (status, volatile, trapping)         │
│  ├─ FieldAttribute (weather, terrain, hazards)              │
│  └─ EventAttribute (on_switch, on_damage, on_faint)         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                    Effect Engine                             │
│  AttributeRegistry | EffectResolver | EventHandler          │
│  (applies attributes to state, resolves conflicts)          │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                 Enhanced Damage Calculator                   │
│  Considers: boosts, status, weather, terrain, abilities     │
│  Uses: AttributeResolver for dynamic modifiers              │
└─────────────────────────────────────────────────────────────┘
```

## Attribute Base Class

### Core Fields
| Field | Type | Description |
|-------|------|-------------|
| attribute_type | str | "stat_mod", "damage_mod", "speed_mod", "condition", "field", "event" |
| name | str | Unique identifier (e.g., "burn", "swords_dance", "sun") |
| source | str | What caused this (move_id, ability_id, item_id, "weather") |
| duration | int\|None | None = permanent |
| turns_remaining | int\|None | Decrements on tick |
| applied_turn | int | When the condition was applied |
| priority | int | Higher = applied later (for conflict resolution) |
| tags | list[str] | Categorization and querying |
| params | dict[str, Any] | Flexible custom parameters |

### Lifecycle
1. **created**: When the condition is applied
2. **active**: While the condition persists
3. **expired**: When duration ends or condition is removed

### Key Methods
- `tick()` → bool: Advance one turn. Returns False if expired.
- `can_stack_with(other)` → bool: Stacking rules
- `resolve_conflict(other)` → Attribute: Conflict resolution
- `to_dict()` / `from_dict()`: Serialization