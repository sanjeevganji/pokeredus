# Matchup Calculations

## Sub-sections
- [[Matchup Calculations/TTK Engine|TTK Engine]]
- [[Matchup Calculations/MCTS Scoring|MCTS Scoring]]
- [[Matchup Calculations/Cache Strategy/OVERVIEW|Cache Strategy]]

## Summary
The matchup calculation system computes scored relationships between Pokémon sets using TTK (Turns to Kill) and MCTS-style evaluation. Results are cached for O(1) lookup.

### Scoring Methods
- **TTK Engine**: Direct comparison using damage formula
- **MCTS Scoring**: Enhanced with speed, move pool depth, and priority consideration