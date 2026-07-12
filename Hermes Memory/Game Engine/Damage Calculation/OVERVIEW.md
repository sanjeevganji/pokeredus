# Game Engine - Damage Calculation

## DamageCalculator

### Class Location
`pokeredus/graph/damage_calc.py`

### Constructor
```python
calc = DamageCalculator()
calc.register_modifier(ChoiceBandModifier())
calc.register_modifier(LifeOrbModifier())
```

### Level
Default: 100 (competitive level)

### Core Methods

#### calculate(attacker_set, defender_set, move, kg, level=None) → DamageResult
Full damage calculation for one move.

#### best_move(attacker_set, defender_set, kg, level=None) → DamageResult | None
Finds the best damaging move (lowest TTK, tiebreak on higher damage).

#### turns_to_kill(attacker_set, defender_set, kg, level=None) → tuple[int, DamageResult | None]
Returns (TTK, best_damage_result). Returns (0, None) if can't deal damage.

#### full_matchup(set_a, set_b, kg, level=None) → dict
Returns comprehensive matchup dict with:
- ttk_a_to_b, ttk_b_to_a
- speed_a, speed_b, speed_advantage
- best_move_a, best_move_b (DamageResult objects)
- hp_a, hp_b
- min/max damage and TTK for both sides

## DamageResult

### Fields
| Field | Type | Description |
|-------|------|-------------|
| move_id | str | |
| move_name | str | |
| move_type | str | |
| move_category | str | Physical/Special/Status |
| base_power | int | |
| offensive_stat | int | A |
| defensive_stat | int | D |
| base_damage | int | Before multipliers |
| stab_mult | float | 1.0 or 1.5 |
| type_effectiveness | float | From type chart |
| modifier_product | float | Product of all modifiers |
| final_damage | int | After all multipliers |
| effective_hp | int | Defender's HP |
| turns_to_kill | int | ceil(HP / final_damage) |
| is_ohko | bool | True if TTK == 1 |
| is_immune | bool | True if 0× effectiveness |
| is_contact | bool | |
| hit_count | int | Multi-hit moves |
| min_damage | int | ×0.85 roll |
| max_damage | int | ×1.00 roll |
| min_turns_to_kill | int | ceil(HP / max_damage) |
| max_turns_to_kill | int | ceil(HP / min_damage) |

### Computed Properties
- `damage_percent`: final_damage / effective_hp * 100
- `damage_range_str`: "45.2 – 53.1%" format
- `ttk_range_str`: "2-3HKO" format

## Known Limitations

### Current
- No stat stage modifiers (+1 Atk, -2 Def, etc.)
- No status condition effects (burn halves physical damage)
- No weather/terrain modifiers
- No multi-hit move averaging
- No critical hit consideration

### Future (Planned)
- Full GameState class for dynamic context
- AttributeResolver integration
- Weather/terrain/screen modifiers
- Burn/paralysis/poison effects
- Critical hit factor (1.5× in Gen 9)
- Multi-hit move averaging