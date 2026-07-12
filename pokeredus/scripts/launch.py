"""
launch.py — single entry point for PokeRedus.

Purpose
-------
PokeRedus is a GUI front-end whose only job is to produce and consume
canonical plain-text game states for an MCTS-based bot intelligence.

This script is the *only* way to start the application. It:

    1. Auto-builds the matchup graph if it is missing or stale.
    2. (Optional) Runs the test suite to guarantee the build is sound.
    3. Launches the Unified sidebar shell with the optimal-action panel.

Unified is the default and only canonical shell — there is nothing else.
A `--legacy` escape hatch preserves the previous title-screen app for
back-compat with screenshots/scripts that still reference it.

Usage
-----
    python scripts/launch.py                 # default: build/test/unified
    python scripts/launch.py --no-build      # skip auto-build
    python scripts/launch.py --no-tests      # skip test suite
    python scripts/launch.py --legacy        # launch the legacy shell
    python scripts/launch.py --tests-only    # build + tests, no GUI
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

# ── Path constants ──────────────────────────────────────────────────
GRAPH_PATH = PROJECT_ROOT / "data" / "graphs" / "ou_matchup_graph.json"
RESOURCES_DIR = PROJECT_ROOT.parent / "resources"
SETS_DIR = PROJECT_ROOT / "data" / "sets"
FINGERPRINT_PATH = PROJECT_ROOT / "data" / "cache" / "set_fingerprint.json"
BUILD_SCRIPT = PROJECT_ROOT / "scripts" / "build_graph.py"
TEST_SCRIPT = PROJECT_ROOT / "tests" / "test_unified_integration.py"


# ═══════════════════════════════════════════════════════════════════════
# Graph build + fingerprint
# ═══════════════════════════════════════════════════════════════════════


def _fingerprint_sets() -> str:
    """SHA256 of every set YAML so any change invalidates the graph."""
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
    FINGERPRINT_PATH.write_text(
        json.dumps({"fp": fp}, indent=2), encoding="utf-8"
    )


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


# ═══════════════════════════════════════════════════════════════════════
# Test harness
# ═══════════════════════════════════════════════════════════════════════


def run_tests() -> bool:
    """Run the unified-integration integration test. Returns True on pass.

    We deliberately run only ``test_unified_integration.py`` — it exercises
    the public surface end-to-end without loading the 89MB matchup graph.
    """
    if not TEST_SCRIPT.exists():
        print(f"[test] skip: {TEST_SCRIPT} not found")
        return True
    print(f"[test] running {TEST_SCRIPT.name} ...")
    # The test computes PACKAGE_ROOT = tests/.. / .. => pokeredus/. We run
    # the script from PROJECT_ROOT so ``pokeredus/`` is importable as a
    # package without any sys.path fiddling.
    rc = subprocess.run(
        [sys.executable, str(TEST_SCRIPT)],
        cwd=str(PROJECT_ROOT),
    ).returncode
    if rc == 0:
        print("[test] OK")
    else:
        print(f"[test] FAILED (exit {rc})")
    return rc == 0


# ═══════════════════════════════════════════════════════════════════════
# GUI launch
# ═══════════════════════════════════════════════════════════════════════


def _launch_unified() -> None:
    """Boot the canonical unified sidebar shell."""
    import tkinter as tk

    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.gui.unified_app import UnifiedAppShell

    print(f"[gui] loading graph {GRAPH_PATH.name} ...")
    kg = KnowledgeGraph.load(GRAPH_PATH)
    print(kg.summary())

    root = tk.Tk()
    root.title("PokeRedus — Unified Shell")
    root.geometry("1280x820")
    shell = UnifiedAppShell(root, kg=kg, matchup_cache=None)
    shell.pack(fill="both", expand=True)
    shell.show("pokemon")
    root.mainloop()


def _launch_legacy() -> None:
    """Escape hatch: original title-screen app. Kept for back-compat."""
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.gui.app import PokeRedusApp

    print(f"[gui] loading graph {GRAPH_PATH.name} (legacy shell) ...")
    kg = KnowledgeGraph.load(GRAPH_PATH)
    PokeRedusApp(kg).mainloop()


# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════


def main() -> int:
    ap = argparse.ArgumentParser(description="PokeRedus launcher.")
    ap.add_argument("--no-build", action="store_true",
                    help="Skip auto-build of the matchup graph.")
    ap.add_argument("--no-tests", action="store_true",
                    help="Skip the integration test suite.")
    ap.add_argument("--tests-only", action="store_true",
                    help="Run build + tests, then exit without launching the GUI.")
    ap.add_argument("--legacy", action="store_true",
                    help="Launch the old title-screen shell (NOT recommended).")
    args = ap.parse_args()

    # 1. Ensure the graph exists and is fresh.
    if not args.no_build and graph_is_stale():
        print("[launch] graph missing or sets updated — rebuilding")
        if not run_build_graph():
            print("[launch] build failed; continuing with what's available")

    if not GRAPH_PATH.exists():
        print(f"[launch] no graph at {GRAPH_PATH}")
        print("        re-run without --no-build (or run scripts/build_graph.py)")
        return 1

    # 2. Run sanity checks.
    if not args.no_tests and not run_tests():
        print("[launch] tests failed — aborting GUI launch")
        return 2

    if args.tests_only:
        return 0

    # 3. Launch the GUI.
    if args.legacy:
        _launch_legacy()
    else:
        _launch_unified()
    return 0


if __name__ == "__main__":
    sys.exit(main())
