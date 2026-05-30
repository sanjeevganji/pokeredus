"""
EVSpreadClass — a named EV (Effort Value) allocation for a Pokémon set.
"""

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class EVSpreadClass:
    """EV distribution across six stats with validation."""

    hp: int = 0
    atk: int = 0
    def_: int = 0       # 'def' is a Python builtin, use def_ internally
    spa: int = 0
    spd: int = 0
    spe: int = 0
    label: str = ""     # human-readable, e.g. "252 Atk / 4 SpD / 252 Spe"

    # ── stat access ─────────────────────────────────────────────────
    def get(self, stat: str) -> int:
        """Get EV value by standard stat key ('hp','atk','def','spa','spd','spe')."""
        if stat == "def":
            return self.def_
        return getattr(self, stat, 0)

    def as_dict(self) -> dict[str, int]:
        return {
            "hp": self.hp, "atk": self.atk, "def": self.def_,
            "spa": self.spa, "spd": self.spd, "spe": self.spe,
        }

    # ── validation ──────────────────────────────────────────────────
    def validate(self) -> list[str]:
        """Return a list of validation errors (empty = valid)."""
        errors: list[str] = []
        total = self.hp + self.atk + self.def_ + self.spa + self.spd + self.spe
        if total > 508:
            errors.append(f"Total EVs {total} exceeds 508")
        for name, val in self.as_dict().items():
            if val < 0:
                errors.append(f"{name} EVs cannot be negative ({val})")
            if val > 252:
                errors.append(f"{name} EVs exceeds 252 ({val})")
        return errors

    @property
    def is_valid(self) -> bool:
        return len(self.validate()) == 0

    @property
    def total(self) -> int:
        return self.hp + self.atk + self.def_ + self.spa + self.spd + self.spe

    # ── auto-label ──────────────────────────────────────────────────
    def _auto_label(self) -> str:
        _abbr = {"hp": "HP", "atk": "Atk", "def": "Def",
                 "spa": "SpA", "spd": "SpD", "spe": "Spe"}
        parts = []
        for stat, val in self.as_dict().items():
            if val > 0:
                parts.append(f"{val} {_abbr[stat]}")
        return " / ".join(parts) if parts else "0 EVs"

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "hp": self.hp, "atk": self.atk, "def": self.def_,
            "spa": self.spa, "spd": self.spd, "spe": self.spe,
            "label": self.label or self._auto_label(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> EVSpreadClass:
        return cls(
            hp=data.get("hp", 0),
            atk=data.get("atk", 0),
            def_=data.get("def", data.get("def_", 0)),
            spa=data.get("spa", 0),
            spd=data.get("spd", 0),
            spe=data.get("spe", 0),
            label=data.get("label", ""),
        )

    @classmethod
    def from_string(cls, text: str) -> EVSpreadClass:
        """Parse '252 Atk / 4 SpD / 252 Spe Jolly' style strings."""
        _reverse = {"HP": "hp", "Atk": "atk", "Def": "def_",
                    "SpA": "spa", "SpD": "spd", "Spe": "spe"}
        kwargs: dict = {"hp": 0, "atk": 0, "def_": 0, "spa": 0, "spd": 0, "spe": 0}
        parts = [p.strip() for p in text.replace(",", "/").split("/") if p.strip()]
        nature_name = None
        for part in parts:
            tokens = part.split()
            if len(tokens) >= 2:
                try:
                    val = int(tokens[0])
                except ValueError:
                    continue
                abbr = tokens[1]
                key = _reverse.get(abbr)
                if key:
                    kwargs[key] = val
            elif len(tokens) == 1 and not tokens[0].isdigit():
                nature_name = tokens[0]
        ev = cls(**kwargs, label=text.strip())
        return ev

    def __repr__(self) -> str:
        return f"EVSpreadClass({self.label or self._auto_label()!r})"
