"""
export_knowledge_pack.py — emit the portable PokeRedus "Knowledge Pack" JSON
consumed by the TypeScript packages (knowledge graph / matchup edges).

The pack is a single immutable artifact:
    version, generated_at, types (18x18 chart), species, moves,
    abilities, items, sets (every set), edges (primary-set matchups).

Edges are the portable matchup seed for the TypeScript KG. They are computed
here once (it is fast — the TTK
scorer runs in ~0.1ms/pair, so the full 118-species primary set matrix of
~13.8k ordered pairs finishes in ~1s) and shipped as data. We deliberately do
NOT load the 86MB cached matchup graph for this: recomputation is cheaper than
deserializing the whole graph, and the exporter reuses the existing
``compute_matchup`` / ``get_calculator`` APIs — zero new domain logic.

Usage:
    python scripts/export_knowledge_pack.py                 # full pack
    python scripts/export_knowledge_pack.py --mini          # 5 species (fixture)
    python scripts/export_knowledge_pack.py --out path.json --mini

Output: data/knowledge-pack/knowledge-pack-v1.json (full) or
        data/knowledge-pack/knowledge-pack-mini.json (--mini)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent  # .../pokeredus
REPO = ROOT.parent                              # .../PokeRedus
sys.path.insert(0, str(ROOT))

from pokeredus.graph import KnowledgeGraph
from pokeredus.importers.showdown_importer import import_gen9ou
from pokeredus.graph.matchup_engine import compute_matchup
from pokeredus.classes.types import TYPE_CHART

DATA = ROOT / "data"
GEN9OU = REPO / "resources" / "gen9ou.json"
BASE_STATS = DATA / "raw" / "base_stats.json"
MOVES = DATA / "raw" / "moves.json"
EFFECTS_ABILITY = DATA / "effects" / "abilities.json"
EFFECTS_ITEM = DATA / "effects" / "items.json"
OUT_DIR = DATA / "knowledge-pack"

PACK_VERSION = 1


# ──────────────────────────────────────────────────────────────────────
# KG construction (reuses the existing importer — no new logic)
# ──────────────────────────────────────────────────────────────────────
def build_kg() -> KnowledgeGraph:
    kg = KnowledgeGraph()
    if not GEN9OU.exists():
        raise FileNotFoundError(f"gen9ou.json not found at {GEN9OU}")
    import_gen9ou(
        kg,
        json_path=GEN9OU,
        base_data_path=BASE_STATS if BASE_STATS.exists() else None,
        move_data_path=MOVES if MOVES.exists() else None,
    )
    return kg


def primary_set(kg: KnowledgeGraph, pokemon_id: str):
    """Pick the 'primary' competitive set for a species.

    The codebase does not populate ``primary_set_id`` automatically, so we
    define a deterministic primary: the 'Showdown Usage' stats-set when
    present, otherwise the first set encountered. One set per species →
    the 118x118 (ordered) matchup matrix the engine consumes.
    """
    sets = kg.get_sets(pokemon_id)
    if not sets:
        return None
    for s in sets:
        if "showdown usage" in s.set_name.lower():
            return s
    return sets[0]


# ──────────────────────────────────────────────────────────────────────
# Effect enrichment (abilities/items descriptions + flags)
# ──────────────────────────────────────────────────────────────────────
def _load_effects(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def collect_abilities(kg: KnowledgeGraph, effects: dict[str, dict]) -> list[dict]:
    ability_block = effects.get("abilities", {})
    out: list[dict] = []
    seen: set[str] = set()
    for nid, ndata in kg.graph.nodes(data=True):
        if ndata.get("node_type") != "ability":
            continue
        d = dict(ndata.get("data", {}))
        aid = d.get("id")
        if aid is None or aid in seen:
            continue
        seen.add(aid)
        eff = ability_block.get(aid, {})
        flags = d.get("flags") or list(eff.get("tags", []))
        out.append({
            "id": aid,
            "name": d.get("name", aid),
            "description": d.get("description") or eff.get("name") or "",
            "flags": flags,
        })
    return out


def collect_items(kg: KnowledgeGraph, effects: dict[str, dict]) -> list[dict]:
    item_block = effects.get("items", {})
    out: list[dict] = []
    seen: set[str] = set()
    for nid, ndata in kg.graph.nodes(data=True):
        if ndata.get("node_type") != "item":
            continue
        d = dict(ndata.get("data", {}))
        iid = d.get("id")
        if iid is None or iid in seen:
            continue
        seen.add(iid)
        eff = item_block.get(iid, {})
        params = eff.get("params", {})
        consumed = bool(
            params.get("consumed")
            or "berry" in eff.get("tags", [])
            or "consumed" in eff.get("tags", [])
        )
        out.append({
            "id": iid,
            "name": d.get("name", iid),
            "description": d.get("description") or eff.get("name") or "",
            "consumed": d.get("consumed", consumed),
        })
    return out


# ──────────────────────────────────────────────────────────────────────
# Pack assembly
# ──────────────────────────────────────────────────────────────────────
def build_pack(kg: KnowledgeGraph, max_species: int | None = None) -> dict[str, Any]:
    pokemon = kg.get_all_pokemon()
    if max_species is not None:
        pokemon = pokemon[:max_species]
    pids = {p.id for p in pokemon}

    # Species + sets limited to the chosen species.
    species = [p.to_dict() for p in pokemon]
    sets = [s.to_dict() for p in pokemon for s in kg.get_sets(p.id)]
    moves = [m.to_dict() for m in kg.get_all_moves()]
    effects_ability = _load_effects(EFFECTS_ABILITY)
    effects_item = _load_effects(EFFECTS_ITEM)
    abilities = collect_abilities(kg, effects_ability)
    items = collect_items(kg, effects_item)

    # Type chart (18x18 offense lookup) — taken verbatim from classes.types.
    types: dict[str, dict[str, float]] = {
        atk: {def_: float(mult) for def_, mult in against.items()}
        for atk, against in TYPE_CHART.items()
    }

    # Edges: one MatchupRelation per ordered (primary a, primary b) pair.
    primaries = [(pid, primary_set(kg, pid)) for pid in pids]
    primaries = [(pid, s) for pid, s in primaries if s is not None]
    edges: list[dict] = []
    for _, a in primaries:
        for _, b in primaries:
            if a is b:
                continue
            mr = compute_matchup(a, b, kg)
            edges.append({
                "a_set_id": mr.set_a_id,
                "b_set_id": mr.set_b_id,
                "score": round(mr.score, 4),
                "best_move_a_id": mr.best_move_a_id,
                "ttk_a": mr.turns_to_kill_a,
                "ttk_b": mr.turns_to_kill_b,
                "dmg_pct_lo": round(mr.damage_pct_a_to_b_lo, 2),
                "dmg_pct_hi": round(mr.damage_pct_a_to_b_hi, 2),
            })

    return {
        "version": PACK_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "types": types,
        "species": species,
        "moves": moves,
        "abilities": abilities,
        "items": items,
        "sets": sets,
        "edges": edges,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=None, help="Output JSON path")
    parser.add_argument("--mini", action="store_true",
                        help="Export only the first 5 species (+ their sets/edges)")
    parser.add_argument("--max-species", type=int, default=None,
                        help="Cap species count (debugging)")
    args = parser.parse_args()

    t0 = time.time()
    kg = build_kg()
    print(f"[pack] built KG: {kg.pokemon_count} Pokémon, {kg.set_count} sets, "
          f"{kg.move_count} moves")

    max_species = 5 if args.mini else args.max_species
    if args.out:
        out_path = args.out
    else:
        out_path = OUT_DIR / ("knowledge-pack-mini.json" if (args.mini or max_species)
                              else f"knowledge-pack-v{PACK_VERSION}.json")

    pack = build_pack(kg, max_species=max_species)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(pack, f, ensure_ascii=False, separators=(",", ":"))

    size = out_path.stat().st_size
    print(f"[pack] wrote {out_path.name}")
    print(f"  species={len(pack['species'])} sets={len(pack['sets'])} "
          f"moves={len(pack['moves'])} abilities={len(pack['abilities'])} "
          f"items={len(pack['items'])} edges={len(pack['edges'])}")
    print(f"  size={size/1024/1024:.2f} MB  ({time.time()-t0:.1f}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
