"""team_analysis_cache — Precomputed team analysis results with fingerprint invalidation.

Persists team radar scores, coverage, synergy, and vs-meta estimates
so the team builder panel avoids recomputing ``compute_radar_8`` +
``rank_sets`` on every team change.

Cache file: ``CACHE_DIR / "team_analysis_cache.json"``

Follows the same fingerprint pattern as ``MatchupCache`` so the cache
auto-invalidates when the KnowledgeGraph changes.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Callable

from pokeredus.config import CACHE_DIR


# ── Data model ────────────────────────────────────────────────────────────


@dataclass
class TeamAnalysisResult:
    """Precomputed analysis for one team composition.

    The team is identified by the **sorted** tuple of its 6 set IDs
    (empty slots → None) so the same 6 'mons always hit the same cache
    entry regardless of slot order.
    """

    # Composite scores (0..1)
    team_score: float = 0.0
    coverage: float = 0.0
    synergy: float = 0.0
    vs_meta: float = 0.0

    # 8-element radar scores (0..100)
    radar_scores: list[float] = field(default_factory=lambda: [0.0] * 8)

    # Type balance information
    type_text: str = ""

    # Set list text (one line per Pokemon)
    set_lines: list[str] = field(default_factory=list)


# ── Cache ─────────────────────────────────────────────────────────────────


class TeamAnalysisCache:
    """Persistent cache of team analysis results.

    Key design mirrors ``MatchupCache``:

    * ``_fingerprint`` — SHA-256 of the KG contents (Pokémon IDs, primary
      set IDs, set move lists, radar config hash).  Any change invalidates
      *all* entries.
    * ``_data`` — mapping from *team_key* (a hash of the sorted 6-set-ID
      tuple) to ``TeamAnalysisResult``.
    """

    CACHE_FILENAME = "team_analysis_cache.json"

    def __init__(self) -> None:
        self._data: dict[str, TeamAnalysisResult] = {}
        self._fingerprint: str = ""

    # ── public accessors ──────────────────────────────────────────────

    def get(self, set_ids: list[str | None]) -> TeamAnalysisResult | None:
        """Return cached result for a 6-element team, or *None*."""
        key = self._make_key(set_ids)
        return self._data.get(key)

    def put(self, set_ids: list[str | None], result: TeamAnalysisResult) -> None:
        """Store a result for the given team."""
        key = self._make_key(set_ids)
        self._data[key] = result

    # ── fingerprinting ──────────────────────────────────────────────

    @staticmethod
    def _compute_fingerprint(kg: "KnowledgeGraph") -> str:  # noqa: F821
        """Compute a hash fingerprint of the knowledge graph contents.

        Includes every Pokémon ID, primary set ID, set move list, and
        radar config hash (via ``radar_attributes``).
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

        # Radar config hash (if available)
        try:
            from pokeredus.graph.radar_attributes import get_radar_config

            cfg = get_radar_config()
            import json as _json

            h.update(json.dumps(asdict(cfg), sort_keys=True).encode())
        except Exception:
            pass

        return h.hexdigest()

    def is_valid(self, kg: "KnowledgeGraph") -> bool:  # noqa: F821
        """Return *True* if the cache fingerprint matches the current graph."""
        return self._fingerprint == self._compute_fingerprint(kg)

    def ensure_valid(self, kg: "KnowledgeGraph") -> None:  # noqa: F821
        """Recompute fingerprint and clear data if the graph has changed."""
        fp = self._compute_fingerprint(kg)
        if self._fingerprint != fp:
            self._fingerprint = fp
            self._data.clear()

    # ── persistence ──────────────────────────────────────────────────

    @property
    def _cache_path(self) -> Path:
        return CACHE_DIR / self.CACHE_FILENAME

    def save(self, path: Path | None = None) -> None:
        """Write the cache to disk as JSON."""
        out = {
            "fingerprint": self._fingerprint,
            "version": 1,
            "data": {
                key: asdict(result)
                for key, result in self._data.items()
            },
        }
        dest = path or self._cache_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "w") as f:
            json.dump(out, f, indent=2)

    def load(self, path: Path | None = None) -> None:
        """Load the cache from a JSON file on disk.

        Silently resets to empty if the file is missing or corrupt.
        """
        src = path or self._cache_path
        if not src.exists():
            return
        try:
            with open(src) as f:
                raw = json.load(f)
            if raw.get("version") != 1:
                return
            self._fingerprint = raw.get("fingerprint", "")
            self._data = {}
            for key, entry in raw.get("data", {}).items():
                self._data[key] = TeamAnalysisResult(
                    team_score=entry.get("team_score", 0.0),
                    coverage=entry.get("coverage", 0.0),
                    synergy=entry.get("synergy", 0.0),
                    vs_meta=entry.get("vs_meta", 0.0),
                    radar_scores=entry.get("radar_scores", [0.0] * 8),
                    type_text=entry.get("type_text", ""),
                    set_lines=entry.get("set_lines", []),
                )
        except (json.JSONDecodeError, KeyError, TypeError):
            self._data.clear()
            self._fingerprint = ""

    # ── internals ──────────────────────────────────────────────────

    @staticmethod
    def _make_key(set_ids: list[str | None]) -> str:
        """Deterministic key from sorted, non-None set IDs."""
        valid = sorted(s for s in set_ids if s is not None)
        return hashlib.sha256("|".join(valid).encode()).hexdigest()


# ── Convenience singleton accessor ────────────────────────────────────────

_GLOBAL_TEAM_ANALYSIS_CACHE: TeamAnalysisCache | None = None


def get_team_analysis_cache() -> TeamAnalysisCache:
    """Get or create the module-level singleton cache."""
    global _GLOBAL_TEAM_ANALYSIS_CACHE
    if _GLOBAL_TEAM_ANALYSIS_CACHE is None:
        _GLOBAL_TEAM_ANALYSIS_CACHE = TeamAnalysisCache()
        _GLOBAL_TEAM_ANALYSIS_CACHE.load()
    return _GLOBAL_TEAM_ANALYSIS_CACHE