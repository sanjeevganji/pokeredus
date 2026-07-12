"""
Species-level matchup cache for efficient MCTS scoring.

Design:
- Caches all matchups for a given pokemon as a single batch:
    {pokemon_id: [(opponent_id, MatchupScore), ...]}
- Hash tracks the set composition for both the pokemon and the entire species pool.
- Invalidates only the affected pokemon when sets change (via invalidate_pokemon).
- Caches both directions of a matchup from a single simulate() call to halve work.
- Uses the primary/star set for both attacker and defender in each matchup.

Performance:
- First access for a pokemon computes ~N matchups (N = total species).
- Subsequent accesses return cached data instantly.
- Invalidation only triggers recomputation for affected pokemon.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.graph.matchup_scorer import MatchupScorer, MatchupScore
    from pokeredus.graph.matchup_cache import MatchupCache


@dataclass
class CachedMatchupList:
    """All matchups for one pokemon against the species pool."""
    pokemon_id: str
    entries: list[tuple[str, 'MatchupScore']]  # (opponent_id, score)
    sets_hash: str  # hash of this pokemon's sets at computation time
    pool_hash: str  # hash of the entire species pool at computation time
    complete: bool = True  # False for partial "reverse-direction" entries


class SpeciesMatchupCache:
    """Batch cache: one entry per pokemon containing all its matchups.

    Typical usage:
        cache = SpeciesMatchupCache(kg, scorer)
        matchups = cache.get_all_matchups(pokemon_id)
        # Returns list of (opponent_id, MatchupScore) — cached or computed.

    When *matchup_cache* (MatchupCache) is provided, the cache delegates
    to precomputed species-level TTK/damage data instead of re-running
    the full BattleSimulator on every pair.  This dramatically reduces
    computation time for large rosters.
    """

    def __init__(
        self,
        kg: 'KnowledgeGraph',
        scorer: 'MatchupScorer',
        matchup_cache: 'MatchupCache | None' = None,
    ):
        self.kg = kg
        self.scorer = scorer
        self.matchup_cache = matchup_cache
        self._cache: dict[str, CachedMatchupList] = {}
        self._pool_hash: str | None = None

    # ── Hashing ────────────────────────────────────────────────────

    def _compute_pokemon_sets_hash(self, pokemon_id: str) -> str:
        """Hash all sets for a single pokemon."""
        sets = self.kg.get_sets(pokemon_id)
        if not sets:
            return ""
        parts = []
        for s in sorted(sets, key=lambda x: x.id):
            # Signature includes moves, item, ability, nature, evs, ivs
            parts.append(
                f"{s.id}|{','.join(sorted(s.moves))}|{s.item}|{s.ability}|"
                f"{getattr(s.nature, 'name', '')}|{s.evs}"
            )
        return "|".join(parts)

    def _compute_pool_hash(self) -> str:
        """Hash of every pokemon's set composition across the entire pool.

        Used to detect when an opponent's sets changed (requires invalidating
        pokemon whose cached opponents included that opponent).
        """
        if self._pool_hash is not None:
            return self._pool_hash
        parts = []
        for p in self.kg.get_all_pokemon():
            h = self._compute_pokemon_sets_hash(p.id)
            if h:
                parts.append(f"{p.id}:{h}")
        self._pool_hash = "|".join(sorted(parts))
        return self._pool_hash

    # ── Invalidation ───────────────────────────────────────────────

    def invalidate_pokemon(self, pokemon_id: str):
        """Invalidate cache entries involving this pokemon.

        Call when sets are added/removed/modified for a pokemon.
        """
        # Clear the affected pokemon's own cached list
        self._cache.pop(pokemon_id, None)
        # Clear all other pokemon that had this pokemon as an opponent
        # (their cached matchup against this pokemon is now stale)
        for entry_id in list(self._cache.keys()):
            cached_list = self._cache[entry_id]
            # Check if this cached list contains the invalidated pokemon
            if any(opp_id == pokemon_id for opp_id, _ in cached_list.entries):
                del self._cache[entry_id]
        # Pool hash is stale
        self._pool_hash = None

    def invalidate_all(self):
        """Clear entire cache."""
        self._cache.clear()
        self._pool_hash = None

    # ── Core access ────────────────────────────────────────────────

    def get_all_matchups(self, pokemon_id: str) -> list[tuple[str, 'MatchupScore']]:
        """Get all matchups for a pokemon against the species pool.

        Returns cached list if valid, otherwise computes and caches.
        """
        cached = self._cache.get(pokemon_id)

        # Validate cache freshness — but ONLY return if complete.
        # Partial "reverse-direction" entries (built as a side-effect of computing
        # another pokemon's matchups) must NOT short-circuit a full computation
        # for the same pokemon, otherwise the caller sees a 1-entry list.
        if cached is not None and cached.complete:
            own_hash = self._compute_pokemon_sets_hash(pokemon_id)
            pool_hash = self._compute_pool_hash()
            if cached.sets_hash == own_hash and cached.pool_hash == pool_hash:
                return cached.entries

        # Compute fresh (this also replaces any stale partial entry)
        return self._compute_all_matchups(pokemon_id)

    def get_matchup(
        self, our_pokemon_id: str, their_pokemon_id: str
    ) -> 'MatchupScore | None':
        """Get a single matchup (uses batch cache when available)."""
        all_m = self.get_all_matchups(our_pokemon_id)
        for opp_id, score in all_m:
            if opp_id == their_pokemon_id:
                return score
        return None

    def _compute_all_matchups(
        self, pokemon_id: str
    ) -> list[tuple[str, 'MatchupScore']]:
        """Compute all matchups for a pokemon and cache them.

        Also populates the reverse direction cache for opponents to avoid
        redundant computation later.

        When ``self.matchup_cache`` is available, the MatchupScorer's
        score_matchup() call will use the precomputed TTK data from the
        MatchupCache, avoiding repeated damage-formula evaluation.
        """
        own_hash = self._compute_pokemon_sets_hash(pokemon_id)
        pool_hash = self._compute_pool_hash()

        all_pokemon = self.kg.get_all_pokemon()
        entries: list[tuple[str, 'MatchupScore']] = []
        reverse_entries: dict[str, list[tuple[str, 'MatchupScore']]] = {}

        for opponent in all_pokemon:
            if opponent.id == pokemon_id:
                continue

            # Get star/primary sets for both sides
            our_set = self._get_primary_set(pokemon_id)
            their_set = self._get_primary_set(opponent.id)
            if not our_set or not their_set:
                continue

            # Single simulate() call produces both directions
            # (uses MatchupCache internally when available via scorer)
            result = self.scorer.score_matchup(our_set, their_set)
            entries.append((opponent.id, result))

            # Reverse direction score is the negation
            from pokeredus.graph.matchup_scorer import MatchupScore
            from pokeredus.graph.battle_simulator import SpeciesMatchupResult

            reverse_result = MatchupScore(
                score=-result.score,
                outcome=self._mirror_outcome(result.outcome),
                category=self._mirror_category(result.category),
                eval_text=result.eval_text,
            )

            if opponent.id not in reverse_entries:
                reverse_entries[opponent.id] = []
            reverse_entries[opponent.id].append((pokemon_id, reverse_result))

        # Store the primary pokemon's cache (always complete — we just computed it)
        self._cache[pokemon_id] = CachedMatchupList(
            pokemon_id=pokemon_id,
            entries=entries,
            sets_hash=own_hash,
            pool_hash=pool_hash,
            complete=True,
        )

        # Populate reverse-direction caches where the entry is missing
        for opp_id, opp_entries in reverse_entries.items():
            if opp_id not in self._cache:
                # Build partial cache (only contains matchup vs. our pokemon).
                # Marked complete=False so a later full-computation for opp_id
                # isn't short-circuited by this single-entry stub.
                # Other opponents will fill in the rest when they're queried
                opp_hash = self._compute_pokemon_sets_hash(opp_id)
                self._cache[opp_id] = CachedMatchupList(
                    pokemon_id=opp_id,
                    entries=opp_entries,
                    sets_hash=opp_hash,
                    pool_hash=pool_hash,
                    complete=False,
                )
            else:
                # Append if not already present (existing entry is treated as
                # authoritative and might already be complete)
                existing_ids = {eid for eid, _ in self._cache[opp_id].entries}
                for opp_entry in opp_entries:
                    if opp_entry[0] not in existing_ids:
                        self._cache[opp_id].entries.append(opp_entry)

        return entries

    def _get_primary_set(self, pokemon_id: str):
        """Get the primary/star set for a pokemon, or first available."""
        pokemon = self.kg.get_pokemon(pokemon_id)
        if not pokemon:
            return None
        sets = self.kg.get_sets(pokemon_id)
        if not sets:
            return None
        primary_id = getattr(pokemon, 'primary_set_id', None)
        if primary_id:
            primary = next((s for s in sets if s.id == primary_id), None)
            if primary:
                return primary
        return sets[0]

    @staticmethod
    def _mirror_outcome(outcome: 'SpeciesMatchupResult') -> 'SpeciesMatchupResult':
        """Swap attacker/defender fields in a matchup outcome."""
        from pokeredus.graph.battle_simulator import SpeciesMatchupResult
        return SpeciesMatchupResult(
            our_id=outcome.their_id,
            their_id=outcome.our_id,
            our_name=outcome.their_name,
            their_name=outcome.our_name,
            our_moves=outcome.their_moves,
            their_moves=outcome.our_moves,
            our_effective_ttk=outcome.their_effective_ttk,
            their_effective_ttk=outcome.our_effective_ttk,
            our_best_move=outcome.their_best_move,
            their_best_move=outcome.our_best_move,
            our_best_damage=outcome.their_best_damage,
            their_best_damage=outcome.our_best_damage,
            our_best_damage_max=outcome.their_best_damage_max,
            their_best_damage_max=outcome.our_best_damage_max,
            our_speed=outcome.their_speed,
            their_speed=outcome.our_speed,
            speed_advantage=(
                'us' if outcome.speed_advantage == 'them'
                else 'them' if outcome.speed_advantage == 'us'
                else 'tie'
            ),
            our_hp=outcome.their_hp,
            their_hp=outcome.our_hp,
            score=-outcome.score,
            category=SpeciesMatchupCache._mirror_category(outcome.category),
            eval_text=outcome.eval_text,
        )

    @staticmethod
    def _mirror_category(category: str) -> str:
        """Mirror a matchup category."""
        mirror_map = {
            'counter': 'countered_by',
            'countered_by': 'counter',
            'check': 'checked_by',
            'checked_by': 'check',
        }
        return mirror_map.get(category, category)

    # ── Diagnostics ────────────────────────────────────────────────

    def stats(self) -> dict:
        """Return cache statistics."""
        return {
            'cached_pokemon': len(self._cache),
            'total_entries': sum(len(c.entries) for c in self._cache.values()),
        }
