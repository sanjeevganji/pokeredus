# Game State Simulator — 4th Page Implementation Plan

> **For Hermes:** Divide into independent parallel subagent tasks below.
> Each subagent gets full context — target files, patterns to follow, interfaces.

**Goal:** Build a probabilistic battle simulator page that abstracts the game into numeric form, integrating existing TTK/matchup + GameState frameworks. It should display win% scores and an MCTS-style optimal play tree incorporating both moves and switches. Real-time modifier editing from items/abilities should feed back into scores.

**Architecture:** Three layers:
1. `probabilistic_engine.py` — Numeric battle simulation combining TTK/matchup data with Monte Carlo rollouts over GameState clones. Produces win% scores and action-value estimates.
2. `mcts_graph.py` — Lightweight MCTS tree builder (UCB1 selection + rollout + backprop) for optimal play graphs. Nodes are game states, edges are actions (moves + switches).
3. `simulator_page.py` — Tkinter GUI 4th page. Imports sets from existing teams, shows both sides with editable active conditions/modifiers, displays win% and MCTS graph visualization.

**Tech Stack:** Python 3.11, tkinter, networkx (already in venv), existing PokeRedus classes.

**Key Design Decisions:**
- MCTS depth: configurable, default 3 plies (each ply = both sides act)
- Rollouts per node: configurable, default 10 (probabilistic damage sampling)
- The engine reuses `SpeciesProfile`, `MoveEvaluation`, `SpeciesMatchupResult` from `battle_simulator.py`
- The engine extends `GameState`/`PokemonState`/`FieldState` from `game_state.py`
- GUI follows existing patterns: `PokemonSetSelectorDialog` from team_builder, dark theme, type-colored badges
- Modifiers feed through the existing `AttributeRegistry`/`attribute_manager` pipeline

---

## Subtask 1: Probabilistic Battle Engine (`pokeredus/graph/probabilistic_engine.py`)

**Objective:** Build the core simulation engine that runs Monte Carlo rollouts over game states.

**Files:**
- Create: `pokeredus/pokeredus/graph/probabilistic_engine.py`

**Design:**

```python
# ── Core Data Structures ──

@dataclass
class SimAction:
    """A possible action in a game state."""
    action_type: str  # 'move' | 'switch'
    target_id: str     # move_id or pokemon_id
    source_pokemon: str  # pokemon_id of the actor

@dataclass
class RolloutResult:
    """Result of a single rollout."""
    winner: str          # 'a' | 'b' | 'draw'
    turns: int
    final_hp_a: dict[str, int]  # pokemon_id -> remaining HP
    final_hp_b: dict[str, int]
    action_path: list[SimAction]  # what actions were taken

@dataclass
class ActionStats:
    """Aggregated statistics for a single action from a state."""
    action: SimAction
    wins: int
    losses: int
    draws: int
    total_rollouts: int
    avg_turns: float
    
    @property
    def win_rate(self) -> float:
        return self.wins / max(self.total_rollouts, 1)

@dataclass
class StateEvaluation:
    """Evaluation of a game state after Monte Carlo sampling."""
    win_probability: float    # 0.0–1.0
    actions: list[ActionStats]  # sorted by win_rate desc
    best_action: SimAction | None
    rollout_count: int

# ── Engine ──

class ProbabilisticEngine:
    """
    Monte Carlo battle simulator.
    
    For a given GameState, runs N rollouts with probabilistic damage
    sampling (using the 16-roll damage range from existing calc).
    Each rollout plays out the battle with randomized damage rolls
    and greedy action selection (or random for exploration).
    """
    
    def __init__(self, kg, battle_simulator: BattleSimulator, 
                 num_rollouts: int = 30, max_depth: int = 50):
        ...
    
    def evaluate_state(self, state: GameState, 
                       perspective: str = 'a') -> StateEvaluation:
        """Run rollouts and return aggregated stats."""
        ...
    
    def rollout(self, state: GameState, perspective: str = 'a') -> RolloutResult:
        """Single full battle simulation with probabilistic damage."""
        ...
    
    def get_available_actions(self, state: GameState, side: str) -> list[SimAction]:
        """Enumerate moves + switches for a side."""
        ...
    
    def execute_action(self, state: GameState, action: SimAction) -> GameState:
        """Execute an action on a cloned state, return new state."""
        ...
    
    def compute_damage_against(self, attacker_set_id, defender_set_id, 
                               move_id, state: GameState) -> tuple[int, int]:
        """Compute min/max damage considering current state modifiers."""
        ...
```

**Integration points:**
- Uses `BattleSimulator` for SpeciesProfile + MoveEvaluation lookups
- Uses `GameState.clone()` for state copies
- Uses `DamageCalculator` for damage computation with attribute modifiers
- Action enumeration reads `PokemonState.moves` from the active set + available bench slots
- Damage sampling picks a random value from the 16-roll distribution

---

## Subtask 2: MCTS Graph Builder (`pokeredus/graph/mcts_graph.py`)

**Objective:** Build a lightweight MCTS tree that produces an optimal play graph for visualization.

**Files:**
- Create: `pokeredus/pokeredus/graph/mcts_graph.py`

**Design:**

```python
@dataclass
class MCTSNode:
    """A node in the MCTS tree."""
    state_hash: str
    action: SimAction | None  # action that led to this state
    parent: 'MCTSNode | None'
    
    # Statistics
    visits: int = 0
    value_sum: float = 0.0  # cumulative win probability
    
    # Children
    children: dict[str, 'MCTSNode'] = field(default_factory=dict)
    untried_actions: list[SimAction] = field(default_factory=list)
    
    @property
    def value(self) -> float:
        return self.value_sum / max(self.visits, 1)
    
    def ucb1(self, exploration: float = 2.0) -> float:
        """Upper Confidence Bound for tree policy."""
        ...

@dataclass
class MCTSGraph:
    """Result of MCTS search — a tree for visualization."""
    root: MCTSNode
    nodes: list[MCTSNode]
    edges: list[tuple[str, str, SimAction]]  # parent_hash, child_hash, action
    best_path: list[tuple[MCTSNode, SimAction]]  # path to best leaf

class MCTSSearcher:
    """
    MCTS search over game states.
    
    Selection: UCB1 from root to leaf
    Expansion: Add one untried action as a child
    Simulation: Fast rollout to terminal (probabilistic damage)
    Backpropagation: Update value from leaf back to root
    
    This is the 'optimal play graph' the user asked for —
    incorporating both moves AND switches as actions.
    """
    
    def __init__(self, engine: ProbabilisticEngine, 
                 max_iterations: int = 100,
                 exploration_constant: float = 2.0):
        ...
    
    def search(self, state: GameState, perspective: str = 'a') -> MCTSGraph:
        """Run MCTS from a state, return the search tree."""
        ...
    
    def select(self, node: MCTSNode) -> MCTSNode:
        """Select a leaf node using UCB1."""
        ...
    
    def expand(self, node: MCTSNode, state: GameState, perspective: str) -> MCTSNode | None:
        """Expand by adding one child from untried actions."""
        ...
    
    def simulate(self, state: GameState, perspective: str) -> float:
        """Fast rollout from leaf to terminal."""
        ...
    
    def backpropagate(self, node: MCTSNode, value: float):
        """Update statistics up the tree."""
        ...
    
    def extract_graph(self, root: MCTSNode) -> MCTSGraph:
        """Convert tree nodes to a flat graph for visualization."""
        ...
```

**Key constraints:**
- MCTS is for optimal play guidance, not heavy training — keep iterations reasonable (50-200)
- Store state hashes to avoid recomputing the same state
- Rollouts use the probabilistic engine's damage sampling
- Actions include both attacking moves AND switches to bench Pokémon

---

## Subtask 3: Simulator GUI Page (`pokeredus/gui/simulator_page.py`)

**Objective:** Build the 4th page — a game state simulator with win% display and MCTS graph visualization.

**Files:**
- Create: `pokeredus/pokeredus/gui/simulator_page.py`
- Modify: `pokeredus/pokeredus/gui/app.py` (add 4th page + navigation)

**Layout:**
```
┌──────────────────────────────────────────────────────────┐
│ [← Back]  Game State Simulator                          │
├──────────────┬──────────────────────┬────────────────────┤
│ TEAM A (6)   │  ACTIVE CONDITIONS   │ TEAM B (6)        │
│ ┌──────────┐ │                      │ ┌──────────┐       │
│ │Pokemon 1 │ │  Weather: [None ▼]   │ │Pokemon 1 │       │
│ │HP ████░░  │ │  Terrain: [None ▼]  │ │HP ████░░  │       │
│ │★ SetName  │ │  Trick Room: ☐      │ │★ SetName  │       │
│ ├──────────┤ │                      │ ├──────────┤       │
│ │Pokemon 2 │ │  ACTIVE MODIFIERS    │ │Pokemon 2 │       │
│ │  ...      │ │  ┌────────────────┐ │ │  ...      │       │
│ │           │ │  │ Item: [CB ▼]   │ │ │           │       │
│ ├──────────┤ │  │ Ability: [Ada▼] │ │ ├──────────┤       │
│ │ Import ▼  │ │  │ +Add Modifier  │ │ │ Import ▼  │       │
│ └──────────┘ │  └────────────────┘ │ └──────────┘       │
├──────────────┴──────────────────────┴────────────────────┤
│  WIN PROBABILITY                    MCTS GRAPH           │
│  ┌──────────────┐  ┌─────────────────────────────────┐   │
│  │              │  │  [State A]──move:X──>[State B]  │   │
│  │  Team A: 62% │  │      │switch:Y                  │   │
│  │  Team B: 35% │  │  [State C]──move:Z──>[State D]  │   │
│  │  Draw:   3%  │  │      │                           │   │
│  │              │  │  [State E]   ...                 │   │
│  └──────────────┘  └─────────────────────────────────┘   │
├──────────────────────────────────────────────────────────┤
│ [Simulate 100 rollouts]  [MCTS Search (50 iters)]       │
│ Status: Ready                                           │
└──────────────────────────────────────────────────────────┘
```

**Implementation details:**
- Left/right team panels: 6-slot lists with HP bars, set selector, import from existing teams
- Center panel: active conditions (weather, terrain, trick room) + modifier editor (item/ability dropdowns with real-time effect on score)
- Bottom-left: win probability display (large %, colored green/yellow/red)
- Bottom-right: MCTS graph visualization (Canvas-based node-edge diagram, scrollable)
- Import button opens `PokemonSetSelectorDialog` (reuse from team_builder)
- Modifier changes trigger automatic re-evaluation via debounced callback (500ms)

**Navigation integration (app.py):**
```python
# Add 4th button on title screen
("Game Simulator", NEON_ORANGE, self._go_simulator)

def _go_simulator(self):
    if self._simulator_page is None:
        from pokeredus.gui.simulator_page import SimulatorPage
        page = SimulatorPage(self._container, self.kg, self.matchup_cache,
                            self._go_home, self._battle_simulator)
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["simulator"] = page
        self._simulator_page = page
    self._show_page("simulator")
```

---

## Task Execution Order

1. **Subtask 1** (probabilistic_engine.py) — independent, no deps on other new files
2. **Subtask 2** (mcts_graph.py) — depends on Subtask 1 (uses ProbabilisticEngine)
3. **Subtask 3** (simulator_page.py + app.py edits) — depends on 1 & 2

Tasks 1 can run in parallel with planning for 2+3.
Task 2 needs Task 1 complete.
Task 3 needs 1+2 complete but can start its GUI scaffolding in parallel.

---

## Open Design Questions

1. **MCTS search depth**: Default 3 plies (both sides act = 6 total moves) or deeper?
   → Recommendation: 3 plies for speed, user-adjustable

2. **Rollout count default**: 10, 30, or 100 rollouts per state evaluation?
   → Recommendation: 30 (fast enough for GUI interactivity)

3. **Graph visualization**: Simple canvas-based node-edge diagram vs. force-directed layout?
   → Recommendation: Canvas-based with manual layout (top-down tree) for speed

4. **Modifier persistence**: Should modifier edits save to sets permanently or be session-only?
   → Recommendation: Session-only (tooltip says "Temporary modifiers for simulation")