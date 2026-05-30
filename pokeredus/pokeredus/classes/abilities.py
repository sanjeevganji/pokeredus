"""
AbilityClass — a Pokémon ability with effect description and trigger flags.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class AbilityClass:
    """A single ability (e.g. Intimidate, Rough Skin, Magic Guard)."""

    id: str
    name: str
    description: str = ""
    flags: list[str] = field(default_factory=list)
    # flags examples: "on_switch_in", "persistent", "on_contact", "weather", "terrain"

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "flags": list(self.flags),
        }

    @classmethod
    def from_dict(cls, data: dict) -> AbilityClass:
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            flags=data.get("flags", []),
        )

    def __repr__(self) -> str:
        return f"AbilityClass({self.name!r})"
