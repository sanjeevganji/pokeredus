"""
build_graph.py — CLI entry point to import data and compute matchups.

Usage:
    python scripts/build_graph.py

Reads:
    - resources/gen9ou.json          (sets data)
    - data/raw/base_stats.json       (Pokémon base stats, types, abilities)
    - data/graphs/ou_matchup_graph.json (existing graph, if any)

Writes:
    - data/graphs/ou_matchup_graph.json (full serialized graph)
    - data/sets/{pokemon_id}/{set_name}.yaml (individual set files)
"""

import sys
from pathlib import Path

# Ensure project root is on path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pokeredus.graph import KnowledgeGraph, compute_all_matchups
from pokeredus.importers.showdown_importer import import_gen9ou

RESOURCES_DIR = PROJECT_ROOT.parent / "resources"
DATA_DIR = PROJECT_ROOT / "data"
GRAPHS_DIR = DATA_DIR / "graphs"
SETS_DIR = DATA_DIR / "sets"
RAW_DIR = DATA_DIR / "raw"

GEN9OU_JSON = RESOURCES_DIR / "gen9ou.json"
BASE_STATS_JSON = RAW_DIR / "base_stats.json"
MOVES_JSON = RAW_DIR / "moves.json"
OUTPUT_GRAPH = GRAPHS_DIR / "ou_matchup_graph.json"


def main():
    print("=" * 60)
    print("PokeRedus — Build OU Knowledge Graph")
    print("=" * 60)

    # ── Step 1: Import data ─────────────────────────────────────────
    print("\n[1/4] Importing Pokémon and sets...")
    kg = KnowledgeGraph()

    if not GEN9OU_JSON.exists():
        print(f"  ERROR: {GEN9OU_JSON} not found")
        sys.exit(1)

    counts = import_gen9ou(
        kg,
        json_path=GEN9OU_JSON,
        base_data_path=BASE_STATS_JSON if BASE_STATS_JSON.exists() else None,
        move_data_path=MOVES_JSON if MOVES_JSON.exists() else None,
    )
    print(f"  Imported: {counts['pokemon']} Pokémon, {counts['sets']} sets, "
          f"{counts['moves']} moves, {counts['abilities']} abilities, {counts['items']} items")

    # ── Step 2: Compute matchups ────────────────────────────────────
    print("\n[2/4] Computing pairwise matchups...")
    matchup_count = compute_all_matchups(kg)
    print(f"  Computed {matchup_count} matchup edges")

    # ── Step 3: Save graph ──────────────────────────────────────────
    print(f"\n[3/4] Saving graph to {OUTPUT_GRAPH}...")
    GRAPHS_DIR.mkdir(parents=True, exist_ok=True)
    kg.save(OUTPUT_GRAPH)
    print(f"  Saved: {OUTPUT_GRAPH.stat().st_size:,} bytes")

    # ── Step 4: Save individual sets ────────────────────────────────
    print(f"\n[4/4] Saving individual set YAML files...")
    saved = 0
    for s in kg.get_all_sets():
        kg.save_set_yaml(s, SETS_DIR)
        saved += 1
    print(f"  Saved {saved} set files to {SETS_DIR}")

    # ── Summary ─────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print(kg.summary())
    print("=" * 60)

    # ── Quick validation ────────────────────────────────────────────
    print("\nSample data:")
    for p in kg.get_all_pokemon()[:5]:
        sets = kg.get_sets(p.id)
        print(f"  {p.name} ({p.type_string}) — {len(sets)} set(s), BST={p.bst}")
        for s in sets:
            matchups = kg.get_matchups(s.id, min_confidence=0.3)
            favorable = sum(1 for m in matchups if m.score > 0.2)
            unfavorable = sum(1 for m in matchups if m.score < -0.2)
            print(f"    [{s.role}] {s.set_name}: {s.item}, {s.nature.name} — "
                  f"{favorable} favorable, {unfavorable} unfavorable matchups")


if __name__ == "__main__":
    main()
