"""
ItemClass — a held item with optional single-use (consumed) flag.
"""

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class ItemClass:
    """A single held item (e.g. Leftovers, Choice Band, Sitrus Berry)."""

    id: str
    name: str
    description: str = ""
    consumed: bool = False  # True for one-time-use items like berries

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "consumed": self.consumed,
        }

    @classmethod
    def from_dict(cls, data: dict) -> ItemClass:
        return cls(
            id=data["id"],
            name=data["name"],
            description=data.get("description", ""),
            consumed=data.get("consumed", False),
        )

    def __repr__(self) -> str:
        return f"ItemClass({self.name!r})"
