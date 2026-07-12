# Game Engine

## Sub-sections
- [[Game Engine/Damage Calculation/OVERVIEW|Damage Calculation]]
- [[Game Engine/Matchup Scoring/OVERVIEW|Matchup Scoring]]
- [[Game Engine/Battle Simulation/OVERVIEW|Battle Simulation]]
- [[Game Engine/TYPE_CHART|Type Chart]]

## Summary
The Game Engine layer handles all computation of matchups, damage, and battle simulation. It sits between the Knowledge layer (classes) and the Intelligence layer (queries, AI decisions).

### Components
- **DamageCalculator**: Gen 9 damage formula with pluggable modifier system
- **MatchupEngine**: TTK-based scoring with speed consideration
- **BattleSimulator**: Species-level MCTS scoring with weighted move evaluation
- **TypeChart**: 18×18 type effectiveness matrix
-