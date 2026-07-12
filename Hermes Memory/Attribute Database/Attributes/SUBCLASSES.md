# Attribute Subclasses

## StatModifierAttribute

**type**: `stat_mod`

### Params
| Param | Type | Description |
|-------|------|-------------|
| stat | str | "atk", "def", "spa", "spd", "spe", "accuracy", "evasion" |
| stages | int | -6 to +6 |

### Stage → Multiplier Formula
```
if stages >= 0:
    mult = (2 + stages) / 2
else:
    mult = 2 / (2 - stages)
```

| Stages | +1 | +2 | +3 | +4 | +5 | +6 | -1 | -2 | -3 | -4 | -5 | -6 |
|--------|----|----|----|----|----|----|----|----|----|----|----|----|
| Mult | 1.5× | 2.0× | 2.5× | 3.0× | 3.5× | 4.0× | 0.67× | 0.5× | 0.4× | 0.33× | 0.29× | 0.25× |

### Stacking Rules
- Same stat from same source: overwrite (keep newer)
- Same stat from different sources: stack (up to ±6)

## DamageModifierAttribute

**type**: `damage_mod`

### Params
| Param | Type | Description |
|-------|------|-------------|
| multiplier | float | e.g., 1.3 for Life Orb |
| applies_to | str | "all", "physical", "special", "status" |
| move_type | str\|None | e.g., "Fire" for sun boost |
| category | str\|None | e.g., "Physical" for burn |

### applies_to_move(move) Logic
- If applies_to == "all" → always applies
- If applies_to == "physical" → if move.is_physical
- If applies_to == "special" → if move.is_special
- If applies_to == "status" → if move.is_status
- If move_type specified → if move.type matches

## SpeedModifierAttribute

**type**: `speed_mod`

### Params
| Param | Type | Description |
|-------|------|-------------|
| multiplier | float | e.g., 1.5 for scarf, 0.5 for paralysis |

### Stacking Rules
- Same source doesn't stack (e.g., two choice scarves)
- Different sources stack multiplicatively

## ConditionAttribute

**type**: `condition`

### Params
| Param | Type | Description |
|-------|------|-------------|
| condition | str | "burn", "paralysis", "poison", "toxic", "sleep", "freeze", "confusion", "flinch", "trapped" |
| damage_per_turn | float\|None | e.g., 1/16 for burn |
| physical_damage_mult | float\|None | e.g., 0.5 for burn |
| speed_mult | float\|None | e.g., 0.5 for paralysis |
| move_chance | float\|None | e.g., 0.25 for full paralysis, 0.33 for confusion |

### Non-volatile Status (mutually exclusive)
burn, paralysis, poison, toxic, sleep, freeze

### Stacking Rules
- Same condition doesn't stack
- Non-volatile status are mutually exclusive (can't have burn + paralysis)
- Different volatile conditions can coexist

## FieldAttribute

**type**: `field`

### Params
| Param | Type | Description |
|-------|------|-------------|
| field | str | "sun", "rain", "sand", "hail", "snow", "electric_terrain", "grassy_terrain", "misty_terrain", "psychic_terrain", "stealth_rock", "spikes", "toxic_spikes", "sticky_web", "reflect", "light_screen", "aurora_veil", "tailwind" |
| duration | int | typically 5 for weather/terrain, 8 for screens |
| type_boosts | dict\|None | e.g., {"Fire": 1.5, "Water": 0.5} for sun |
| damage_per_turn | float\|None | e.g., 1/16 for sand/hail |

### Stacking Rules
- Same field overwrites (newer wins)
- Different fields can coexist (e.g., sun + Stealth Rock)

## EventAttribute

**type**: `event`

### Params
| Param | Type | Description |
|-------|------|-------------|
| event | str | "on_switch_in", "on_turn_start", "on_turn_end", "on_damage", "on_faint", "on_move", "on_hit" |
| effect_type | str | "damage", "heal", "apply_attribute", "remove_attribute", "stat_change" |
| effect_params | dict | Parameters for the effect |
| chance | float\|None | e.g., 0.3 for 30% activation |

### Trigger Logic
- Default: always trigger (unless chance check fails)
- Override `should_trigger(context)` for complex conditions