"""
fetch_base_stats.py — fetch base stats from PokeAPI for all Pokémon in gen9ou.json.

Saves to pokeredus/data/raw/base_stats.json.

Usage:
    python scripts/fetch_base_stats.py
"""

import json
import re
import sys
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"
SOURCE_FILE = Path(__file__).resolve().parent.parent.parent / "resources" / "gen9ou.json"
OUTPUT_FILE = DATA_DIR / "base_stats.json"

STAT_MAP = {
    "hp": "hp",
    "attack": "atk",
    "defense": "def",
    "special-attack": "spa",
    "special-defense": "spd",
    "speed": "spe",
}

TYPE_MAP = {}  # will be filled


def pokemon_name_to_api(name: str) -> str:
    """Convert display name to PokeAPI slug."""
    s = name.lower().strip()
    # Replace spaces with hyphens
    s = s.replace(" ", "-")
    # Remove apostrophes
    s = s.replace("'", "")
    # Already hyphenated forms like "Arcanine-Hisui" work as-is
    return s


def fetch_pokemon(name: str, session: requests.Session) -> dict | None:
    """Fetch a single Pokémon's data from PokeAPI."""
    slug = pokemon_name_to_api(name)
    url = f"https://pokeapi.co/api/v2/pokemon/{slug}"
    try:
        resp = session.get(url, timeout=15)
        if resp.status_code == 404:
            print(f"  404: {name} (slug: {slug})")
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"  Error fetching {name}: {e}")
        return None


def extract_stats(api_data: dict) -> dict[str, int]:
    """Extract base stats from PokeAPI response."""
    stats = {}
    for s in api_data["stats"]:
        key = STAT_MAP.get(s["stat"]["name"])
        if key:
            stats[key] = s["base_stat"]
    return stats


def extract_types(api_data: dict) -> list[str]:
    """Extract types from PokeAPI response."""
    return [t["type"]["name"].capitalize() for t in sorted(api_data["types"], key=lambda x: x["slot"])]


def extract_abilities(api_data: dict) -> list[str]:
    """Extract ability names from PokeAPI response."""
    return [a["ability"]["name"] for a in api_data["abilities"]]


def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    with open(SOURCE_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    # Collect all unique Pokémon names
    names = set()
    for source in ("dex", "stats"):
        names.update(data.get(source, {}).keys())

    print(f"Fetching base stats for {len(names)} Pokémon from PokeAPI...")

    session = requests.Session()
    results: dict[str, dict] = {}
    failed: list[str] = []

    for i, name in enumerate(sorted(names), 1):
        api_data = fetch_pokemon(name, session)
        if api_data:
            stats = extract_stats(api_data)
            types = extract_types(api_data)
            abilities = extract_abilities(api_data)
            weight = api_data.get("weight", 0) / 10.0  # hectograms → kg

            # Store by the display name (original case)
            results[name] = {
                "stats": stats,
                "types": types,
                "abilities": abilities,
                "weight": weight,
                "api_name": api_data["name"],
            }
            if i % 20 == 0:
                print(f"  {i}/{len(names)} done...")
        else:
            failed.append(name)

        # Rate limit: 100ms between requests
        time.sleep(0.1)

    # Save
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    print(f"\nSaved {len(results)} Pokémon to {OUTPUT_FILE}")
    if failed:
        print(f"Failed ({len(failed)}): {', '.join(failed)}")


if __name__ == "__main__":
    main()
