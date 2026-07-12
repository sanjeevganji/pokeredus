# 8-Attribute Radar Chart Formulas

> **Source of truth** for the PokeRedus 8-attribute radial bar chart.
> Changes here propagate to `pokeredus/graph/radar_attributes.py` via
> `scripts/sync_obsidian_configs.py --apply`. Rebuild the GUI to see
> updated values.

## Overview

The radar chart plots 8 attributes on a compass-rose layout:

| Angle | Attribute | Type | Purpose |
|-------|-----------|------|---------|
| 0° | **attack** | base | Base damage output with items/abilities |
| 45° | **threat** | compound | Damage reach via speed tiers (attack × speed) |
| 90° | **speed** | base | Normalized speed score (priority, Trick Room) |
| 135° | **punish** | compound | Punish with speed advantage (utility × speed) |
| 180° | **utility** | base | Setup, hazards, field, healing, pivoting |
| 225° | **sponge** | compound | Tanking enhanced by utility (defense × utility) |
| 270° | **defense** | base | Type-resistance profile × bulk |
| 315° | **counter** | compound | Absolute advantage: dish + take (attack × defense) |

**Key design principle**: Values are computed on-the-fly from set data
(moves, stats, types, item, ability). They are **never** stored per set.
The formula constants below are the only tunables.

---

## Scaling Function

All attributes use logistic polynomial scaling to [0, 100]:

```
scaled = 100 × ((raw/k)^p) / (1 + (raw/k)^p)
```

- `k` = midpoint (raw value that maps to 50)
- `p` = steepness (higher = sharper transition)

---

## Parameter Table

Edit values below to tune the radar. Run `sync_obsidian_configs.py --apply` then rebuild.

### Attack Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| atk_scale | 400.0 | Logistic midpoint for raw attack sum |
| atk_steepness | 1.5 | Logistic steepness for attack |
| stab_multiplier | 1.5 | STAB damage bonus |
| nuke_threshold | 100 | BP ≥ this counts as a "nuke" |
| nuke_bonus | 1.2 | Multiplier for nuke moves |
| choice_atk_mult | 1.5 | Choice Band/Specs damage multiplier |
| lifeorb_mult | 1.3 | Life Orb damage multiplier |
| atk_ability_mult | 1.3 | Generic atk-boosting ability multiplier |

### Speed Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| spe_floor | 50.0 | Stat below this → 0 |
| spe_ceiling | 200.0 | Stat at/above this → 80 (base) |
| priority_bonus | 15.0 | Flat bonus per priority move |
| trickroom_invert | 1 | Invert speed for Trick Room users |

### Utility Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| util_scale | 4.0 | Logistic midpoint for utility point sum |
| util_steepness | 1.2 | Logistic steepness for utility |
| setup_points | 2.0 | Points per setup move |
| hazard_set_points | 1.5 | Points per hazard-setter move |
| hazard_remove_points | 1.0 | Points per hazard-removal move |
| heal_points | 1.5 | Points per healing move |
| field_points | 1.0 | Points per field-condition move |
| pivot_points | 1.0 | Points per pivot move |
| status_points | 1.5 | Points per status-inflict move |
| protect_points | 0.5 | Points per protect/sub move |
| regen_ability_points | 1.5 | Points for Regenerator etc. |
| item_util_points | 0.5 | Generic utility item bonus |

### Defense Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| def_scale | 4.0 | Logistic midpoint for defense point sum |
| def_steepness | 1.3 | Logistic steepness for defense |
| resist_weight | 1.5 | Weight per 0.5× resistance |
| immune_weight | 3.0 | Weight per 0× immunity |
| weakness_penalty | 1.0 | Penalty per 2× weakness |
| quadweak_penalty | 2.0 | Penalty per 4× double-weakness |
| def_ability_mult | 1.3 | Generic def-boosting ability multiplier |
| absorb_ability_pts | 2.0 | Flat points for absorb abilities |
| item_def_points | 0.5 | Generic defensive item bonus |

### Compound Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| compound_method | 1 | 1=geometric_mean, 0=product |
| compound_scale | 80.0 | Logistic midpoint for compound values |
| compound_steepness | 1.5 | Logistic steepness for compounds |

---

## Formula Details

### Attack

```
raw_attack = Σ_{moves} bp × stab × nuke × item_mult × ability_mult
attack = logistic(raw_attack, k=atk_scale, p=atk_steepness)
```

- **STAB**: `stab_multiplier` if move type ∈ Pokémon's types, else 1.0
- **Nuke**: `nuke_bonus` if `bp ≥ nuke_threshold`, else 1.0
- **Item mult**: `choice_atk_mult` for Choice Band/Specs, `lifeorb_mult` for Life Orb
- **Ability mult**: `atk_ability_mult` for Huge Power, Technician, etc.

### Speed

```
base_speed = 80 × clamp((eff_spe - spe_floor) / (spe_ceiling - spe_floor), 0, 1)
priority_bonus = min(Σ priority_moves × priority_bonus_per, 20)
raw_speed = base_speed + priority_bonus
  [if Trick Room user]: raw_speed = (80 - base_speed) + priority_bonus
speed = clamp(raw_speed, 0, 100)
```

### Utility

```
raw_utility = Σ role_points + ability_bonus + item_bonus
utility = logistic(raw_utility, k=util_scale, p=util_steepness)
```

Points are awarded per move for: setup, hazard setting, hazard removal,
healing, field conditions, pivoting, status infliction, and protection.

### Defense

```
type_pts = Σ_{18 types} resist_or_immune_pts - weakness_penalties
bulk_factor = sqrt(hp × avg_def) / 200
raw_defense = type_pts × ability_mult × bulk_factor + absorb_bonus + item_bonus
defense = logistic(raw_defense, k=def_scale, p=def_steepness)
```

### Compound Attributes

All four compounds use the same pattern:

```
compound = method(base_A, base_B)
scaled = logistic(compound, k=compound_scale, p=compound_steepness)
```

| Compound | Base A | Base B | Interpretation |
|----------|--------|--------|---------------|
| threat | attack | speed | How many speed tiers you outspeed and hit hard |
| punish | utility | speed | Punish with speed advantage (util moves faster) |
| sponge | defense | utility | Tanking capacity enhanced by recovery/hazards |
| counter | attack | defense | Absolute advantage: deal damage AND take hits |

**Geometric mean** (default): `sqrt(A × B)` — naturally bounded, rewards balance
**Product** (alternative): `A × B / 100` — rewards specialization

---

## Sync Pipeline

1. Edit values in this document
2. Run: `python scripts/sync_obsidian_configs.py --apply`
3. Rebuild GUI (restart or reload)
4. `reload_radar_config()` in Python to force-refresh without restart

The sync script updates the `RadarConfig` defaults in
`pokeredus/graph/radar_attributes.py` from the table above.
