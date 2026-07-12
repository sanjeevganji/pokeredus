"""
scripts/export_training_data.py

CLI to export a training corpus from any combination of:
  * Saved teams (from data/teams/*.json)
  * The PokeRedus matchup cache (precomputed pairwise matchups)
  * A specific set of attack/defend scenarios provided as JSON

The output is a JSONL file where each line is a TrainingSample — the
plain-text scene is the model's input, the action text is the target.
Use this to bootstrap a supervised dataset before letting an RL agent
self-play: the AI queries that drive the matchup graph already encode
excellent scoring, so we mine them for a "warm-start" policy.

Usage:
    python scripts/export_training_data.py --output data/training/gen9ou_v1.jsonl
    python scripts/export_training_data.py --teams team1,team2 --output corpus.jsonl
    python scripts/export_training_data.py --demo --output demo.jsonl   # small synthetic run
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pokeredus.unified import (
    UnifiedState, UnifiedTeamSlot, recommend_actions,
    export_training_corpus, render_scene,
)
from pokeredus.config import TEAMS_DIR
from pokeredus.graph.matchup_graph import (
    pick_best_move, find_optimal_switch,
)
from pokeredus.graph.game_state import PokemonState
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.gui.team_store import TeamStore


def _load_kg() -> KnowledgeGraph:
    """Load the knowledge graph from the OU cache on disk."""
    graph_path = PROJECT_ROOT / "data" / "graphs" / "ou_matchup_graph.json"
    if not graph_path.exists():
        raise FileNotFoundError(
            f"Matchup graph not found at {graph_path}. Run scripts/build_graph.py first."
        )
    return KnowledgeGraph.load_or_build(graph_path)


def _team_sets_from_record(record, kg) -> list:
    """Resolve saved team record to list of Set instances."""
    sets = []
    for sid in record.sets:
        s = kg.get_set(sid)
        if s is not None:
            sets.append(s)
    return sets


def export_from_saved_teams(kg, output_path: Path, max_teams: int = 50) -> int:
    """For each saved team, generate (team vs team) scenes + actions."""
    import datetime as _dt
    store = TeamStore()
    teams_dir_actual = PROJECT_ROOT / "data" / "teams"
    store_root = teams_dir_actual if teams_dir_actual.exists() else TEAMS_DIR
    store._teams_dir = store_root
    records = list(store.list_all())

    if not records:
        print(f"[export] No saved teams found in {store_root}")
        return 0

    records = records[:max_teams]
    print(f"[export] Found {len(records)} team(s); generating scenes…")

    # Build a "common opponents" pool: take 6 sets from the first team
    # and use them as the right side for everyone. This stabilises
    # signal in training: every team sees the same opponents.
    opp_pool: list = []
    if records:
        opp_pool = _team_sets_from_record(records[0], kg)

    scenes: list[tuple[UnifiedState, list]] = []
    for rec in records:
        my_sets = _team_sets_from_record(rec, kg)
        if not my_sets:
            continue
        # Generate scenes vs each opponent in the pool
        for opp_set in opp_pool[:6]:
            # team_a: my team; team_b: one opponent
            team_a = []
            for i, s in enumerate(my_sets[:6]):
                ps = PokemonState(pokemon_id=s.pokemon_id, set_id=s.id,
                                  current_hp=300, max_hp=300)
                team_a.append(UnifiedTeamSlot(i, s.pokemon_id, s.id, ps))
            team_b = [UnifiedTeamSlot(
                0, opp_set.pokemon_id, opp_set.id,
                PokemonState(pokemon_id=opp_set.pokemon_id, set_id=opp_set.id,
                             current_hp=260, max_hp=260),
            )]
            for side_to_move in ("a", "b"):
                unified = UnifiedState(
                    team_a=team_a, team_b=team_b,
                    active_a=0, active_b=0,
                    turn=1, side_to_move=side_to_move,
                )
                actions = recommend_actions(unified, kg)
                if actions:
                    scenes.append((unified, actions))

    n = export_training_corpus(scenes, kg, output_path, mode="compact")
    print(f"[export] Wrote {n} sample(s) to {output_path}")
    return n


def demo_export(kg, output_path: Path) -> int:
    """Tiny self-contained export (no saved teams needed) — 1 scene, ≥1 action."""
    # Take any two sets from the graph
    sets = []
    for p in kg.get_all_pokemon()[:5]:
        s = kg.get_primary_set(p.id) or (kg.get_sets(p.id) or [None])[0]
        if s is not None:
            sets.append(s)
        if len(sets) >= 2:
            break
    if len(sets) < 2:
        print("[demo] Not enough sets in KG")
        return 0

    me, opp = sets[0], sets[1]
    team_a = [UnifiedTeamSlot(
        0, me.pokemon_id, me.id,
        PokemonState(pokemon_id=me.pokemon_id, set_id=me.id, current_hp=250, max_hp=250),
    )]
    team_b = [UnifiedTeamSlot(
        0, opp.pokemon_id, opp.id,
        PokemonState(pokemon_id=opp.pokemon_id, set_id=opp.id, current_hp=250, max_hp=250),
    )]
    unified = UnifiedState(
        team_a=team_a, team_b=team_b, active_a=0, active_b=0,
        turn=1, side_to_move="a",
    )
    actions = recommend_actions(unified, kg)
    print(f"[demo] scene rendered as:\n{render_scene(unified, kg, 'compact').text}")
    n = export_training_corpus([(unified, actions)], kg, output_path, mode="compact")
    print(f"[demo] Wrote {n} sample(s) to {output_path}")
    return n


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path, default=PROJECT_ROOT / "data" / "training" / "export.jsonl",
        help="Output JSONL path",
    )
    parser.add_argument(
        "--teams", type=int, default=0,
        help="Number of saved teams to include (0 = use --demo)",
    )
    parser.add_argument(
        "--max-per-team", type=int, default=50,
        help="Maximum scenes per team (cap to limit corpus size)",
    )
    parser.add_argument(
        "--demo", action="store_true",
        help="Write a tiny demo scene (1 sample) instead of full corpus",
    )
    args = parser.parse_args(argv)

    print("[export] loading knowledge graph…")
    kg = _load_kg()
    print(f"[export]   pokemon={kg.pokemon_count}, sets={kg.set_count}")

    args.output.parent.mkdir(parents=True, exist_ok=True)

    if args.demo or args.teams == 0:
        n = demo_export(kg, args.output)
    else:
        n = export_from_saved_teams(kg, args.output, max_teams=args.teams)

    print(f"[export] done. {n} training sample(s) → {args.output}")
    return 0 if n > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
