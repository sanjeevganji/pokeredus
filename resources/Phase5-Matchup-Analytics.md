# Phase 5: Matchup Analytics & Enhanced Stats

## Overview

This intermediate phase bridges the GUI browser (Phase 4) with team building (Phase 6).
It adds **turns-to-kill (TTK) damage calculation**, **speed-aware matchup scoring**,
**per-species matchup aggregation**, and **enhanced stat display** with selectable sets
showing computed stats at level 100.

---

## 1. Damage Calculator (`pokeredus/graph/damage_calc.py`)

### 1.1 Core Formula (Gen 9 Standard)

```
Base Damage = floor(((2 * Level / 5 + 2) * Power * A / D) / 50 + 2)
Final Damage = floor(Base Damage * STAB * TypeEff * Modifier)
```

Where:
- **Level** = 100 (standard competitive level)
- **Power** = move.base_power
- **A** = attacker's Atk or SpA (computed stat with EVs/IVs/nature at Lv100)
- **D** = defender's Def or SpD (computed stat with EVs/IVs/nature at Lv100)
- **STAB** = 1.5 if move.type in attacker's types, else 1.0
- **TypeEff** = from type chart (0, 0.5, 1, 2, 4)
- **Modifier** = product of all registered modifier plugins (items, abilities)

### 1.2 Pluggable Modifier Architecture

```python
class DamageModifier:
    """Base class for item/ability damage modifiers."""
    name: str
    priority: int = 0  # execution order

    def modify_offense(self, attacker, move, base_stat, context) -> float:
        """Modify the attacker's offensive stat (e.g., Choice Band *1.5)."""
        return base_stat

    def modify_defense(self, defender, move, base_stat, context) -> float:
        """Modify the defender's defensive stat."""
        return base_stat

    def modify_damage(self, attacker, defender, move, base_damage, context) -> float:
        """Modify the final damage (e.g., Life Orb *1.3)."""
        return base_damage

    def modify_type_effectiveness(self, attacker, defender, move, effectiveness, context) -> float:
        """Modify type effectiveness (e.g., Tinted Lens doubles NVE)."""
        return effectiveness

    def should_skip(self, attacker, defender, move, context) -> bool:
        """Return True to skip this move entirely (e.g., immunity via ability)."""
        return False
```

Context carries: attacking_set, defending_set, attacking_pokemon, defending_pokemon,
move, kg (knowledge graph).

### 1.3 Turns-to-Kill Calculation

```
HP_def = floor((2 * BaseHP + IV_HP + EV_HP/4) * Level / 100) + Level + 10
TTK = ceil(HP_def / avg_damage_per_hit)
```

For multi-hit moves (e.g., Scale Shot): multiply damage by hit count.
For status moves: TTK = infinity (can't kill).

### 1.4 Best Move Selection

For each attacker vs defender pair, evaluate all 4 moves and pick the one
that yields the minimum TTK (fastest kill). Store as `best_move_id`.

---

## 2. Matchup Engine Update (`pokeredus/graph/matchup_engine.py`)

### 2.1 New Scoring Pipeline

Replace the current weighted-sum heuristic with TTK-based scoring:

```
1. Compute TTK for A→B (best move) and B→A (best move)
2. Compute speed advantage: who attacks first?
3. Compute effective TTK differential:
     If A is faster: A wins if A_TTK <= B_TTK
     If B is faster: B wins if B_TTK <= A_TTK
     Speed tie: coin flip (score = 0)
4. Map TTK differential to [-1.0, +1.0]:
     ttk_diff = B_TTK - A_TTK  (positive = A kills faster)
     score = clamp(tanh(ttk_diff / 3.0), -1, 1)
     Adjust for speed: +0.1 if A is faster, -0.1 if B is faster
5. Tags: OHKO, 2HKO, 3HKO, outsped, speed_tie, immune, etc.
```

### 2.2 MatchupRelation Extended Fields

```python
@dataclass
class MatchupRelation:
    # ... existing fields ...
    turns_to_kill_a: int = 0        # A kills B in N turns
    turns_to_kill_b: int = 0        # B kills A in N turns
    speed_advantage: str = "tie"    # "a", "b", or "tie"
    best_move_a_id: str = ""        # A's best move against B
    best_move_b_id: str = ""        # B's best move against A
    damage_a_to_b: int = 0          # A's best move damage
    damage_b_to_a: int = 0          # B's best move damage
    effective_hp_a: int = 0         # A's HP stat
    effective_hp_b: int = 0         # B's HP stat
```

---

## 3. Analytics Engine (`pokeredus/graph/analytics.py`)

### 3.1 Per-Species Matchup Aggregation

When displaying matchups, collapse multiple sets of the same species into one:

```python
def aggregate_by_species(kg, set_id, direction="offense"):
    """For each opponent species, pick the representative set.

    For worst matchups (defense): pick the opponent set that is
    HARDEST for us to beat (highest A_TTK, lowest B_TTK).

    For best matchups (offense): pick the opponent set that is
    EASIEST for us to beat (lowest A_TTK, highest B_TTK).
    """
```

### 3.2 MCTS-Style Set Ranking

Rank sets by their aggregate matchup performance:

```python
def rank_sets_by_matchup(kg, level=100):
    """Rank all sets by their overall matchup score.

    For each set, compute:
    - Mean TTK against the field (how fast it kills)
    - Mean TTK by the field (how fast it dies)
    - Win rate (fraction of matchups with positive score)
    - Speed advantage rate

    Composite score = weighted sum of:
    - win_rate * 0.4
    - (1 - normalized_mean_TTK_against) * 0.3
    - speed_advantage_rate * 0.3
    """
```

### 3.3 Stat-Based Sorting

```python
def compute_all_set_stats(kg, level=100):
    """For each set, compute all 6 stats at the given level.
    Returns dict[set_id -> dict[stat -> value]].
    Used for sorting/filtering in the GUI.
    """
```

---

## 4. GUI Enhancements

### 4.1 Enhanced PokemonPanel

- **Selectable Sets**: Click a set card to select it. Selected set highlights
  and shows its computed stats at level 100 in the species card area.
- **Dual Stat Display**: Show base stats (species) AND computed stats (set-specific)
  side by side. Computed stats use EVs, IVs, nature at level 100.
- **Stat Sort**: Add sort dropdown to sidebar: "Name", "BST", "HP", "Atk",
  "Def", "SpA", "SpD", "Spe" (computed at level 100 for the first/best set).
- **TTK Column in Matchup Tables**: Add "Turns" column showing TTK for each matchup.

### 4.2 Matchup Display Changes

- Collapsed per-species view: one row per opponent species
- "Repr. Set" indicator showing which set was used for the matchup
- Color-coded TTK: 1-turn (bright red/green), 2-turn (muted), 3+ (dim)

---

## 5. Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `pokeredus/graph/damage_calc.py` | CREATE | Damage calculator + modifier system |
| `pokeredus/graph/analytics.py` | CREATE | Analytics engine |
| `pokeredus/classes/matchup.py` | MODIFY | Add TTK fields |
| `pokeredus/graph/matchup_engine.py` | MODIFY | Use damage calc for TTK scoring |
| `pokeredus/graph/queries.py` | MODIFY | Add analytics queries |
| `pokeredus/gui/pokemon_panel.py` | MODIFY | Enhanced stats, selectable sets, TTK |
| `pokeredus/gui/theme.py` | MODIFY | TTK colors |

---

## 6. Implementation Order

1. `damage_calc.py` — standalone, no dependencies on other new code
2. `matchup.py` — add new fields (backward compatible)
3. `matchup_engine.py` — refactor to use damage_calc
4. `analytics.py` — depends on damage_calc and matchup engine
5. `queries.py` — add new query functions
6. `theme.py` — add new colors
7. `pokemon_panel.py` — wire everything into GUI
