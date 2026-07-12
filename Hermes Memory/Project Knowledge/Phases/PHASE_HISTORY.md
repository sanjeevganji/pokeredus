# PokeRedus Phase History & Roadmap

## Current Status
**Phase**: 8 complete (3D Matchup Graph + AI Query Layer)
**Next Phase**: 9 - Battle Simulation & Decision Engine

## Completed Phases

### Phase 0: Project Setup
- Python project structure with pyproject.toml
- Virtual environment (.venv)
- Git repository
- Basic directory layout

### Phase 1: Core Data Model
- PokemonClass, MoveClass, AbilityClass, ItemClass
- NatureClass, EVSpreadClass, TypeClass
- TYPE_CHART (18×18 matrix)

### Phase 2: Knowledge Graph
- KnowledgeGraph (NetworkX DiGraph)
- Node/edge type system
- Secondary indexes for O(1) lookups
- JSON serialization/deserialization

### Phase 3: Import Phase
- Showdown JSON importer (gen9ou)
- Smogon data importer
- Move data fetching (fetch_moves.py)
- Base stats fetching (fetch_base_stats.py)

### Phase 4: Initial GUI
- Tkinter main window with navigation
- Pokémon browser with sprite display
- Team builder (6-slot grid)
- Set editor CRUD
- Basic theme system

### Phase 5: Damage Calculator
- Gen 9 damage formula implementation
- Pluggable modifier system (DamageModifier base class)
- Built-in modifiers (ChoiceBand, ChoiceSpecs, Life Orb, Eviolite, AssaultVest)
- TTK (Turns to Kill) computation
- MatchupRelation with full damage ranges

### Phase 6: Matchup Cache
- MatchupCache with SHA256 fingerprinting
- CachedMatchup dataclass
- O(1) lookup for precomputed matchups
- JSON persistence with automatic invalidation

### Phase 7: Attribute System (Initial)
- Attribute base class with lifecycle
- Specialized subclasses (StatModifier, DamageModifier, SpeedModifier, etc.)
- AttributeRegistry with conflict resolution
- EventAttribute for trigger-based effects

### Phase 8: 3D Matchup Graph + AI Queries
- Three-axis projection (Type, O/D, SCU)
- MatchupGraphNode / MatchupGraph data structures
- AI query functions (pick_best_move, find_optimal_switch, analyze_game_state)
- Polygonal-solid visual layer (8×18 matrix)
- MatchupGraphView GUI (2D radial polygon + 3D cylinder)

## Upcoming Phases

### Phase 9: Battle Simulation & Decision Engine
- Dynamic State System (HP, status, boosts, weather, terrain)
- Attribute/Effect System integration (generalized conditions)
- Turn-by-turn simulation with state transitions
- Event system (on_switch_in, on_damage, on_faint)

### Phase 10: Learning & Adaptation
- Battle logging (record outcomes and decisions)
- Embedding vectors for semantic similarity
- Policy/value networks for action selection
- Class refinement based on performance

### Phase 11: MCTS Integration
- Full GameState for MCTS
- Action space (4 moves + switches)
- Rollout policy (heuristic + learned)
- Value estimation (position evaluation)

### Phase 12: Battle Automation
- poke-env integration (Pokémon Showdown server)
- Agent class wrapping MCTS + knowledge graph
- Browser automation (optional DOM-based play)
- Self-play training

## Performance Milestones

| Metric | Phase 5 | Phase 6 | Current |
|--------|---------|---------|---------|
| Knowledge Graph | 118 Pokémon, ~270 sets | Same | ~89 MB serialized |
| Matchup Graph | - | ~72,630 edges | Same |
| Matchup Cache | - | ~13,924 entries | ~2 MB |
| Graph Build Time | ~90s | ~90s | ~90s |
| GUI Load Time | <2s | <2s | <2s |