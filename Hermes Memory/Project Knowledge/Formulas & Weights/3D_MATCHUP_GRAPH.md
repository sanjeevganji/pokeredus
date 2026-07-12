# 3D Matchup Graph Formulas & Weights

## Axis 1: Type Affinity Vector (18-cell)

### For a single set:
```
Start with zero vector over 18 types:
  Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison,
  Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy

For each type in pokemon.types:
    vec[type] += 0.5  (base type affinity)

For each STAB damaging move:
    vec[move.type] += 0.3  (STAB coverage bonus)

For each nuke (base_power >= 100):
    vec[move.type] += 0.2  (nuke power bonus)

Cap each cell at 1.0
```

### For a team:
```
Element-wise mean of per-member vectors.
vec_team[type] = sum(v[type] for v in member_vecs) / len(member_vecs)
```

## Axis 2: Offense ↔ Defense Spectrum

### Per-set formula (level 100):
```
offense = (atk + spa) / 2
bulk = (hp * 0.5) + ((def + spd) * 0.75)
ratio = (offense / max(bulk, 1)) - 0.5
score = tanh(ratio * 2.0)
```

### For a team:
```
score = sum(s * w for s, w in zip(scores, weights)) / sum(weights)
where weight = max(1, bst)
```

### Example axis positions:
```
+1.0 = pure sweeper (Deoxys-Attack, Deoxys-Speed)
 0.0 = balanced (standard OU wallbreaker)
-1.0 = pure wall (Blissey, Toxapex without offensive investment)
```

## Axis 3: Speed / Control / Utility Simplex

### Speed Score:
```
speed_score = clamp((eff_spe - 100) / 150, 0, 1)
```
- eff_spe at L100: Toxapex ~100 → 0.0, Regieleki ~400+ → 1.0
- 100 Spe threshold: 0.0
- 250 Spe: 1.0

### Control Score:
```
pivot_or_recovery_count = count of moves in PIVOT_OR_RECOVERY set
control_score = min(1.0, pivot_or_recovery_count / 3.0)
```

#### PIVOT_OR_RECOVERY moves:
uturn, voltswitch, partingshot, whirlwind, roar, haze, dragontail, circlethrow, recover, softboiled, slackoff, wish, roost, morningsun, moonlight, synthesis, milkdrink, healorder

### Utility Score:
```
has_hazard_setter  = any move in HAZARD_SETTERS
has_hazard_remover = any move in HAZARD_REMOVERS
has_field_setter   = any move in FIELD_SETTERS

utility = 0.4*has_hazard_setter + 0.3*has_hazard_remover + 0.3*has_field_setter
utility = clamp(utility, 0, 1)
```

#### HAZARD_SETTERS:
stealthrock, spikes, toxicspikes, stickyweb

#### HAZARD_REMOVERS:
defog, rapidspin, mortalspin, tidyup

#### FIELD_SETTERS:
sunnyday, raindance, sandstorm, snowscape, electricterrain, grassyterrain, psychicterrain, mistyterrain, lightscreen, reflect, auroraveil, tailwind, trickroom

### Simplex Projection:
```
def project_to_simplex(s, c, u):
    s, c, u = max(0), max(0), max(0)
    total = s + c + u
    if total <= 0: return (1.0, 0.0, 0.0)
    if total > 1.0: return (s/total, c/total, u/total)
    # total < 1: add remainder to largest component
    remainder = 1.0 - total
    add to max(s, c, u)
    return (s, c, u)
```

## WEIGHT_TABLE (Role-Based Attribute Rebalancing)

### Role weights per attribute type:
sweeper / wall / pivot / cleric / staller / lead / default

Each role rebalances the 8 attributes before the type weighting.

| Attribute | Sweeper | Wall | Pivot | Default |
|-----------|---------|------|-------|---------|
| attack | high | low | med | med |
| utility | low | med | high | med |
| defense | low | high | med | med |
| speed | high | low | high | med |

## Volume Formula:
```
Volume = sum_over_types(counter * sponge + threat * punish) * bias
bias = 0.5 + 0.5 * mcts_composite
```

This makes well-ranked sets visibly fuller in the visual graph.

## AI Query Formulas

### pick_best_move scoring:
Combines:
- Type effectiveness (primary signal)
- STAB bonus
- Base power (normalized)
- Status utility (for status moves)
- Priority (speed override)
- Existing matchup damage data

### find_optimal_switch scoring:
- Type resistance (incoming effectiveness product)
- Speed advantage (who moves first)
- Precomputed matchup score (from TTK)
- 3D distance (axis similarity)

### analyze_game_state:
- Stay vs switch threshold: 0.3
- If best switch_score > current_score + 0.3 → recommend switch
- Otherwise → stay and pick best move
- Returns reasoned TurnPlan with confidence

## Cache Strategy Constants

### MatchupCache
- Fingerprint: SHA256(Pokémon IDs + primary_set_ids + move lists)
- Default path: data/cache/matchup_cache.json
- Key: (attacker_id, defender_id) tuple
- O(1) lookup

### SpeciesMatchupCache
- Batch cache: one entry per Pokémon with all its matchups
- Hash-based invalidation per Pokémon
- Reverse-direction fill: halves computation
- Marked `complete=False` for partial entries