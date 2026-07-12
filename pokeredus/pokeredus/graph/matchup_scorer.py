"""
MCTS-style scoring system for matchup analysis.

Uses SpeciesProfile to evaluate matchups across all available sets and moves.
Scores are decimal values in [-1.0, +1.0] considering:
- Weighted TTK across all viable moves
- Speed advantage with attribute modifiers
- Move pool depth and flexibility
- Priority move considerations
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pokeredus.classes import SetClass
    from pokeredus.graph.damage_calc import DamageCalculator
    from pokeredus.graph.battle_simulator import BattleSimulator, SpeciesMatchupResult


@dataclass
class MatchupScore:
    """Scored matchup result with all details."""
    score: float  # -1.0 (total loss) to +1.0 (total win)
    outcome: 'SpeciesMatchupResult'
    category: str  # 'counter', 'check', 'neutral', 'checked_by', 'countered_by'
    eval_text: str

    @property
    def is_win(self) -> bool:
        return self.score > 0.2

    @property
    def is_loss(self) -> bool:
        return self.score < -0.2

    @property
    def is_neutral(self) -> bool:
        return -0.2 <= self.score <= 0.2


class MatchupScorer:
    """Computes MCTS-style matchup scores using species profiles.

    Unlike the old system that compared individual sets, this scorer:
    1. Builds optimal species profiles (best stats + all moves)
    2. Evaluates all damaging moves with full roll distribution
    3. Weights moves by viability to compute effective TTK
    4. Applies attribute modifiers from items/abilities
    5. Produces decimal scores scalable to team matchups
    """

    def __init__(self, calc: 'DamageCalculator', kg, attribute_manager=None):
        from pokeredus.graph.battle_simulator import BattleSimulator
        self.calc = calc
        self.kg = kg
        self.attribute_manager = attribute_manager
        self.sim = BattleSimulator(calc, kg, attribute_manager)

    def score_matchup(
        self,
        our_set: 'SetClass',
        their_set: 'SetClass'
    ) -> MatchupScore:
        """Score a matchup between two sets by building species profiles.

        For backward compatibility with GUI code that passes sets,
        we extract pokemon_id and build full species profiles.
        """
        our_pokemon_id = our_set.pokemon_id
        their_pokemon_id = their_set.pokemon_id

        # Build species profiles (cached)
        our_profile = self.sim.get_profile(our_pokemon_id)
        their_profile = self.sim.get_profile(their_pokemon_id)

        # Simulate the matchup
        result = self.sim.simulate(our_profile, their_profile)

        return MatchupScore(
            score=result.score,
            outcome=result,
            category=result.category,
            eval_text=result.eval_text,
        )

    def score_matchup_by_id(
        self,
        our_pokemon_id: str,
        their_pokemon_id: str
    ) -> MatchupScore:
        """Score a matchup directly by pokemon IDs."""
        result = self.sim.simulate_by_id(our_pokemon_id, their_pokemon_id)

        return MatchupScore(
            score=result.score,
            outcome=result,
            category=result.category,
            eval_text=result.eval_text,
        )

    def score_team_matchup(
        self,
        our_team_ids: list[str],
        their_team_ids: list[str]
    ) -> float:
        """Score a team vs team matchup by averaging individual scores.

        This is scalable: can handle 1v1, 3v3, or 6v6 matchups.
        Returns average score across all pairwise matchups.
        """
        if not our_team_ids or not their_team_ids:
            return 0.0

        total_score = 0.0
        count = 0

        for our_id in our_team_ids:
            for their_id in their_team_ids:
                result = self.sim.simulate_by_id(our_id, their_id)
                total_score += result.score
                count += 1

        return total_score / count if count > 0 else 0.0

    def clear_cache(self):
        """Clear the species profile cache."""
        self.sim.clear_cache()
