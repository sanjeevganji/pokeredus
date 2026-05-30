"""
PokeRedus classes — dataclass definitions for the knowledge graph.

Import order matters: later modules depend on earlier ones.
"""

from pokeredus.classes.types import TypeClass, TYPE_CHART, POKEMON_TYPES, get_effectiveness, get_best_effectiveness
from pokeredus.classes.moves import MoveClass
from pokeredus.classes.abilities import AbilityClass
from pokeredus.classes.items import ItemClass
from pokeredus.classes.natures import NatureClass, STANDARD_NATURES
from pokeredus.classes.ev_spread import EVSpreadClass
from pokeredus.classes.pokemon import PokemonClass
from pokeredus.classes.sets import SetClass
from pokeredus.classes.matchup import MatchupRelation

__all__ = [
    "TypeClass", "TYPE_CHART", "POKEMON_TYPES",
    "get_effectiveness", "get_best_effectiveness",
    "MoveClass", "AbilityClass", "ItemClass",
    "NatureClass", "STANDARD_NATURES",
    "EVSpreadClass", "PokemonClass", "SetClass",
    "MatchupRelation",
]
