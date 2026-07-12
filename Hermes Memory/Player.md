# Player

## Sub-sections
- [[Play Intelligence/AI Decisions/QUERIES|AI Queries]]
- [[Game Engine/Battle Simulation/OVERVIEW|Battle Simulation]]

## Summary
The Player component represents the AI decision-making layer. It uses the 3D Matchup Graph to make intelligent decisions about move selection, switching, and team composition.

### Decision Flow
1. Analyze game state (active + opponent + bench)
2. Decide: stay or switch (threshold 0.3)
3. If staying: pick best move via pick_best_move
4. If switching: find best switch via find_optimal_switch
5. Return TurnPlan with reasoning chain