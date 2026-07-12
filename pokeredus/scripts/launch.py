"""
launch.py — load the knowledge graph and launch the PokeRedus GUI.

Usage:
    python scripts/launch.py
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.gui.app import PokeRedusApp

GRAPH_PATH = PROJECT_ROOT / "data" / "graphs" / "ou_matchup_graph.json"


def main():
    if not GRAPH_PATH.exists():
        print(f"Graph not found at {GRAPH_PATH}")
        print("Run 'python scripts/build_graph.py' first.")
        sys.exit(1)

    print(f"Loading graph from {GRAPH_PATH}...")
    kg = KnowledgeGraph.load(GRAPH_PATH)
    print(kg.summary())

    print("Launching GUI...")
    app = PokeRedusApp(kg)
    app.mainloop()


if __name__ == "__main__":
    main()
