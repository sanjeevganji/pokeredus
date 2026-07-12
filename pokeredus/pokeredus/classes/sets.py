"""
SetClass — a competitive Pokémon set (species + moves + item + ability + nature + EVs + role).

This is the primary unit of intelligence in PokeRedus.
All matchup scoring, team building, and graph queries operate at the Set level.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from pokeredus.classes.natures import NatureClass
from pokeredus.classes.ev_spread import EVSpreadClass
from pokeredus.config import DEFAULT_IV, STAT_NAMES


@dataclass
class SetClass:
    """A single competitive set for a Pokémon species."""

    id: str                         # auto-generated: "{pokemon_id}_{set_name_slug}"
    pokemon_id: str                 # references PokemonClass.id
    set_name: str                   # e.g. "Swords Dance", "Choice Scarf"
    ability: str                    # ability ID
    item: str                       # item ID
    nature: NatureClass             # NatureClass instance
    evs: EVSpreadClass              # EVSpreadClass instance
    moves: list[str] = field(default_factory=list)   # up to 4 move IDs
    ivs: dict[str, int] = field(default_factory=dict) # defaults to 31
    role: str = ""                  # "sweeper", "wall", "pivot", etc.
    tera_type: str = ""             # Gen 9 Tera type
    cumulative_score: float = 0.0   # Calculated via dynamic_engine during build

    def __post_init__(self) -> None:
        # Fill in default IVs (31) for any missing stats
        for stat in STAT_NAMES:
            if stat not in self.ivs:
                self.ivs[stat] = DEFAULT_IV
        # Auto-generate ID if not provided
        if not self.id:
            slug = self.set_name.lower().replace(" ", "_").replace("+", "plus")
            self.id = f"{self.pokemon_id}_{slug}"

    # ── move helpers ────────────────────────────────────────────────
    @property
    def move_count(self) -> int:
        return len(self.moves)

    @property
    def has_full_moveset(self) -> bool:
        return len(self.moves) == 4

    # ── stat calculation (simplified, no level/NatureClass math yet) ─
    def effective_stat(self, stat: str, base_stats: dict[str, int], level: int = 50) -> int:
        """Compute the final stat value given base stats, EVs, IVs, and nature.

        Uses the standard Pokémon stat formula:
          HP:     ((2*base + iv + ev//4) * level / 100) + level + 10
          Others: (((2*base + iv + ev//4) * level / 100) + 5) * nature_mod
        """
        base = base_stats.get(stat, 0)
        iv = self.ivs.get(stat, 31)
        ev = self.evs.get(stat)
        nature_mod = self.nature.modifier(stat)

        if stat == "hp":
            return int(((2 * base + iv + ev // 4) * level / 100) + level + 10)
        else:
            return int((((2 * base + iv + ev // 4) * level / 100) + 5) * nature_mod)

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "pokemon_id": self.pokemon_id,
            "set_name": self.set_name,
            "ability": self.ability,
            "item": self.item,
            "nature": self.nature.to_dict(),
            "evs": self.evs.to_dict(),
            "moves": list(self.moves),
            "ivs": dict(self.ivs),
            "role": self.role,
            "tera_type": self.tera_type,
        }

    @classmethod
    def from_dict(cls, data: dict) -> SetClass:
        return cls(
            id=data.get("id", ""),
            pokemon_id=data["pokemon_id"],
            set_name=data["set_name"],
            ability=data["ability"],
            item=data["item"],
            nature=NatureClass.from_dict(data["nature"]),
            evs=EVSpreadClass.from_dict(data["evs"]),
            moves=data.get("moves", []),
            ivs=data.get("ivs", {}),
            role=data.get("role", ""),
            tera_type=data.get("tera_type", ""),
        )

    def __repr__(self) -> str:
        return (
            f"SetClass({self.pokemon_id!r}, {self.set_name!r}, "
            f"{self.item}, {self.nature.name}, role={self.role!r})"
        )
