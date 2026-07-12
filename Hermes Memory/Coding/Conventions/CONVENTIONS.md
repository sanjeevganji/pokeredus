# Coding Patterns & Conventions

## Naming Conventions

### Package Structure
- `pokeredus/` = main package
- Classes under `pokeredus/classes/`
- Graph/engine under `pokeredus/graph/`
- GUI under `pokeredus/gui/`
- Importers under `pokeredus/importers/`
- Utilities under `pokeredus/utils/`

### Class Naming
- Domain classes: `PokemonClass`, `SetClass`, `MoveClass`, `AbilityClass`, `ItemClass`, `NatureClass`, `EVSpreadClass`, `TypeClass`
- Graph classes: `KnowledgeGraph`, `DamageCalculator`, `MatchupEngine`, `MatchupCache`
- GUI classes: `PokemonPage`, `TeamBuilder`, `SetEditor`, `MatchupGraphView`
- Dataclasses: `MatchupRelation`, `DamageResult`, `CachedMatchup`, `MatchupGraphNode`
- AI dataclasses: `MoveRanking`, `SwitchRanking`, `TurnPlan`

### Function Naming
- snake_case throughout
- Graph functions: verb_noun (e.g., `compute_matchup`, `build_composite_set`)
- GUI methods: _method for private (e.g., `_render_matchups`, `_on_select`)
- Properties: verb_ing where possible
- AI queries: denote_scenario (e.g., `pick_best_move`, `find_optimal_switch`)

## Architectural Patterns

### Layer Architecture
1. **Knowledge Layer** (classes/) — pure dataclasses, no logic beyond helpers
2. **Graph Layer** (graph/) — algorithms, computation, state management
3. **GUI Layer** (gui/) — presentation only, calls into graph layer
4. **Import Layer** (importers/) — data ingestion, always creates fresh KnowledgeGraph

### Dependency Direction
GUI → Graph → Knowledge (never the reverse)

### Set-Level Intelligence
All matchups, scoring, and queries operate at Set level, not Species level.
SetClass is the "unit of intelligence."

### Modifier Pattern
```python
class DamageModifier:
    name: str
    priority: int
    # Override one or more hooks
```

### Cache Pattern
```python
class SomeCache:
    def get(self, key): ...
    def put(self, key, value): ...
    def is_valid(self, kg): ...
    def build(self, kg): ...
    def save(self, path): ...
    def load(self, path): ...
    @classmethod
    def load_or_build(cls, kg, path, force): ...
```

## Test Patterns
- Tests in `tests/` directory
- Use pytest conventions
- Phase-specific test files: `test_phase5.py`
- Test files: `test_classes.py`, `test_graph.py`, `test_matchup.py`, `test_import.py`

## Debugging Patterns
### Tkinter Gotchas
- Canvas.create_window must use tags="inner" and bind <Configure>
- tkinter doesn't support #RRGGBBAA hex — alpha channel causes TclError
- ttk.Treeview item(iid, "open") returns 0/1 not True/False
- tk.Scale.set() does NOT fire command= callback
- pytest >=9: pytest.approx(ndarray) returns bool — use np.testing.assert_allclose

### Testing Patterns
- Split widget into pure-data layer + thin Tk wrapper for headless testability