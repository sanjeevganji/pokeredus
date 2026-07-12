"""
MCTS Graph — lightweight Monte Carlo Tree Search for optimal play visualization.

Builds a search tree over game states where nodes are positions and
edges are actions (moves or switches). Uses UCB1 selection with
probabilistic rollouts for simulation.

The output is an MCTSGraph — a tree that can be rendered as a
node-edge diagram in the GUI showing the optimal play path.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from pokeredus.graph.game_state import GameState
    from pokeredus.graph.probabilistic_engine import (
        ProbabilisticEngine, SimAction, RolloutResult,
    )


@dataclass
class MCTSNode:
    """A node in the MCTS search tree."""
    state_hash: str
    action: Optional[SimAction] = None   # action that led to this node
    parent: Optional[MCTSNode] = None

    # MCTS statistics
    visits: int = 0
    value_sum: float = 0.0  # cumulative win probability (from perspective)

    # Children
    children: dict[str, MCTSNode] = field(default_factory=dict)
    untried_actions: list[SimAction] = field(default_factory=list)

    @property
    def value(self) -> float:
        if self.visits == 0:
            return 0.5
        return self.value_sum / self.visits

    @property
    def is_leaf(self) -> bool:
        return len(self.children) == 0

    @property
    def is_fully_expanded(self) -> bool:
        return len(self.untried_actions) == 0

    def ucb1(self, parent_visits: int, exploration: float = 2.0) -> float:
        """Upper Confidence Bound for tree policy selection."""
        if self.visits == 0:
            return float('inf')
        exploitation = self.value
        exploration_term = exploration * math.sqrt(math.log(parent_visits) / self.visits)
        return exploitation + exploration_term


@dataclass
class MCTSEdge:
    """An edge in the MCTS graph for visualization."""
    parent_hash: str
    child_hash: str
    action: SimAction
    visit_count: int
    value: float


@dataclass
class MCTSGraph:
    """Full MCTS search result — a tree for visualization."""
    root: MCTSNode
    nodes: list[MCTSNode]
    edges: list[MCTSEdge]
    best_path: list[tuple[MCTSNode, Optional[SimAction]]]  # (node, action_to_get_there)
    iterations: int
    root_value: float  # estimated win probability from root


class MCTSSearcher:
    """
    MCTS search over game states for optimal play discovery.

    Algorithm:
    1. SELECT — traverse tree using UCB1 from root to a leaf
    2. EXPAND — add one untried action as a child node
    3. SIMULATE — run a fast probabilistic rollout from the new node
    4. BACKPROPAGATE — update win/loss stats up the tree

    This produces the 'optimal play graph' — a tree incorporating
    both moves AND switches as actions.
    """

    def __init__(
        self,
        engine: ProbabilisticEngine,
        max_iterations: int = 100,
        exploration_constant: float = 2.0,
        seed: int | None = None,
    ):
        self.engine = engine
        self.max_iterations = max_iterations
        self.exploration = exploration_constant
        self._rng = random.Random(seed)

    def search(
        self,
        state: GameState,
        perspective: str = 'a',
    ) -> MCTSGraph:
        """
        Run MCTS from a game state.

        Args:
            state: The starting game state.
            perspective: Which side we're optimizing for ('a' or 'b').

        Returns:
            MCTSGraph with the search tree and best path.
        """
        root_state_hash = _hash_state(state)
        root = MCTSNode(state_hash=root_state_hash)

        # Initialize untried actions for the root
        root.untried_actions = self.engine.get_available_actions(state, perspective)

        for iteration in range(self.max_iterations):
            # Phase 1: SELECT — traverse tree to a leaf
            node, sim_state = self._select(root, state, perspective)

            # Phase 2: EXPAND — if not terminal and has untried actions
            if not node.is_fully_expanded and sim_state:
                node = self._expand(node, sim_state, perspective)

            # Phase 3: SIMULATE — rollout from the new node
            if sim_state:
                # Check if battle already over
                is_over, winner = sim_state.is_battle_over()
                if is_over:
                    value = 1.0 if winner == perspective else (0.5 if winner is None else 0.0)
                else:
                    value = self._simulate(sim_state, perspective)
            else:
                value = 0.5

            # Phase 4: BACKPROPAGATE
            self._backpropagate(node, value)

        # Build graph for visualization
        return self._extract_graph(root, perspective)

    def _select(
        self,
        root: MCTSNode,
        root_state: GameState,
        perspective: str,
    ) -> tuple[MCTSNode, Optional[GameState]]:
        """
        SELECT: traverse from root using UCB1.
        Returns (leaf_node, state_at_leaf).
        """
        node = root
        state = root_state.clone()

        while not node.is_leaf and node.is_fully_expanded:
            # Pick child with highest UCB1
            best_child = None
            best_ucb = -float('inf')

            for child in node.children.values():
                ucb = child.ucb1(node.visits, self.exploration)
                if ucb > best_ucb:
                    best_ucb = ucb
                    best_child = child

            if best_child is None:
                break

            # Apply the action to advance state
            if best_child.action:
                self.engine._execute_action(state, best_child.action)

            node = best_child

        return node, state

    def _expand(
        self,
        node: MCTSNode,
        state: GameState,
        perspective: str,
    ) -> MCTSNode:
        """
        EXPAND: pick one untried action, create a child node for it.
        Returns the newly created child node.
        """
        if not node.untried_actions:
            return node

        # Pick a random untried action
        action = node.untried_actions.pop(0)
        self._rng.shuffle(node.untried_actions)  # mix up for next time

        # Clone state and apply the action
        new_state = state.clone()
        self.engine._execute_action(new_state, action)

        new_hash = _hash_state(new_state)
        child = MCTSNode(
            state_hash=new_hash,
            action=action,
            parent=node,
        )

        # Initialize child's untried actions
        child.untried_actions = self.engine.get_available_actions(new_state, perspective)
        self._rng.shuffle(child.untried_actions)

        node.children[new_hash] = child
        return child

    def _simulate(self, state: GameState, perspective: str) -> float:
        """
        SIMULATE: run a fast probabilistic rollout from the given state.
        Returns win probability (0.0-1.0) from the perspective.
        """
        clone = state.clone()
        result = self.engine._rollout(clone)
        if result.winner == perspective:
            return 1.0
        elif result.winner == 'draw':
            return 0.5
        return 0.0

    def _backpropagate(self, node: MCTSNode, value: float) -> None:
        """
        BACKPROPAGATE: update statistics from leaf up to root.
        """
        current = node
        while current is not None:
            current.visits += 1
            current.value_sum += value
            current = current.parent

    def _extract_graph(self, root: MCTSNode, perspective: str) -> MCTSGraph:
        """
        Convert the MCTS tree to a flat graph structure for visualization.
        Also finds the best path (highest-visited path from root to leaf).
        """
        all_nodes: list[MCTSNode] = []
        all_edges: list[MCTSEdge] = []

        def visit(node: MCTSNode):
            all_nodes.append(node)
            for child_hash, child in node.children.items():
                if child.action:
                    all_edges.append(MCTSEdge(
                        parent_hash=node.state_hash,
                        child_hash=child_hash,
                        action=child.action,
                        visit_count=child.visits,
                        value=child.value,
                    ))
                visit(child)

        visit(root)

        # Find best path: follow highest-visit child from root
        best_path: list[tuple[MCTSNode, Optional[SimAction]]] = [(root, None)]
        current = root
        while current.children:
            best_child = max(current.children.values(), key=lambda c: c.visits)
            best_path.append((best_child, best_child.action))
            current = best_child

        return MCTSGraph(
            root=root,
            nodes=all_nodes,
            edges=all_edges,
            best_path=best_path,
            iterations=self.max_iterations,
            root_value=root.value,
        )


def _hash_state(state: GameState) -> str:
    """
    Hash a game state to a short string for node identity.

    Uses a subset of state data that uniquely identifies the position:
    - Active pokemon IDs + HP buckets
    - Alive/dead status
    - Field conditions
    """
    active_a = state.get_active_pokemon('a')
    active_b = state.get_active_pokemon('b')

    key_parts = {
        'turn': state.turn,
        'active_a': active_a.set_id if active_a else '',
        'active_b': active_b.set_id if active_b else '',
        'hp_a': _bucket_hp(active_a.current_hp, active_a.max_hp) if active_a else 0,
        'hp_b': _bucket_hp(active_b.current_hp, active_b.max_hp) if active_b else 0,
        'alive_a': [p.set_id for p in state.team_a if not p.is_fainted],
        'alive_b': [p.set_id for p in state.team_b if not p.is_fainted],
        'trick_room': state.trick_room,
    }

    raw = json.dumps(key_parts, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()[:12]


def _bucket_hp(current: int, max_hp: int) -> int:
    """Bucket HP into coarse bins to reduce state space explosion."""
    if max_hp <= 0:
        return 0
    pct = current / max_hp
    if pct >= 0.75:
        return 4  # green
    elif pct >= 0.50:
        return 3  # yellow
    elif pct >= 0.25:
        return 2  # orange
    elif pct > 0:
        return 1  # red
    return 0  # fainted