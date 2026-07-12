"""
CachedMatchupProvider — adapts MatchupCache for use by the probabilistic engine.

Instead of computing damage/type-effectiveness/TTK on the fly via
BattleSimulator._evaluate_move(), the engine can now consult the
precomputed MatchupCache for any (pokemon_a, pokemon_b) pair.

When a matchup is cached the engine skips the expensive damage formula
and directly reads: turns_to_kill, best_move, damage_per_hit, type
effectiveness, and move category.  This transforms simulation from an
O(N²) damage-calc loop into O(1) cache lookups, enabling real-time
MCTS over large rosters.

Usage:
    from pokeredus.graph.matchup_cache_provider import CachedMatchupProvider

    provider = CachedMatchupProvider(cache)
    entry = provider.lookup("garchomp", "toxapex")
    if entry:
        # use entry.turns_to_kill, entry.best_move_id, etc.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from pokeredus.graph.matchup_cache import MatchupCache, CachedMatchup


@dataclass
class MatchupSnapshot:
    """Lightweight struct with everything the engine needs to run a
    single action evaluation — extracted from CachedMatchup."""

    attacker_id: str
    defender_id: str

    turns_to_kill: int
    best_move_id: str
    damage_per_hit: int
    min_damage: int
    max_damage: int
    min_ttk: int
    max_ttk: int

    damage_pct_lo: float
    damage_pct_hi: float

    type_effectiveness: float
    stab: float
    move_type: str
    move_category: str  # "Physical" or "Special"

    offensive_stat: int
    defensive_stat: int

    # ── derived ─────────────────────────────────────────────────

    @property
    def is_immune(self) -> bool:
        return self.type_effectiveness == 0

    @property
    def is_physical(self) -> bool:
        return self.move_category == "Physical"

    @property
    def avg_damage(self) -> float:
        return (self.min_damage + self.max_damage) / 2.0


class CachedMatchupProvider:
    """Thin adapter: MatchupCache → probabilistic engine / MCTS.

    The engine calls ``lookup(attacker_id, defender_id)`` to get a
    snapshot with all the damage/TTK fields precomputed.  The provider
    handles cache misses transparently by returning None (caller can
    fall back to live calculation).
    """

    def __init__(self, cache: MatchupCache | None = None):
        self._cache: MatchupCache | None = cache

    @property
    def cache(self) -> MatchupCache | None:
        return self._cache

    @cache.setter
    def cache(self, cache: MatchupCache | None) -> None:
        """Swap or inject a cache after construction (e.g. after loading)."""
        self._cache = cache

    @property
    def is_ready(self) -> bool:
        """Return True when a populated cache is available."""
        return self._cache is not None and self._cache.size > 0

    def lookup(
        self, attacker_id: str, defender_id: str,
    ) -> Optional[MatchupSnapshot]:
        """Look up a cached matchup between two species.

        The IDs are Pokémon species IDs (e.g. "garchomp", "toxapex"),
        NOT set IDs.  The cache is built with composite (primary) sets
        at graph-build time.

        Returns None on cache miss — the caller should fall back to
        live damage calculation.
        """
        if self._cache is None:
            return None

        entry = self._cache.get(attacker_id, defender_id)
        if entry is None:
            return None

        return MatchupSnapshot(
            attacker_id=entry.attacker_id,
            defender_id=entry.defender_id,
            turns_to_kill=entry.turns_to_kill,
            best_move_id=entry.best_move_id,
            damage_per_hit=entry.damage_per_hit,
            min_damage=entry.min_damage,
            max_damage=entry.max_damage,
            min_ttk=entry.min_ttk,
            max_ttk=entry.max_ttk,
            damage_pct_lo=entry.damage_pct_lo,
            damage_pct_hi=entry.damage_pct_hi,
            type_effectiveness=entry.type_effectiveness,
            stab=entry.stab,
            move_type=entry.move_type,
            move_category=entry.move_category,
            offensive_stat=entry.offensive_stat,
            defensive_stat=entry.defensive_stat,
        )

    def lookup_best_move(
        self, attacker_id: str, defender_id: str,
    ) -> Optional[str]:
        """Convenience: return just the best move ID from cache."""
        snap = self.lookup(attacker_id, defender_id)
        return snap.best_move_id if snap else None

    def lookup_ttk(
        self, attacker_id: str, defender_id: str,
    ) -> Optional[int]:
        """Convenience: return just the TTK from cache."""
        snap = self.lookup(attacker_id, defender_id)
        return snap.turns_to_kill if snap else None

    def __len__(self) -> int:
        return self._cache.size if self._cache else 0

    def __repr__(self) -> str:
        ready = "ready" if self.is_ready else "empty"
        return f"CachedMatchupProvider({ready}, {len(self)} entries)"