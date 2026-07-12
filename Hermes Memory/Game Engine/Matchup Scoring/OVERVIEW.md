# Game Engine - Matchup Scoring

## MatchupEngine

### Class Location
`pokeredus/graph/matchup_engine.py`

### Pipeline
1. Compute TTK for A → B and B → A via DamageCalculator
2. Factor in speed advantage (who attacks first)
3. Map TTK differential to [-1.0, +1.0] score using tanh
4. Generate tags (OHKO, 2HKO, outsped, immune, etc.)

### Key Functions

#### compute_matchup(set_a, set_b, kg, calc=None) → MatchupRelation
Returns a scored matchup relation between two sets.

#### compute_all_matchups(kg, calc=None) → int
Computes pairwise matchups for all sets in the graph.

### Implementation Details

#### immunities_check
- If A's best move is immune to B: tag "immune_to_a"
- If B's best move is immune to A: tag "immune_to_b"
- Type immunity = effectiveness == 0

#### best_move selection
- For each damaging move in attacker's moveset
- Calculate damage result
- Skip immune moves
- Pick move with lowest TTK (highest damage on tie)

## MatchupScorer (MCTS variant)

### Class Location
`pokeredus/graph/matchup_scorer.py`

### Constructor
```python
scorer = MatchupScorer(calc, kg, attribute_manager=None)
```

### Key Methods

#### score_matchup(our_set, their_set) → MatchupScore
Builds species profiles from sets, simulates matchup.

#### score_matchup_by_id(our_pokemon_id, their_pokemon_id) → MatchupScore
Directly by Pokémon IDs.

#### score_team_matchup(our_team_ids, their_team_ids) → float
Average score across all pairwise matchups (1v1, 3v3, or 6v6).

### MatchupScore
```python
@dataclass
class MatchupScore:
    score: float       # -1.0 to +1.0
    outcome: SpeciesMatchupResult
    category: str      # 'counter', 'check', 'neutral', 'checked_by', 'countered_by'
    eval_text: str
    
    # Properties
    is_win: score > 0.2
    is_loss: score < -0.2
    is_neutral: -0.2 <= score <= 0.2
```