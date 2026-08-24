"""
launch.py — single entry point for the PokeRedus team-builder GUI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

GRAPH_PATH = PROJECT_ROOT / "data" / "graphs" / "ou_matchup_graph.json"
SETS_DIR = PROJECT_ROOT / "data" / "sets"
FINGERPRINT_PATH = PROJECT_ROOT / "data" / "cache" / "set_fingerprint.json"
BUILD_SCRIPT = PROJECT_ROOT / "scripts" / "build_graph.py"


def _fingerprint_sets() -> str:
    h = hashlib.sha256()
    if SETS_DIR.is_dir():
        for yml in sorted(SETS_DIR.rglob("*.yaml")):
            h.update(yml.read_bytes())
    return h.hexdigest()


def _load_fingerprint() -> str | None:
    if not FINGERPRINT_PATH.exists():
        return None
    try:
        return json.loads(FINGERPRINT_PATH.read_text(encoding="utf-8")).get("fp")
    except Exception:
        return None


def _save_fingerprint(fp: str) -> None:
    FINGERPRINT_PATH.parent.mkdir(parents=True, exist_ok=True)
    FINGERPRINT_PATH.write_text(json.dumps({"fp": fp}, indent=2), encoding="utf-8")


def graph_is_stale() -> bool:
    if not GRAPH_PATH.exists():
        return True
    return _fingerprint_sets() != _load_fingerprint()


def run_build_graph() -> bool:
    print(f"[build] running {BUILD_SCRIPT.name} ...")
    rc = subprocess.run(
        [sys.executable, str(BUILD_SCRIPT)],
        cwd=str(PROJECT_ROOT),
    ).returncode
    if rc == 0:
        _save_fingerprint(_fingerprint_sets())
    return rc == 0


def main() -> int:
    ap = argparse.ArgumentParser(description="PokeRedus team-builder launcher.")
    ap.add_argument("--no-build", action="store_true", help="Skip auto-build of the matchup graph.")
    args = ap.parse_args()

    if not args.no_build and graph_is_stale():
        print("[launch] graph missing or sets updated — rebuilding")
        if not run_build_graph():
            print("[launch] build failed; continuing with what's available")

    if not GRAPH_PATH.exists():
        print(f"[launch] no graph at {GRAPH_PATH}")
        return 1

    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.gui.app import PokeRedusApp

    print(f"[gui] loading graph {GRAPH_PATH.name} ...")
    kg = KnowledgeGraph.load(GRAPH_PATH)
    PokeRedusApp(kg).mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
