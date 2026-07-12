# AttributeRegistry

## Class Overview
```python
class AttributeRegistry:
    """Manages active attributes for a Pokémon, field, or battle."""
```

### Internal Storage
```python
_attributes: list[Attribute]
```

### Key Methods

#### add(attribute: Attribute) → None
1. For each existing attribute: check `can_stack_with()`
2. If conflict: call `resolve_conflict()` → keep winner
3. Append new attribute

#### remove(name=None, source=None, attribute_type=None, tag=None) → int
Removes matching attributes. Returns count removed.

#### get(name=None, type=None, tag=None) → list[Attribute]
Query attributes by name, type, or tag.

#### tick_all() → list[Attribute]
Advance all tickable attributes. Returns expired ones.

### Conflict Resolution Rules

| Conflict Type | Resolution |
|--------------|------------|
| Same source, same type | Higher priority wins; equal priority → newer wins |
| Stat mods, same source | Newer overwrites |
| Field, same type | Newer overwrites |
| Different types | Both coexist |

## EffectEngine (Planned)
- Applies attributes to game state
- Resolves effect chains
- Handles event-triggered effects

## EventHandler (Planned)
- Event bus for on_switch_in, on_damage, on_faint, etc.
- Priority-ordered event processing
- Interruptible event chains

## AttributeManager (Partial Implementation in battle_simulator.py)

### _get_attribute_modifiers(profile) → dict
Collects modifiers from profile's items and abilities:

```python
mods = {
    'damage_mult': 1.0,     # generic damage boost
    'physical_mult': 1.0,   # physical attack boost
    'special_mult': 1.0,    # special attack boost
    'speed_mult': 1.0,      # speed modifier
    'defense_mult': 1.0,    # defense boost
    'spdef_mult': 1.0,      # special defense boost
}
```

### _apply_attribute(attr, mods) → None
Applies attribute definitions to modifier dict:
- `damage_mod`: applies to damage_mult, physical_mult, or special_mult
- `speed_mod`: applies to speed_mult
- `stat_mod`: converts stages to multipliers

## Known Limitations
1. Modifiers are hardcoded classes (ChoiceBandModifier, LifeOrbModifier)
2. No dynamic state tracking (boosts, status conditions, weather)
3. No conditional logic (e.g., "if burned, physical damage ×0.5")
4. No GameState class for turn-by-turn tracking
5. No weather/terrain/screen tracking