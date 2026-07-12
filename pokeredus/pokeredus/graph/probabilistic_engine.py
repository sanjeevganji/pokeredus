"""
Probabilistic Battle Engine — Monte Carlo simulation over GameState.

Core abstraction: takes a GameState (teams, HP, field, conditions) and
runs multiple rollouts with probabilistic damage sampling to compute
win probabilities and action-value estimates.

Integrates with existing BattleSimulator for SpeciesProfile/MoveEvaluation
lookup and GameState for state management.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from pokeredus.graph.game_state import GameState, PokemonState
    from pokeredus.graph.battle_simulator import (
        BattleSimulator, SpeciesProfile, MoveEvaluation, SpeciesMatchupResult,
    )
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.graph.matchup_cache_provider import (
        CachedMatchupProvider, MatchupSnapshot,
    )


@dataclass
class SimAction:
    """A possible action in a game state."""
    action_type: str  # 'move' | 'switch'
    target_id: str     # move_id (for 'move') or set_id (for 'switch')
    source_side: str   # 'a' or 'b'

    def __repr__(self) -> str:
        if self.action_type == 'move':
            return f"{self.source_side}:move({self.target_id})"
        return f"{self.source_side}:switch({self.target_id})"


@dataclass
class RolloutResult:
    """Result of a single full-battle Monte Carlo rollout."""
    winner: str          # 'a' | 'b' | 'draw'
    turns: int
    final_hp_a: dict[str, int] = field(default_factory=dict)  # set_id -> HP
    final_hp_b: dict[str, int] = field(default_factory=dict)
    action_log: list[str] = field(default_factory=list)


@dataclass
class ActionStats:
    """Aggregated rollout statistics for one action from a state."""
    action: SimAction
    wins: int = 0
    losses: int = 0
    draws: int = 0
    total_rollouts: int = 0
    avg_turns: float = 0.0

    @property
    def win_rate(self) -> float:
        if self.total_rollouts == 0:
            return 0.0
        return self.wins / self.total_rollouts


@dataclass
class StateEvaluation:
    """Full evaluation of a game state after Monte Carlo sampling."""
    win_probability: float       # 0.0-1.0 from perspective 'a'
    draw_probability: float      # 0.0-1.0
    loss_probability: float      # 0.0-1.0
    actions: list[ActionStats] = field(default_factory=list)   # available actions with their stats
    best_action: Optional[SimAction] = None
    rollout_count: int = 0

    @property
    def perspective_win_pct(self) -> float:
        """Win % formatted for display (0-100)."""
        return self.win_probability * 100.0


class ProbabilisticEngine:
    """
    Monte Carlo battle simulator.

    For a given GameState, runs N rollouts with probabilistic damage
    sampling (picking random values from the 16-roll damage distribution).
    Each rollout simulates the full battle to completion using a
    semi-randomized action selection policy (epsilon-greedy over best moves).

    This is the NUMERIC ABSTRACTION layer — converts complex game state
    into pure probability numbers using existing TTK/matchup infrastructure.

    When a CachedMatchupProvider is set (via ``set_cache_provider()``),
    the engine uses precomputed damage/TTK from the cache instead of
    re-running the full damage formula on every move evaluation.  This
    makes MCTS over large rosters viable in real time.
    """

    def __init__(
        self,
        kg: KnowledgeGraph,
        battle_simulator: BattleSimulator,
        num_rollouts: int = 30,
        max_turns: int = 200,
        seed: int | None = None,
        cache_provider: 'CachedMatchupProvider | None' = None,
    ):
        self.kg = kg
        self.sim = battle_simulator
        self.default_rollouts = num_rollouts
        self.max_turns = max_turns
        self._rng = random.Random(seed)
        self._cache_provider = cache_provider

    # ── Cache provider ──────────────────────────────────────────

    def set_cache_provider(
        self, provider: 'CachedMatchupProvider | None',
    ) -> None:
        """Inject a precomputed cache for fast damage/TTK lookups.

        When set, ``_pick_best_move`` and ``_execute_move`` consult the
        cache before falling back to live damage calculation.
        """
        self._cache_provider = provider

    @property
    def cache_provider(self) -> 'CachedMatchupProvider | None':
        return self._cache_provider

    # ── Public API ──────────────────────────────────────────────────

    def evaluate_state(
        self,
        state: GameState,
        perspective: str = 'a',
        num_rollouts: int | None = None,
    ) -> StateEvaluation:
        """
        Evaluate a game state by running Monte Carlo rollouts.

        Each rollout: clone state, play turns until battle ends or
        max_turns reached, record winner.

        Also evaluates each available top-level action with dedicated rollouts.
        """
        n = num_rollouts or self.default_rollouts

        wins = 0
        losses = 0
        draws = 0

        for _ in range(n):
            clone = state.clone()
            result = self._rollout(clone)
            if result.winner == perspective:
                wins += 1
            elif result.winner == 'draw':
                draws += 1
            else:
                losses += 1

        evaluation = StateEvaluation(
            win_probability=wins / n,
            draw_probability=draws / n,
            loss_probability=losses / n,
            rollout_count=n,
        )

        # Evaluate each available action
        actions = self.get_available_actions(state, perspective)
        action_stats: list[ActionStats] = []

        per_action = max(5, n // max(len(actions), 1))

        for action in actions:
            stats = ActionStats(action=action, total_rollouts=per_action)
            for _ in range(per_action):
                clone = state.clone()
                self._execute_action(clone, action)
                result = self._rollout(clone)
                if result.winner == perspective:
                    stats.wins += 1
                elif result.winner == 'draw':
                    stats.draws += 1
                else:
                    stats.losses += 1
            action_stats.append(stats)

        action_stats.sort(key=lambda s: s.win_rate, reverse=True)
        evaluation.actions = action_stats
        evaluation.best_action = action_stats[0].action if action_stats else None

        return evaluation

    def quick_win_pct(
        self,
        state: GameState,
        perspective: str = 'a',
        num_rollouts: int = 20,
    ) -> float:
        """Fast win% estimate without per-action breakdown."""
        wins = 0
        for _ in range(num_rollouts):
            clone = state.clone()
            result = self._rollout(clone)
            if result.winner == perspective:
                wins += 1
        return wins / num_rollouts

    def get_available_actions(
        self, state: GameState, side: str
    ) -> list[SimAction]:
        """
        Enumerate all possible actions for a side.

        Includes all damaging moves for the active Pokemon and
        switch actions for each alive benched Pokemon.
        """
        active = state.get_active_pokemon(side)
        if not active or active.is_fainted:
            return []

        actions: list[SimAction] = []

        # Moves from the active pokemon's set
        set_obj = self.kg.get_set(active.set_id)
        if set_obj:
            for move_id in set_obj.moves:
                move = self.kg.get_move(move_id)
                if move and not move.is_status:
                    actions.append(SimAction('move', move_id, side))

        # Switches to benched Pokemon
        team = state.team_a if side == 'a' else state.team_b
        active_idx = state.active_a if side == 'a' else state.active_b
        for i, pkmn in enumerate(team):
            if i != active_idx and not pkmn.is_fainted:
                actions.append(SimAction('switch', pkmn.set_id, side))

        return actions

    # ── Rollout Core ────────────────────────────────────────────────

    def _rollout(self, state: GameState) -> RolloutResult:
        """
        Run a single full-battle rollout from the current state.

        Semi-randomized action selection:
        - 70% best available move
        - 20% random move
        - 10% random switch
        """
        for turn in range(self.max_turns):
            is_over, winner = state.is_battle_over()
            if is_over:
                return RolloutResult(winner=winner or 'draw', turns=turn)

            for side in ('a', 'b'):
                active = state.get_active_pokemon(side)
                if not active or active.is_fainted:
                    self._force_switch(state, side)
                    continue

                roll = self._rng.random()
                opponent = state.get_opponent(side)

                if roll < 0.70 and opponent and not opponent.is_fainted:
                    action = self._pick_best_move(state, side)
                elif roll < 0.90:
                    action = self._pick_random_move(state, side)
                else:
                    action = self._pick_random_switch(state, side)

                if action:
                    self._execute_action(state, action)

                is_over, winner = state.is_battle_over()
                if is_over:
                    return RolloutResult(winner=winner or 'draw', turns=turn)

            state.tick()

        # Max turns reached — HP tiebreak
        winner = self._evaluate_hp_tiebreak(state)
        result = RolloutResult(winner=winner, turns=self.max_turns)
        for pkmn in state.team_a:
            result.final_hp_a[pkmn.set_id] = pkmn.current_hp
        for pkmn in state.team_b:
            result.final_hp_b[pkmn.set_id] = pkmn.current_hp
        return result

    # ── Action Selection ────────────────────────────────────────────

    def _pick_best_move(self, state: GameState, side: str) -> Optional[SimAction]:
        """Pick the best damaging move using TTK evaluation.

        If a CachedMatchupProvider is available, we extract the best_move_id
        directly from the cache (O(1) lookup).  Otherwise we fall back to
        iterating all moves through the damage calculator.
        """
        active = state.get_active_pokemon(side)
        opponent = state.get_opponent(side)
        if not active or not opponent:
            return self._pick_random_move(state, side)

        # ── Fast path: cache lookup ─────────────────────────────
        if self._cache_provider and self._cache_provider.is_ready:
            snap = self._cache_provider.lookup(
                active.pokemon_id, opponent.pokemon_id,
            )
            if snap and snap.best_move_id and not snap.is_immune:
                # Verify the cached best move is in the active set
                set_obj = self.kg.get_set(active.set_id)
                if set_obj and snap.best_move_id in set_obj.moves:
                    return SimAction('move', snap.best_move_id, side)

        # ── Slow path: compute via BattleSimulator ──────────────
        our_profile = self.sim.get_profile(active.pokemon_id)
        their_profile = self.sim.get_profile(opponent.pokemon_id)

        if not our_profile or not their_profile:
            return self._pick_random_move(state, side)

        set_obj = self.kg.get_set(active.set_id)
        if not set_obj:
            return self._pick_random_move(state, side)

        best_move_id = None
        best_dmg = 0

        for move_id in set_obj.moves:
            move = self.kg.get_move(move_id)
            if not move or move.is_status:
                continue
            ev = self.sim._evaluate_move(
                move_id, our_profile, their_profile,
                self.sim._get_attribute_modifiers(our_profile),
                self.sim._get_attribute_modifiers(their_profile),
            )
            if ev and not ev.is_immune and ev.avg_damage > best_dmg:
                best_dmg = ev.avg_damage
                best_move_id = move_id

        if best_move_id:
            return SimAction('move', best_move_id, side)
        return self._pick_random_move(state, side)

    def _pick_random_move(self, state: GameState, side: str) -> Optional[SimAction]:
        actions = self.get_available_actions(state, side)
        move_actions = [a for a in actions if a.action_type == 'move']
        if move_actions:
            return self._rng.choice(move_actions)
        return None

    def _pick_random_switch(self, state: GameState, side: str) -> Optional[SimAction]:
        actions = self.get_available_actions(state, side)
        switch_actions = [a for a in actions if a.action_type == 'switch']
        if switch_actions:
            return self._rng.choice(switch_actions)
        return None

    def _force_switch(self, state: GameState, side: str) -> bool:
        """Force switch to first alive benched Pokemon after a faint."""
        team = state.team_a if side == 'a' else state.team_b
        active_idx = state.active_a if side == 'a' else state.active_b

        for i, pkmn in enumerate(team):
            if i != active_idx and not pkmn.is_fainted:
                return state.switch_pokemon(side, i)
        return False

    # ── Action Execution ────────────────────────────────────────────

    def _execute_action(self, state: GameState, action: SimAction) -> None:
        """Execute a SimAction on a game state (mutates in-place)."""
        if action.action_type == 'switch':
            self._execute_switch(state, action)
        elif action.action_type == 'move':
            self._execute_move(state, action)

    def _execute_switch(self, state: GameState, action: SimAction) -> None:
        team = state.team_a if action.source_side == 'a' else state.team_b
        for i, pkmn in enumerate(team):
            if pkmn.set_id == action.target_id and not pkmn.is_fainted:
                state.switch_pokemon(action.source_side, i)
                return

    def _execute_move(self, state: GameState, action: SimAction) -> None:
        """Execute a move: compute probabilistic damage, apply to defender.

        Prefers the cached damage distribution when available (reads
        min_damage/max_damage and samples a roll between them); falls
        back to full damage-calc recomputation on cache miss.
        """
        attacker = state.get_active_pokemon(action.source_side)
        defender = state.get_opponent(action.source_side)

        if not attacker or not defender or defender.is_fainted:
            return

        move = self.kg.get_move(action.target_id)
        if not move or move.is_status:
            return

        # ── Fast path: use cached damage range ──────────────────
        if self._cache_provider and self._cache_provider.is_ready:
            snap = self._cache_provider.lookup(
                attacker.pokemon_id, defender.pokemon_id,
            )
            if snap and not snap.is_immune:
                # Sample damage uniformly between min and max damage
                actual_damage = self._rng.randint(snap.min_damage, snap.max_damage)
                defender.take_damage(max(1, actual_damage))
                attacker.use_move(action.target_id)
                return

        # ── Slow path: full damage-calc recomputation ───────────
        attacker_profile = self.sim.get_profile(attacker.pokemon_id)
        defender_profile = self.sim.get_profile(defender.pokemon_id)

        if not attacker_profile or not defender_profile:
            return

        attacker_mods = self.sim._get_attribute_modifiers(attacker_profile)
        defender_mods = self.sim._get_attribute_modifiers(defender_profile)

        ev = self.sim._evaluate_move(
            action.target_id, attacker_profile, defender_profile,
            attacker_mods, defender_mods,
        )

        if ev is None or ev.is_immune:
            return

        is_physical = move.is_physical
        level = self.sim.calc.level

        if is_physical:
            off_stat = int(max(1, attacker_profile.best_atk * attacker_mods.get('physical_mult', 1.0)))
            def_stat = int(max(1, defender_profile.best_def * defender_mods.get('defense_mult', 1.0)))
        else:
            off_stat = int(max(1, attacker_profile.best_spa * attacker_mods.get('special_mult', 1.0)))
            def_stat = int(max(1, defender_profile.best_spd * defender_mods.get('spdef_mult', 1.0)))

        # Type effectiveness
        type_eff = 1.0
        if hasattr(move, 'type') and move.type:
            try:
                from pokeredus.classes.types import get_effectiveness
                defender_pokemon = self.kg.get_pokemon(defender.pokemon_id)
                if defender_pokemon:
                    type_eff = get_effectiveness(move.type, defender_pokemon.types)
            except ImportError:
                pass

        if type_eff == 0:
            return

        # STAB
        attacker_pokemon = self.kg.get_pokemon(attacker.pokemon_id)
        stab = 1.5 if (
            attacker_pokemon and hasattr(move, 'type') and move.type in attacker_pokemon.types
        ) else 1.0

        # Base damage formula
        base_dmg = int(((2 * level / 5 + 2) * max(1, move.base_power) * off_stat / def_stat) / 50 + 2)
        item_mult = attacker_mods.get('damage_mult', 1.0)

        full_dmg = base_dmg * stab * type_eff * item_mult

        # Probabilistic roll — pick from the 16-roll distribution
        from pokeredus.graph.battle_simulator import DAMAGE_ROLLS
        roll = self._rng.choice(DAMAGE_ROLLS)
        actual_damage = max(1, int(full_dmg * roll))

        defender.take_damage(actual_damage)
        attacker.use_move(action.target_id)

    # ── Tiebreak ────────────────────────────────────────────────────

    def _evaluate_hp_tiebreak(self, state: GameState) -> str:
        """Max turns reached — score based on remaining HP + alive count."""
        hp_a = sum(p.current_hp for p in state.team_a if not p.is_fainted)
        hp_b = sum(p.current_hp for p in state.team_b if not p.is_fainted)
        alive_a = state.count_alive('a')
        alive_b = state.count_alive('b')

        score_a = alive_a * 1000 + hp_a
        score_b = alive_b * 1000 + hp_b

        if score_a > score_b:
            return 'a'
        elif score_b > score_a:
            return 'b'
        return 'draw'

    # ── State Factory ───────────────────────────────────────────────

    def create_state_from_sets(
        self,
        team_a_sets: list[str],
        team_b_sets: list[str],
    ) -> GameState:
        """
        Build a GameState from two lists of set IDs.

        Initializes PokemonState for each set with full HP.
        Sets the first alive Pokemon as active on each side.
        """
        from pokeredus.graph.game_state import GameState, PokemonState

        def build_team(set_ids: list[str]) -> list[PokemonState]:
            team: list[PokemonState] = []
            for sid in set_ids[:6]:
                set_obj = self.kg.get_set(sid)
                if not set_obj:
                    continue
                pokemon = self.kg.get_pokemon(set_obj.pokemon_id)
                if not pokemon:
                    continue

                hp = self._compute_hp(set_obj, pokemon, self.sim.calc.level)

                pstate = PokemonState(
                    pokemon_id=set_obj.pokemon_id,
                    set_id=sid,
                    current_hp=hp,
                    max_hp=hp,
                )
                team.append(pstate)
            return team

        state = GameState(
            team_a=build_team(team_a_sets),
            team_b=build_team(team_b_sets),
        )

        if state.team_a and not state.team_a[0].is_fainted:
            state.team_a[0].is_active = True
            state.active_a = 0
        if state.team_b and not state.team_b[0].is_fainted:
            state.team_b[0].is_active = True
            state.active_b = 0

        return state

    @staticmethod
    def _compute_hp(set_obj, pokemon, level: int) -> int:
        """Compute HP stat for a Pokemon."""
        base = pokemon.base_stats.get('hp', 0)
        iv = set_obj.ivs.get('hp', 31)
        # evs is an EVSpreadClass dataclass, not a dict
        evs = getattr(set_obj, 'evs', None)
        if evs is not None and hasattr(evs, 'get'):
            ev = evs.get('hp')
        else:
            ev = 0
        return int(((2 * base + iv + ev // 4) * level / 100) + level + 10)