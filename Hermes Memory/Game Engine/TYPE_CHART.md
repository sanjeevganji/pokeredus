## Type Chart — 18×18 Effectiveness Matrix

### Source
`pokeredus/classes/types.py` — `TYPE_CHART`, `get_effectiveness()`, `get_best_effectiveness()`.

### The 18 Pokémon Types
- Normal, Fire, Water, Electric, Grass, Ice
- Fighting, Poison, Ground, Flying, Psychic, Bug
- Rock, Ghost, Dragon, Dark, Steel, Fairy

### TYPE_CHART Structure
- Built from `_OFFENSE` dict, then expanded to a full 18×18 matrix via `_build_chart()`.
- Default multiplier is **1.0** (neutral) for unspecified matchups.
- Values: **0** (immune), **0.5** (not very effective), **1** (neutral), **2** (super effective).

### Offensive Effectiveness Table

| Attacking ↓  | Super Effective (×2) vs             | Resisted (×0.5) vs                                  | Immune (×0) vs |
| ------------ | ----------------------------------- | --------------------------------------------------- | -------------- |
| **Normal**   | —                                   | Rock, Steel                                         | Ghost          |
| **Fire**     | Grass, Ice, Bug, Steel              | Fire, Water, Rock, Dragon                           | —              |
| **Water**    | Fire, Ground, Rock                  | Water, Grass, Dragon                                | —              |
| **Electric** | Water, Flying                       | Electric, Grass, Dragon                             | Ground         |
| **Grass**    | Water, Ground, Rock                 | Fire, Grass, Poison, Flying, Bug, Dragon, Steel     | —              |
| **Ice**      | Grass, Ground, Flying, Dragon       | Fire, Water, Ice, Steel                             | —              |
| **Fighting** | Normal, Ice, Rock, Dark, Steel      | Poison, Flying, Psychic, Bug, Fairy                 | Ghost          |
| **Poison**   | Grass, Fairy                        | Poison, Ground, Rock, Ghost                         | Steel          |
| **Ground**   | Fire, Electric, Poison, Rock, Steel | Grass, Bug                                          | Flying         |
| **Flying**   | Grass, Fighting, Bug                | Electric, Rock, Steel                               | —              |
| **Psychic**  | Fighting, Poison                    | Psychic, Steel                                      | Dark           |
| **Bug**      | Grass, Psychic, Dark                | Fire, Fighting, Poison, Flying, Ghost, Steel, Fairy | —              |
| **Rock**     | Fire, Ice, Flying, Bug              | Fighting, Ground, Steel                             | —              |
| **Ghost**    | Psychic, Ghost                      | Dark                                                | Normal         |
| **Dragon**   | Dragon                              | Steel                                               | Fairy          |
| **Dark**     | Psychic, Ghost                      | Fighting, Dark, Fairy                               | —              |
| **Steel**    | Ice, Rock, Fairy                    | Fire, Water, Electric, Steel                        | —              |
| **Fairy**    | Fighting, Dragon, Dark              | Fire, Poison, Steel                                 | —              |

### Key Functions

**`get_effectiveness(attacking_type: str, defending_types: list[str]) -> float`**
- Returns the combined damage multiplier for one attacking type vs one or two defending types.
- For dual-type defenders, multiplies effectiveness against both types (e.g. 2 × 2 = 4, 2 × 0.5 = 1).

**`get_best_effectiveness(attacker_types: list[str], defender_types: list[str]) -> tuple[str, float]`**
- For dual-type attackers, finds which of the attacker's types hits the defender hardest.
- Returns `(best_attacking_type, best_multiplier)`.

### Usage in Battle Simulator
- The `BattleSimulator._evaluate_move` calls `get_effectiveness(move.type, defender_pokemon.types)`.
- If effectiveness == 0, the move is marked as immune (skip damage).
- STAB (Same-Type Attack Bonus): ×1.5 if move type matches any of attacker's types.
