"""
MoveClass — a Pokémon move with type, power, accuracy, priority, and effects.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class MoveClass:
    """A single move (e.g. Earthquake, Flamethrower, Swords Dance)."""

    id: str
    name: str
    type: str                                      # "Fire", "Ground", etc.
    category: str                                  # "Physical", "Special", "Status"
    base_power: int = 0
    accuracy: int = 100                            # 0 = never misses (e.g. Aerial Ace)
    priority: int = 0                              # negative = slower, positive = faster
    pp: int = 10
    target: str = "normal"                         # "normal", "allAdjacentFoes", "self", etc.
    flags: list[str] = field(default_factory=list) # "contact", "protectable", "sound", etc.
    secondary_effects: list[dict] = field(default_factory=list)

    # ── helpers ─────────────────────────────────────────────────────
    @property
    def is_status(self) -> bool:
        return self.category == "Status"

    @property
    def is_physical(self) -> bool:
        return self.category == "Physical"

    @property
    def is_special(self) -> bool:
        return self.category == "Special"

    @property
    def is_contact(self) -> bool:
        return "contact" in self.flags

    @property
    def has_perfect_accuracy(self) -> bool:
        return self.accuracy == 0 or self.accuracy >= 100

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "type": self.type,
            "category": self.category,
            "base_power": self.base_power,
            "accuracy": self.accuracy,
            "priority": self.priority,
            "pp": self.pp,
            "target": self.target,
            "flags": list(self.flags),
            "secondary_effects": [dict(s) for s in self.secondary_effects],
        }

    @classmethod
    def from_dict(cls, data: dict) -> MoveClass:
        return cls(
            id=data["id"],
            name=data["name"],
            type=data["type"],
            category=data["category"],
            base_power=data.get("base_power", 0),
            accuracy=data.get("accuracy", 100),
            priority=data.get("priority", 0),
            pp=data.get("pp", 10),
            target=data.get("target", "normal"),
            flags=data.get("flags", []),
            secondary_effects=data.get("secondary_effects", []),
        )

    def __repr__(self) -> str:
        bp = f" {self.base_power}" if self.base_power else ""
        return f"MoveClass({self.name!r}, {self.type}{bp}, {self.category})"
