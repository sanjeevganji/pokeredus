"""Download all OU Pokemon sprites from the gen-9-sprites repo."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.config import GRAPHS_DIR
from pokeredus.gui.sprites import get_sprite_manager


def main():
    graph_path = GRAPHS_DIR / "ou_matchup_graph.json"
    if not graph_path.exists():
        print(f"Graph not found at {graph_path}")
        print("Run build_graph.py first.")
        return

    print("Loading graph...")
    kg = KnowledgeGraph.load(graph_path)
    print(f"  {kg.pokemon_count} Pokemon, {kg.set_count} sets")

    api_names = []
    for p in kg.get_all_pokemon():
        api = p.api_name or p.id
        api_names.append(api)

    print(f"Downloading {len(api_names)} sprites...")
    mgr = get_sprite_manager()

    # Download synchronously for CLI use
    downloaded = 0
    failed = 0
    for name in sorted(api_names):
        try:
            if mgr._download_sprite(name):
                downloaded += 1
                print(f"  OK: {name}")
            else:
                failed += 1
                print(f"  FAIL: {name}")
        except Exception as e:
            failed += 1
            print(f"  ERROR: {name} - {e}")

    print(f"\nDone: {downloaded} downloaded, {failed} failed, {mgr.cache_count()} total cached")


if __name__ == "__main__":
    main()
