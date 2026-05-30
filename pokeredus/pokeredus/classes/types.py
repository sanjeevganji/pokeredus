"""
TypeClass — one of the 18 Pokémon types with effectiveness multipliers.

The full 18x18 type chart is defined here as TYPE_CHART and can be
queried with get_effectiveness() and get_best_effectiveness().
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class TypeClass:
    """A Pokémon type (e.g. Fire, Water) and its offensive effectiveness."""

    name: str
    effectiveness: dict[str, float] = field(default_factory=dict)

    # ── identity ────────────────────────────────────────────────────
    @property
    def id(self) -> str:
        return self.name.lower()

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {"name": self.name, "effectiveness": dict(self.effectiveness)}

    @classmethod
    def from_dict(cls, data: dict) -> TypeClass:
        return cls(name=data["name"], effectiveness=data.get("effectiveness", {}))

    def __repr__(self) -> str:
        return f"TypeClass({self.name!r})"


# ── Full 18×18 type effectiveness chart ────────────────────────────
# Multipliers: 0 = immune, 0.5 = not very effective, 1 = neutral, 2 = super effective
# Only super-effective (2) and immunities (0) are listed; everything else defaults to 1.
_OFFENSE: dict[str, dict[str, float]] = {
    "Normal":   {"Rock": 0.5, "Ghost": 0, "Steel": 0.5},
    "Fire":     {"Fire": 0.5, "Water": 0.5, "Grass": 2, "Ice": 2, "Bug": 2, "Rock": 0.5, "Dragon": 0.5, "Steel": 2},
    "Water":    {"Fire": 2, "Water": 0.5, "Grass": 0.5, "Ground": 2, "Rock": 2, "Dragon": 0.5},
    "Electric": {"Water": 2, "Electric": 0.5, "Grass": 0.5, "Ground": 0, "Flying": 2, "Dragon": 0.5},
    "Grass":    {"Fire": 0.5, "Water": 2, "Grass": 0.5, "Poison": 0.5, "Ground": 2, "Flying": 0.5, "Bug": 0.5, "Rock": 2, "Dragon": 0.5, "Steel": 0.5},
    "Ice":      {"Fire": 0.5, "Water": 0.5, "Grass": 2, "Ice": 0.5, "Ground": 2, "Flying": 2, "Dragon": 2, "Steel": 0.5},
    "Fighting": {"Normal": 2, "Ice": 2, "Poison": 0.5, "Flying": 0.5, "Psychic": 0.5, "Bug": 0.5, "Rock": 2, "Ghost": 0, "Dark": 2, "Steel": 2, "Fairy": 0.5},
    "Poison":   {"Grass": 2, "Poison": 0.5, "Ground": 0.5, "Rock": 0.5, "Ghost": 0.5, "Steel": 0, "Fairy": 2},
    "Ground":   {"Fire": 2, "Electric": 2, "Grass": 0.5, "Poison": 2, "Flying": 0, "Bug": 0.5, "Rock": 2, "Steel": 2},
    "Flying":   {"Electric": 0.5, "Grass": 2, "Fighting": 2, "Bug": 2, "Rock": 0.5, "Steel": 0.5},
    "Psychic":  {"Fighting": 2, "Poison": 2, "Psychic": 0.5, "Dark": 0, "Steel": 0.5},
    "Bug":      {"Fire": 0.5, "Grass": 2, "Fighting": 0.5, "Poison": 0.5, "Flying": 0.5, "Psychic": 2, "Ghost": 0.5, "Dark": 2, "Steel": 0.5, "Fairy": 0.5},
    "Rock":     {"Fire": 2, "Ice": 2, "Fighting": 0.5, "Ground": 0.5, "Flying": 2, "Bug": 2, "Steel": 0.5},
    "Ghost":    {"Normal": 0, "Psychic": 2, "Ghost": 2, "Dark": 0.5},
    "Dragon":   {"Dragon": 2, "Steel": 0.5, "Fairy": 0},
    "Dark":     {"Fighting": 0.5, "Psychic": 2, "Ghost": 2, "Dark": 0.5, "Fairy": 0.5},
    "Steel":    {"Fire": 0.5, "Water": 0.5, "Electric": 0.5, "Ice": 2, "Rock": 2, "Steel": 0.5, "Fairy": 2},
    "Fairy":    {"Fire": 0.5, "Fighting": 2, "Poison": 0.5, "Dragon": 2, "Dark": 2, "Steel": 0.5},
}

POKEMON_TYPES: list[str] = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
    "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]


def _build_chart() -> dict[str, dict[str, float]]:
    """Build the full 18×18 chart, defaulting unspecified matchups to 1.0."""
    chart: dict[str, dict[str, float]] = {}
    for atk in POKEMON_TYPES:
        chart[atk] = {}
        for dfn in POKEMON_TYPES:
            chart[atk][dfn] = _OFFENSE.get(atk, {}).get(dfn, 1.0)
    return chart


TYPE_CHART: dict[str, dict[str, float]] = _build_chart()


def get_effectiveness(attacking_type: str, defending_types: list[str]) -> float:
    """Return the combined damage multiplier for *attacking_type* vs one or two defending types."""
    mult = 1.0
    for dt in defending_types:
        mult *= TYPE_CHART.get(attacking_type, {}).get(dt, 1.0)
    return mult


def get_best_effectiveness(
    attacker_types: list[str], defender_types: list[str]
) -> tuple[str, float]:
    """Return (best_attacking_type, best_multiplier) for the attacker vs the defender."""
    best_type = attacker_types[0]
    best_mult = 0.0
    for at in attacker_types:
        m = get_effectiveness(at, defender_types)
        if m > best_mult:
            best_mult = m
            best_type = at
    return best_type, best_mult
