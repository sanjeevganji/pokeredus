"""
NatureClass — a Pokémon nature with +10% / -10% stat modifiers.
"""

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class NatureClass:
    """A single nature (e.g. Jolly, Adamant, Timid)."""

    name: str
    increased_stat: str | None = None   # "atk", "def", "spa", "spd", "spe"
    decreased_stat: str | None = None   # same, or None for neutral natures

    @property
    def id(self) -> str:
        return self.name.lower()

    @property
    def is_neutral(self) -> bool:
        return self.increased_stat is None and self.decreased_stat is None

    def modifier(self, stat: str) -> float:
        """Return 1.1, 0.9, or 1.0 for the given stat key."""
        if stat == self.increased_stat:
            return 1.1
        if stat == self.decreased_stat:
            return 0.9
        return 1.0

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "increased_stat": self.increased_stat,
            "decreased_stat": self.decreased_stat,
        }

    @classmethod
    def from_dict(cls, data: dict) -> NatureClass:
        return cls(
            name=data["name"],
            increased_stat=data.get("increased_stat"),
            decreased_stat=data.get("decreased_stat"),
        )

    def __repr__(self) -> str:
        if self.is_neutral:
            return f"NatureClass({self.name!r}, neutral)"
        return f"NatureClass({self.name!r}, +{self.increased_stat} -{self.decreased_stat})"


# ── All 25 natures ──────────────────────────────────────────────────
STANDARD_NATURES: list[NatureClass] = [
    NatureClass("Hardy"),
    NatureClass("Lonely",   "atk", "def"),
    NatureClass("Adamant",  "atk", "spa"),
    NatureClass("Naughty",  "atk", "spd"),
    NatureClass("Brave",    "atk", "spe"),
    NatureClass("Bold",     "def", "atk"),
    NatureClass("Docile"),
    NatureClass("Impish",   "def", "spa"),
    NatureClass("Lax",      "def", "spd"),
    NatureClass("Relaxed",  "def", "spe"),
    NatureClass("Modest",   "spa", "atk"),
    NatureClass("Mild",     "spa", "def"),
    NatureClass("Bashful"),
    NatureClass("Rash",     "spa", "spd"),
    NatureClass("Quiet",    "spa", "spe"),
    NatureClass("Calm",     "spd", "atk"),
    NatureClass("Gentle",   "spd", "def"),
    NatureClass("Careful",  "spd", "spa"),
    NatureClass("Quirky"),
    NatureClass("Sassy",    "spd", "spe"),
    NatureClass("Timid",    "spe", "atk"),
    NatureClass("Hasty",    "spe", "def"),
    NatureClass("Jolly",    "spe", "spa"),
    NatureClass("Naive",    "spe", "spd"),
    NatureClass("Serious"),
]
