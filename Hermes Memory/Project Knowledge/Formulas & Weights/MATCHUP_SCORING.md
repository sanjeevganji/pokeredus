# Matchup Scoring Formulas

## TTK-Based Scoring (_compute_ttk_score)

### Core Formula
```python
def _compute_ttk_score(ttk_a_to_b, ttk_b_to_a, speed_advantage):
    # Special cases
    if not a_can_kill and not b_can_kill: return 0.0  # mutual wall
    if a_can_kill and not b_can_kill: return 1.0     # A wins
    if not a_can_kill and b_can_kill: return -1.0    # A loses
    
    # Both can kill: compare TTK
    ttk_diff = ttk_b_to_a - ttk_a_to_b  # positive = A kills faster
    base_score = math.tanh(ttk_diff / 2.5)
    
    # Speed adjustment
    speed_adj = 0.0
    if speed_advantage == "a": speed_adj = 0.10
    elif speed_advantage == "b": speed_adj = -0.10
    
    # TTK tie: speed becomes stronger tiebreaker
    if ttk_diff == 0:
        if speed_advantage == "a": speed_adj = 0.15
        elif speed_advantage == "b": speed_adj = -0.15
    
    return max(-1.0, min(1.0, base_score + speed_adj))
```

### Parameters Explained

| Parameter | Purpose |
|-----------|---------|
| `ttk_a_to_b` | Turns for A to KO B |
| `ttk_b_to_a` | Turns for B to KO A |
| `speed_advantage` | "a", "b", or "tie" |

### tanh Scaling Factor: 2.5
- TTK diff of 1 → ~0.31 score
- TTK diff of 2 → ~0.58 score
- TTK diff of 3 → ~0.76 score
- TTK diff of 5 → ~0.99 score

## MCTS-Style Scoring (BattleSimulator._compute_score)

### Enhanced Formula
```python
def _compute_score(result):
    our_ttk = result.our_effective_ttk
    their_ttk = result.their_effective_ttk
    
    # Hard cases
    if our_ttk <= 0 and their_ttk <= 0: return 0.0
    if our_ttk <= 0 and their_ttk > 0: return -1.0
    if our_ttk > 0 and their_ttk <= 0: return 1.0
    
    # TTK differential: positive = we kill faster
    ttk_diff = their_ttk - our_ttk
    base_score = math.tanh(ttk_diff / 2.5)
    
    # Speed advantage (matters more when TTK close)
    speed_bonus = 0.0
    if abs(ttk_diff) < 1.5:
        if result.speed_advantage == 'us': speed_bonus = 0.12
        elif result.speed_advantage == 'them': speed_bonus = -0.12
    
    # Move pool depth bonus (flexibility)
    our_viable = len([m for m in result.our_moves if not m.is_immune and m.avg_ttk > 0])
    their_viable = len([m for m in result.their_moves if not m.is_immune and m.avg_ttk > 0])
    depth_bonus = 0.0
    if our_viable > their_viable + 1: depth_bonus = 0.05
    elif their_viable > our_viable + 1: depth_bonus = -0.05
    
    # Priority move consideration
    our_has_priority = any(m.priority > 0 for m in result.our_moves if not m.is_immune)
    their_has_priority = any(m.priority > 0 for m in result.their_moves if not m.is_immune)
    priority_bonus = 0.0
    if our_has_priority and not their_has_priority: priority_bonus = 0.08
    elif their_has_priority and not our_has_priority: priority_bonus = -0.08
    
    score = base_score + speed_bonus + depth_bonus + priority_bonus
    return max(-1.0, min(1.0, score))
```

### MCTS Score Components

| Component | Weight | Condition |
|-----------|--------|-----------|
| Base TTK (tanh) | Primary | Always |
| Speed Bonus | 0.12 | \|TTK diff\| < 1.5 |
| Move Depth Bonus | 0.05 | 2+ more viable moves |
| Priority Bonus | 0.08 | Has priority, opponent doesn't |

### Score Categories
| Score Range | Category | Meaning |
|-------------|----------|---------|
| ≥ 0.6 | counter | Hard counter |
| 0.2 to 0.6 | check | Reliable check |
| -0.2 to 0.2 | neutral | Even matchup |
| -0.6 to -0.2 | checked_by | Checked by opponent |
| < -0.6 | countered_by | Hard countered |

## Damage Range & TTK

### Damage Rolls (16 discrete)
```
rolls = [0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92,
         0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1.00]
```

### TTK Per Roll
```
for each roll:
    dmg = floor(full_damage * roll)
    ttk = ceil(defender_hp / dmg) if dmg > 0 else 0
```

### Weighted TTK (Effective TTK)
```python
# Move weights based on inverse TTK
best_inv_ttk = max(1.0 / m.avg_ttk for m in viable_moves)
weight = (1.0 / m.avg_ttk) / best_inv_ttk  # 0.0 to 1.0

# Weighted average
effective_ttk = sum(m.avg_ttk * m.weight for m in viable) / sum(m.weight)
```

### Move Viability Criteria
- Not immune (type effectiveness > 0)
- avg_ttk > 0 (can actually KO)
- Weight > 0

## Confidence Values

| Condition | Confidence |
|-----------|------------|
| Default (TTK calc) | 0.5 |
| Both sides can deal damage | 0.7 |
| Super-effective coverage (2.0+) | +0.1 |
| Max confidence | 1.0 (capped) |

## Tags Generated

| Tag | Condition |
|-----|-----------|
| OHKO | ttk == 1 |
| 2HKO | ttk == 2 |
| 3HKO | ttk == 3 |
| NHKO | ttk >= 4 |
| faster | speed_advantage == "a" |
| slower | speed_advantage == "b" |
| speed_tie | speed_advantage == "tie" |
| immune_to_a | defender immune to A's best move |
| immune_to_b | attacker immune to B's best move |
| super_effective_coverage | best move ≥ 2.0 effectiveness |
| vulnerable_to_super_effective | opponent has ≥ 2.0 effectiveness |