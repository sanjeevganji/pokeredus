# Damage Calculation Formulas

## Core Gen 9 Damage Formula

```
Base = floor(((2 * Level / 5 + 2) * Power * A / D) / 50 + 2)
Final = floor(Base * STAB * TypeEff * ModifierProduct)
```

## Detailed Steps

### 1. Offensive Stat (A)
- Physical moves: Attack stat (after nature, EVs, IVs, level)
- Special moves: Special Attack stat (after nature, EVs, IVs, level)
- Formula: `floor(((2 * base + IV + EV/4) * level / 100) + 5) * nature_modifier`
- HP formula: `floor(((2 * base + IV + EV/4) * level / 100) + level + 10)`

### 2. Defensive Stat (D)
- Physical moves: Defense stat
- Special moves: Special Defense stat
- Same formula as offensive (without nature modifier for defender)

### 3. Base Power
- Move's base power (max 1 for status moves)

### 4. STAB (Same Type Attack Bonus)
- 1.5 if move type matches one of attacker's types
- 2.0 if attacker has Adaptability ability

### 5. Type Effectiveness
- 0, 0.25, 0.5, 1, 2, 4 based on 18×18 type chart
- Dual types multiply together

### 6. Random Factor
- 16 discrete rolls: 0.85, 0.86, ..., 0.99, 1.00
- Damage = floor(Base * STAB * TypeEff * ModifierProduct * roll)

### 7. Modifier Stack (priority order)
Modifiers are applied in priority order (lower = first):
1. Offensive stat modifiers (Choice Band, Choice Specs, etc.)
2. Defensive stat modifiers (Eviolite, Assault Vest, etc.)
3. Base damage modifiers (after base calc)
4. Type effectiveness modifiers (Tinted Lens, etc.)
5. STAB modifiers
6. Final damage multipliers (Life Orb, etc.)

### 8. Critical Hits
- Not currently implemented in base calculator
- Would be 1.5× damage in Gen 9

## Stat Calculation Formula

### Non-HP Stats
```
stat = floor((((2 * base + IV + floor(EV/4)) * level / 100) + 5) * nature_mod)
```

### HP Stat
```
hp = floor(((2 * base + IV + floor(EV/4)) * level / 100) + level + 10)
```

### Nature Modifiers
- Increased stat: 1.1
- Decreased stat: 0.9
- Neutral: 1.0

### EV Limits
- Per stat: ≤ 252
- Total: ≤ 508

### IV Defaults
- All 31 (perfect IVs)

## Modifier System Details

### DamageModifier Base Class
```python
class DamageModifier:
    name: str = "unnamed"
    priority: int = 100
    
    def modify_offense(self, stat_value: float, context) -> float
    def modify_defense(self, stat_value: float, context) -> float
    def modify_damage(self, base_damage: float, context) -> float
    def modify_type_effectiveness(self, effectiveness: float, context) -> float
    def modify_stab(self, stab: float, context) -> float
    def should_skip(self, context) -> bool
```

### Built-in Modifiers

| Modifier | Priority | Effect |
|----------|----------|--------|
| ChoiceBandModifier | 50 | Physical moves: Atk ×1.5 |
| ChoiceSpecsModifier | 50 | Special moves: SpA ×1.5 |
| LifeOrbModifier | 80 | All damage ×1.3 |
| EvioliteModifier | 50 | Def/SpD ×1.5 for NFE |
| AssaultVestModifier | 50 | SpD ×1.5 vs special moves |

### Context Object
Passed to all modifier hooks:
- attacker_set, defender_set
- attacker_pokemon, defender_pokemon
- move
- knowledge graph (kg)
- level