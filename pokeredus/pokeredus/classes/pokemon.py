"""
PokemonClass — a Pokémon species with base stats, typing, and abilities.

Phase 5: Added classification fields (is_mega, is_paradox, is_legendary).
"""

from __future__ import annotations
from dataclasses import dataclass, field


# ── Classification constants ─────────────────────────────────────────
# Paradox Pokémon (Gen 9)
PARADOX_POKEMON: set[str] = {
    "great-tusk", "scream-tail", "brute-bonnet", "flutter-mane",
    "slither-wing", "sandy-shocks", "roaring-moon", "iron-valiant",
    "iron-hands", "iron-bundle", "iron-moth", "iron-thorns",
    "iron-jugulis", "iron-leaves", "iron-boulder", "iron-crown",
    "walking-wake", "gouging-fire", "raging-bolt",
    # Future paradoxes
    "iron-treads", "iron-bundle", "iron-moth", "iron-hands",
}

# Legendary + Mythical Pokémon commonly seen in competitive
LEGENDARY_POKEMON: set[str] = {
    # Legendary
    "articuno", "zapdos", "moltres", "mewtwo",
    "raikou", "entei", "suicune", "lugia", "ho-oh",
    "regirock", "regice", "registeel", "latias", "latios",
    "kyogre", "groudon", "rayquaza",
    "uxie", "mesprit", "azelf", "dialga", "palkia", "giratina",
    "heatran", "regigigas", "cresselia",
    "cobalion", "terrakion", "virizion", "tornadus", "thundurus",
    "landorus", "reshiram", "zekrom", "kyurem",
    "xerneas", "yveltal", "zygarde",
    "tapu-koko", "tapu-lele", "tapu-bulu", "tapu-fini",
    "cosmog", "cosmoem", "solgaleo", "lunala", "necrozma",
    "zacian", "zamazenta", "eternatus", "calyrex",
    "koraidon", "miraidon", "terapagos",
    # Mythical
    "mew", "celebi", "jirachi", "deoxys", "deoxys-speed",
    "deoxys-attack", "deoxys-defense",
    "darkrai", "shaymin", "arceus",
    "victini", "keldeo", "meloetta", "genesect",
    "diancie", "hoopa", "volcanion",
    "magearna", "marshadow", "zeraora",
    "meltan", "melmetal",
    "zarude", "enamorus", "enamorus-incarnate", "enamorus-therian",
    "pecharunt",
}

# Pseudo-legendary Pokémon
PSEUDO_LEGENDARY: set[str] = {
    "dragonite", "tyranitar", "salamence", "metagross",
    "garchomp", "hydreigon", "goodra", "goodra-hisui",
    "kommo-o", "dragapult", "baxcalibur",
}


@dataclass
class PokemonClass:
    """A single Pokémon species (e.g. Garchomp, Toxapex, Dragapult)."""

    id: str                             # lowercase slug, e.g. "garchomp"
    name: str                           # display name, e.g. "Garchomp"
    types: list[str] = field(default_factory=list)          # 1 or 2 type names
    base_stats: dict[str, int] = field(default_factory=dict) # hp/atk/def/spa/spd/spe
    abilities: list[str] = field(default_factory=list)       # ability IDs
    weight: float = 0.0
    tier: str = "OU"

    # Phase 5: Classification
    is_mega: bool = False
    is_paradox: bool = False
    is_legendary: bool = False  # legendary or mythical
    is_pseudo: bool = False     # pseudo-legendary

    # Sprite API name (for sprite lookup)
    api_name: str = ""

    # Primary competitive set ID
    primary_set_id: str = ""

    def __post_init__(self):
        if not self.api_name:
            self.api_name = self.id
        # Auto-classify if not set
        if not any([self.is_mega, self.is_paradox, self.is_legendary, self.is_pseudo]):
            if self.id in PARADOX_POKEMON:
                self.is_paradox = True
            if self.id in LEGENDARY_POKEMON:
                self.is_legendary = True
            if self.id in PSEUDO_LEGENDARY:
                self.is_pseudo = True
            if "-mega" in self.id:
                self.is_mega = True

    # ── stat helpers ────────────────────────────────────────────────
    def base_stat(self, stat: str) -> int:
        return self.base_stats.get(stat, 0)

    @property
    def bst(self) -> int:
        """Base Stat Total."""
        return sum(self.base_stats.values())

    @property
    def base_speed(self) -> int:
        return self.base_stats.get("spe", 0)

    # ── typing helpers ──────────────────────────────────────────────
    def has_type(self, type_name: str) -> bool:
        return type_name in self.types

    @property
    def type_string(self) -> str:
        return "/".join(self.types) if self.types else "???"

    # ── classification helpers ──────────────────────────────────────
    @property
    def classification(self) -> str:
        """Human-readable classification."""
        tags = []
        if self.is_mega:
            tags.append("Mega")
        if self.is_paradox:
            tags.append("Paradox")
        if self.is_legendary:
            tags.append("Legendary")
        if self.is_pseudo:
            tags.append("Pseudo")
        return " · ".join(tags) if tags else ""

    @property
    def has_classification(self) -> bool:
        return self.is_mega or self.is_paradox or self.is_legendary or self.is_pseudo

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "types": list(self.types),
            "base_stats": dict(self.base_stats),
            "abilities": list(self.abilities),
            "weight": self.weight,
            "tier": self.tier,
            "is_mega": self.is_mega,
            "is_paradox": self.is_paradox,
            "is_legendary": self.is_legendary,
            "is_pseudo": self.is_pseudo,
            "api_name": self.api_name,
            "primary_set_id": self.primary_set_id,
        }

    @classmethod
    def from_dict(cls, data: dict) -> PokemonClass:
        return cls(
            id=data["id"],
            name=data["name"],
            types=data.get("types", []),
            base_stats=data.get("base_stats", {}),
            abilities=data.get("abilities", []),
            weight=data.get("weight", 0.0),
            tier=data.get("tier", "OU"),
            is_mega=data.get("is_mega", False),
            is_paradox=data.get("is_paradox", False),
            is_legendary=data.get("is_legendary", False),
            is_pseudo=data.get("is_pseudo", False),
            api_name=data.get("api_name", ""),
            primary_set_id=data.get("primary_set_id", ""),
        )

    def __repr__(self) -> str:
        return f"PokemonClass({self.name!r}, {self.type_string}, BST={self.bst})"
