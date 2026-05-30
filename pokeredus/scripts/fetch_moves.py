"""
fetch_moves.py — Download move data from Pokémon Showdown and save locally.

Usage:
    python scripts/fetch_moves.py

Reads the Showdown moves API and saves type, base power, category, accuracy,
priority, flags, and contact info for all moves to data/raw/moves.json.
"""

import sys
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import requests

OUTPUT_PATH = PROJECT_ROOT / "data" / "raw" / "moves.json"


def main():
    print("Fetching move data from Pokémon Showdown...")
    resp = requests.get("https://play.pokemonshowdown.com/data/moves.json", timeout=30)
    resp.raise_for_status()
    raw = resp.json()

    # Normalize into our format
    moves = {}
    for move_id, data in raw.items():
        if isinstance(data, str):
            continue  # skip alias strings
        moves[move_id] = {
            "name": data.get("name", move_id),
            "type": data.get("type", "Normal"),
            "category": data.get("category", "Status"),
            "basePower": data.get("basePower", 0),
            "accuracy": data.get("accuracy", 100) if data.get("accuracy") is not None else 0,
            "priority": data.get("priority", 0),
            "target": data.get("target", "normal"),
            "flags": list(data.get("flags", {}).keys()) if isinstance(data.get("flags"), dict) else [],
            "contact": "contact" in (data.get("flags", {}) if isinstance(data.get("flags"), dict) else {}),
        }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(moves, f, indent=2, ensure_ascii=False)

    print(f"  Saved {len(moves)} moves to {OUTPUT_PATH}")
    print(f"  File size: {OUTPUT_PATH.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
