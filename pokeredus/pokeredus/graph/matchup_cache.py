"""
MatchupCache — precomputed pairwise Pokémon matchup results.

Caches the best_move result for every (attacker, defender) pair so that
downstream consumers (analytics, GUI panels, query functions) can look up
matchups in O(1) without re-running the damage calculator.

Usage:
    from pokeredus.graph.matchup_cache import MatchupCache

    cache = MatchupCache.load_or_build(kg)
    entry = cache.get("garchomp", "toxapex")
    print(entry.turns_to_kill, entry.best_move_id)

Cache files are stored as JSON at CACHE_DIR / "matchup_cache.json".
A fingerprint of the knowledge graph is embedded so stale caches are
automatically invalidated when sets or Pokémon change.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from pokeredus.config import CACHE_DIR

if TYPE_CHECKING:
    from pokeredus.graph.damage_calc import DamageCalculator, DamageResult
    from pokeredus.graph.knowledge_graph import KnowledgeGraph


# ── CachedMatchup dataclass ─────────────────────────────────────────

@dataclass
class CachedMatchup:
    """A single precomputed matchup from attacker → defender.

    Stores the best-move result and supporting stats so callers never
    need to re-run the damage calculator.
    """

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
    move_category: str
    offensive_stat: int
    defensive_stat: int

    # ── serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "attacker_id": self.attacker_id,
            "defender_id": self.defender_id,
            "turns_to_kill": self.turns_to_kill,
            "best_move_id": self.best_move_id,
            "damage_per_hit": self.damage_per_hit,
            "min_damage": self.min_damage,
            "max_damage": self.max_damage,
            "min_ttk": self.min_ttk,
            "max_ttk": self.max_ttk,
            "damage_pct_lo": round(self.damage_pct_lo, 2),
            "damage_pct_hi": round(self.damage_pct_hi, 2),
            "type_effectiveness": self.type_effectiveness,
            "stab": self.stab,
            "move_type": self.move_type,
            "move_category": self.move_category,
            "offensive_stat": self.offensive_stat,
            "defensive_stat": self.defensive_stat,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> CachedMatchup:
        return cls(
            attacker_id=data["attacker_id"],
            defender_id=data["defender_id"],
            turns_to_kill=data["turns_to_kill"],
            best_move_id=data["best_move_id"],
            damage_per_hit=data["damage_per_hit"],
            min_damage=data["min_damage"],
            max_damage=data["max_damage"],
            min_ttk=data["min_ttk"],
            max_ttk=data["max_ttk"],
            damage_pct_lo=data["damage_pct_lo"],
            damage_pct_hi=data["damage_pct_hi"],
            type_effectiveness=data["type_effectiveness"],
            stab=data["stab"],
            move_type=data["move_type"],
            move_category=data["move_category"],
            offensive_stat=data["offensive_stat"],
            defensive_stat=data["defensive_stat"],
        )

    def __repr__(self) -> str:
        return (
            f"CachedMatchup({self.attacker_id} → {self.defender_id}: "
            f"{self.turns_to_kill}HKO via {self.best_move_id})"
        )


# ── MatchupCache class ──────────────────────────────────────────────

class MatchupCache:
    """In-memory store of precomputed pairwise matchups.

    Keyed by (attacker_id, defender_id) tuples.  Supports building the
    full cache from a KnowledgeGraph, serialisation to/from JSON, and
    fingerprint-based invalidation.
    """

    def __init__(self) -> None:
        self._cache: dict[tuple[str, str], CachedMatchup] = {}
        self._fingerprint: str = ""

    # ── accessors ───────────────────────────────────────────────────

    def get(self, attacker_id: str, defender_id: str) -> CachedMatchup | None:
        """Look up a single matchup.  Returns None if absent."""
        return self._cache.get((attacker_id, defender_id))

    def put(self, matchup: CachedMatchup) -> None:
        """Insert or overwrite a matchup entry."""
        self._cache[(matchup.attacker_id, matchup.defender_id)] = matchup

    def get_all_against(self, defender_id: str) -> list[CachedMatchup]:
        """Return every matchup where *defender_id* is being attacked."""
        return [
            m for (_, d), m in self._cache.items() if d == defender_id
        ]

    def get_all_by(self, attacker_id: str) -> list[CachedMatchup]:
        """Return every matchup where *attacker_id* is the attacker."""
        return [
            m for (a, _), m in self._cache.items() if a == attacker_id
        ]

    @property
    def size(self) -> int:
        """Number of cached matchup entries."""
        return len(self._cache)

    # ── fingerprinting ──────────────────────────────────────────────

    @staticmethod
    def _compute_fingerprint(kg: KnowledgeGraph) -> str:
        """Compute a hash fingerprint of the knowledge graph contents.

        The fingerprint covers Pokémon IDs, their primary_set_ids, and
        the move lists of every set.  If *any* of these change the
        fingerprint will differ, signalling a stale cache.
        """
        h = hashlib.sha256()

        # Pokémon ids + primary_set_ids (sorted for determinism)
        for p in sorted(kg.get_all_pokemon(), key=lambda p: p.id):
            h.update(p.id.encode())
            h.update((p.primary_set_id or "").encode())

        # Set move lists
        for s in sorted(kg.get_all_sets(), key=lambda s: s.id):
            h.update(s.id.encode())
            for move_id in s.moves:
                h.update(move_id.encode())

        return h.hexdigest()

    def is_valid(self, kg: KnowledgeGraph) -> bool:
        """Return True if the cache fingerprint matches the current graph."""
        return self._fingerprint == self._compute_fingerprint(kg)

    # ── build ───────────────────────────────────────────────────────

    def build(
        self,
        kg: KnowledgeGraph,
        calc: DamageCalculator | None = None,
        progress_cb: Callable[[int, int], None] | None = None,
    ) -> int:
        """Compute matchups for every ordered Pokémon pair.

        Parameters
        ----------
        kg : KnowledgeGraph
            The knowledge graph to build from.
        calc : DamageCalculator, optional
            A pre-configured calculator.  If *None*, the module-level
            default (with registered modifiers) is used.
        progress_cb : callable, optional
            ``progress_cb(done, total)`` called after each pair.

        Returns
        -------
        int
            Number of matchup entries stored.
        """
        from pokeredus.graph.damage_calc import get_calculator

        if calc is None:
            calc = get_calculator()

        # Collect Pokémon that have at least one set
        all_pokemon = kg.get_all_pokemon()
        pokemon_with_sets = [
            p for p in all_pokemon if kg.get_sets(p.id)
        ]

        total = len(pokemon_with_sets) * len(pokemon_with_sets)
        done = 0

        self._cache.clear()

        for atk_pokemon in pokemon_with_sets:
            atk_set = kg.build_composite_set(atk_pokemon.id)
            if atk_set is None:
                done += len(pokemon_with_sets)
                if progress_cb:
                    progress_cb(done, total)
                continue

            for def_pokemon in pokemon_with_sets:
                done += 1

                # Skip self-matchup
                if atk_pokemon.id == def_pokemon.id:
                    if progress_cb:
                        progress_cb(done, total)
                    continue

                def_set = kg.build_composite_set(def_pokemon.id)
                if def_set is None:
                    if progress_cb:
                        progress_cb(done, total)
                    continue

                result = calc.best_move(atk_set, def_set, kg)
                if result is None:
                    if progress_cb:
                        progress_cb(done, total)
                    continue

                entry = CachedMatchup(
                    attacker_id=atk_pokemon.id,
                    defender_id=def_pokemon.id,
                    turns_to_kill=result.turns_to_kill,
                    best_move_id=result.move_id,
                    damage_per_hit=result.final_damage,
                    min_damage=result.min_damage,
                    max_damage=result.max_damage,
                    min_ttk=result.min_turns_to_kill,
                    max_ttk=result.max_turns_to_kill,
                    damage_pct_lo=result.min_damage_percent,
                    damage_pct_hi=result.max_damage_percent,
                    type_effectiveness=result.type_effectiveness,
                    stab=result.stab_mult,
                    move_type=result.move_type,
                    move_category=result.move_category,
                    offensive_stat=result.offensive_stat,
                    defensive_stat=result.defensive_stat,
                )
                self.put(entry)

                if progress_cb:
                    progress_cb(done, total)

        self._fingerprint = self._compute_fingerprint(kg)
        return self.size

    # ── persistence ─────────────────────────────────────────────────

    def save(self, path: Path | str | None = None) -> Path:
        """Save the cache to a JSON file.

        Parameters
        ----------
        path : Path or str, optional
            Destination file.  Defaults to ``CACHE_DIR / "matchup_cache.json"``.
        """
        if path is None:
            path = CACHE_DIR / "matchup_cache.json"
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        payload = {
            "fingerprint": self._fingerprint,
            "matchups": [m.to_dict() for m in self._cache.values()],
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

        return path

    @classmethod
    def load(cls, path: Path | str | None = None) -> MatchupCache:
        """Load a cache from a JSON file.

        Parameters
        ----------
        path : Path or str, optional
            Source file.  Defaults to ``CACHE_DIR / "matchup_cache.json"``.

        Raises
        ------
        FileNotFoundError
            If the cache file does not exist.
        """
        if path is None:
            path = CACHE_DIR / "matchup_cache.json"
        path = Path(path)

        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)

        cache = cls()
        cache._fingerprint = payload.get("fingerprint", "")
        for entry in payload.get("matchups", []):
            m = CachedMatchup.from_dict(entry)
            cache._cache[(m.attacker_id, m.defender_id)] = m

        return cache

    @classmethod
    def get_cache_path(cls, path: Path | str | None = None) -> Path:
        """Return the resolved cache file path."""
        if path is None:
            path = CACHE_DIR / "matchup_cache.json"
        return Path(path)

    @classmethod
    def get_cache_file_size(cls, path: Path | str | None = None) -> int:
        """Return the cache file size in bytes, or 0 if it doesn't exist."""
        p = cls.get_cache_path(path)
        return p.stat().st_size if p.exists() else 0

    @classmethod
    def format_cache_file_size(cls, path: Path | str | None = None) -> str:
        """Return a human-readable cache file size like '12.4 MB'."""
        size = cls.get_cache_file_size(path)
        if size <= 0:
            return "N/A"
        if size < 1024:
            return f"{size} B"
        elif size < 1024 * 1024:
            return f"{size / 1024:.1f} KB"
        else:
            return f"{size / (1024 * 1024):.1f} MB"

    @classmethod
    def load_or_build(
        cls,
        kg: KnowledgeGraph,
        path: Path | str | None = None,
        force: bool = False,
        progress_cb: Callable[[int, int], None] | None = None,
    ) -> MatchupCache:
        """Load from disk if valid, otherwise build and save.

        Parameters
        ----------
        kg : KnowledgeGraph
            The knowledge graph.
        path : Path or str, optional
            Cache file path.  Defaults to ``CACHE_DIR / "matchup_cache.json"``.
        force : bool
            If True, always rebuild even if the on-disk cache is valid.
        progress_cb : callable, optional
            ``progress_cb(done, total)`` passed to :meth:`build` when a
            fresh cache is needed.

        Returns
        -------
        MatchupCache
        """
        resolved = cls.get_cache_path(path)

        # Try loading existing cache
        if not force and resolved.exists():
            try:
                cache = cls.load(resolved)
                if cache.is_valid(kg):
                    return cache
            except (json.JSONDecodeError, KeyError):
                pass  # corrupt file — rebuild

        # Build fresh
        cache = cls()
        cache.build(kg, progress_cb=progress_cb)
        cache.save(resolved)
        return cache

    # ── dunder helpers ──────────────────────────────────────────────

    def __len__(self) -> int:
        return self.size

    def __contains__(self, key: tuple[str, str]) -> bool:
        return key in self._cache

    def __repr__(self) -> str:
        return f"MatchupCache({self.size} entries, fp={self._fingerprint[:12]}…)"
