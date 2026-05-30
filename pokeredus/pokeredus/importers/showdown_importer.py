"""
showdown_importer — parse gen9ou.json and build the KnowledgeGraph.

Handles two data sources:
  - dex:   Smogon competitive analyses (multiple named sets per Pokémon)
  - stats: Showdown ladder usage stats (one "Showdown Usage" set per Pokémon)

Requires base_stats.json from fetch_base_stats.py for types, stats, abilities, weight.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass,
    NatureClass, EVSpreadClass,
)
from pokeredus.graph.knowledge_graph import KnowledgeGraph


# ── Normalization helpers ───────────────────────────────────────────

def _slug(name: str) -> str:
    """Convert a display name to a lowercase ID slug."""
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def _move_id(name: str) -> str:
    return _slug(name)


def _ability_id(name: str) -> str:
    return _slug(name)


def _item_id(name: str) -> str:
    return _slug(name)


def _nature_from_name(name: str) -> NatureClass:
    """Look up a NatureClass by name from the standard 25 natures."""
    from pokeredus.classes.natures import STANDARD_NATURES
    for n in STANDARD_NATURES:
        if n.name.lower() == name.lower():
            return n
    return NatureClass(name)


def _evs_from_dict(evs: dict[str, int]) -> EVSpreadClass:
    """Convert a stat dict like {"hp": 252, "atk": 4, ...} to EVSpreadClass."""
    return EVSpreadClass(
        hp=evs.get("hp", 0),
        atk=evs.get("atk", 0),
        def_=evs.get("def", 0),
        spa=evs.get("spa", 0),
        spd=evs.get("spd", 0),
        spe=evs.get("spe", 0),
    )


def _set_id(pokemon_name: str, set_name: str) -> str:
    return f"{_slug(pokemon_name)}_{_slug(set_name)}"


# ── Base stats + types lookup ───────────────────────────────────────

_BASE_DATA: dict[str, dict] = {}
_MOVE_DATA: dict[str, dict] = {}


def load_base_data(path: str | Path) -> int:
    """Load enriched base data (stats + types + abilities + weight) from JSON.

    Expected format:
    { "Pokemon Name": { "stats": {...}, "types": [...], "abilities": [...], "weight": N }, ... }
    """
    global _BASE_DATA
    with open(path, "r", encoding="utf-8") as f:
        _BASE_DATA = json.load(f)
    return len(_BASE_DATA)


def load_move_data(path: str | Path) -> int:
    """Load move data (type, base power, category, etc.) from JSON.

    Builds both original and normalized (no-hyphen) lookup indices
    so that 'dragon-darts' matches the Showdown key 'dragondarts'.
    """
    global _MOVE_DATA
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    # Build normalized index: both original keys and no-hyphen keys
    _MOVE_DATA = {}
    for key, val in raw.items():
        _MOVE_DATA[key] = val
        normalized = key.replace("-", "")
        if normalized != key:
            _MOVE_DATA[normalized] = val
    return len(raw)


def get_pokemon_data(pokemon_name: str) -> dict | None:
    """Look up full Pokémon data by display name."""
    # Exact match
    if pokemon_name in _BASE_DATA:
        return _BASE_DATA[pokemon_name]
    # Case-insensitive fallback
    lower = pokemon_name.lower()
    for key in _BASE_DATA:
        if key.lower() == lower:
            return _BASE_DATA[key]
    return None


# ── Main import function ────────────────────────────────────────────

def import_gen9ou(
    kg: KnowledgeGraph,
    json_path: str | Path,
    base_data_path: str | Path | None = None,
    move_data_path: str | Path | None = None,
) -> dict[str, int]:
    """Import gen9ou.json into the KnowledgeGraph.

    Args:
        kg: The KnowledgeGraph to populate.
        json_path: Path to gen9ou.json.
        base_data_path: Path to base_stats.json (enriched format).
        move_data_path: Path to moves.json (move type/BP/category data).

    Returns:
        Dict with counts: {"pokemon": N, "sets": N, "moves": N, "abilities": N, "items": N}
    """
    if base_data_path:
        n = load_base_data(base_data_path)
        print(f"  Loaded base data for {n} Pokémon")

    if move_data_path and Path(move_data_path).exists():
        n = load_move_data(move_data_path)
        print(f"  Loaded move data for {n} moves")

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    counts = {"pokemon": 0, "sets": 0, "moves": 0, "abilities": 0, "items": 0}
    seen_moves: set[str] = set()
    seen_abilities: set[str] = set()
    seen_items: set[str] = set()
    seen_pokemon: set[str] = set()

    # Process both sources
    for source_key in ("dex", "stats"):
        source = data.get(source_key, {})
        for pokemon_name, sets_dict in source.items():
            pokemon_id = _slug(pokemon_name)

            # Register Pokémon if first encounter
            if pokemon_id not in seen_pokemon:
                pdata = get_pokemon_data(pokemon_name)
                if pdata:
                    pokemon = PokemonClass(
                        id=pokemon_id,
                        name=pokemon_name,
                        types=pdata.get("types", []),
                        base_stats=pdata.get("stats", {}),
                        abilities=[_ability_id(a) for a in pdata.get("abilities", [])],
                        weight=pdata.get("weight", 0.0),
                        tier="OU",
                        api_name=pdata.get("api_name", pokemon_id),
                    )
                else:
                    # No base data — create minimal entry
                    pokemon = PokemonClass(
                        id=pokemon_id,
                        name=pokemon_name,
                        types=[],
                        base_stats={},
                        abilities=[],
                        tier="OU",
                    )
                    print(f"  WARNING: No base data for {pokemon_name}")

                kg.add_pokemon(pokemon)
                seen_pokemon.add(pokemon_id)
                counts["pokemon"] += 1

                # Register all abilities from base data (even if no set uses them)
                for ability_id in pokemon.abilities:
                    if ability_id not in seen_abilities:
                        ability = AbilityClass(
                            id=ability_id,
                            name=ability_id.replace("-", " ").title(),
                        )
                        kg.add_ability(ability)
                        seen_abilities.add(ability_id)
                        counts["abilities"] += 1

            # Process each set
            for set_name, set_data in sets_dict.items():
                set_obj = _parse_set(pokemon_id, set_name, set_data, source_key)
                if set_obj:
                    kg.add_set(set_obj)
                    counts["sets"] += 1

                    # Track unique moves
                    for mid in set_obj.moves:
                        if mid not in seen_moves:
                            # Look up real move data (try with and without hyphens)
                            mdata = _MOVE_DATA.get(mid) or _MOVE_DATA.get(mid.replace("-", ""), {})
                            move = MoveClass(
                                id=mid,
                                name=mdata.get("name", mid.replace("-", " ").title()),
                                type=mdata.get("type", ""),
                                category=mdata.get("category", "Physical"),
                                base_power=mdata.get("basePower", 0),
                                accuracy=mdata.get("accuracy", 100),
                                priority=mdata.get("priority", 0),
                                target=mdata.get("target", "normal"),
                                flags=mdata.get("flags", []),
                            )
                            move.flags = mdata.get("flags", [])
                            if mdata.get("contact"):
                                if "contact" not in move.flags:
                                    move.flags.append("contact")
                            kg.add_move(move)
                            seen_moves.add(mid)
                            counts["moves"] += 1

                    # Track unique abilities
                    aid = set_obj.ability
                    if aid not in seen_abilities:
                        ability = AbilityClass(
                            id=aid,
                            name=set_data.get("ability", aid),
                        )
                        kg.add_ability(ability)
                        seen_abilities.add(aid)
                        counts["abilities"] += 1

                    # Track unique items
                    iid = set_obj.item
                    if iid not in seen_items:
                        item = ItemClass(
                            id=iid,
                            name=set_data.get("item", iid),
                        )
                        kg.add_item(item)
                        seen_items.add(iid)
                        counts["items"] += 1

    return counts


def _parse_set(
    pokemon_id: str,
    set_name: str,
    set_data: dict[str, Any],
    source: str,
) -> SetClass | None:
    """Parse a single set dict into a SetClass."""
    moves_raw = set_data.get("moves", [])
    if not moves_raw or len(moves_raw) < 1:
        return None

    ability_name = set_data.get("ability", "")
    item_name = set_data.get("item", "")
    nature_name = set_data.get("nature", "Hardy")
    tera_type = set_data.get("teraType", "")
    evs_raw = set_data.get("evs", {})

    set_id = _set_id(pokemon_id, set_name)

    return SetClass(
        id=set_id,
        pokemon_id=pokemon_id,
        set_name=set_name,
        ability=_ability_id(ability_name),
        item=_item_id(item_name),
        nature=_nature_from_name(nature_name),
        evs=_evs_from_dict(evs_raw),
        moves=[_move_id(m) for m in moves_raw[:4]],
        role=_infer_role(set_name, set_data),
        tera_type=tera_type,
    )


def _infer_role(set_name: str, set_data: dict[str, Any]) -> str:
    """Infer a role tag from the set name and moves."""
    name_lower = set_name.lower()
    moves_lower = [m.lower() for m in set_data.get("moves", [])]

    if any(kw in name_lower for kw in ["sweeper", "offense", "mixed", "sun "]):
        return "sweeper"
    if any(kw in name_lower for kw in ["wall", "defensive", "physdef", "spdef", "unaware"]):
        return "wall"
    if any(kw in name_lower for kw in ["pivot", "utility"]):
        return "defensive_pivot"
    if "choice scarf" in name_lower:
        return "revenge_killer"
    if any(kw in name_lower for kw in ["choice band", "choice specs", "wallbreak"]):
        return "wallbreaker"
    if any(kw in name_lower for kw in ["calm mind", "swords dance", "nasty plot", "dragon dance", "setup", "bulk up"]):
        return "setup_sweeper"
    if any(kw in name_lower for kw in ["hazard", "stealth rock", "spikes"]):
        return "hazard_setter"
    if "showdown usage" in name_lower:
        if any(m in moves_lower for m in ["stealth rock", "spikes", "toxic spikes"]):
            return "hazard_setter"
        if any(m in moves_lower for m in ["calm mind", "swords dance", "nasty plot"]):
            return "setup_sweeper"
        return "pivot"

    return "pivot"
