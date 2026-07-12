"""
sync_obsidian_configs.py — Read parameters from Obsidian markdown files and
update PokeRedus code accordingly. Run manually or via Hermes cron.

This script enables living documentation: edit formulas/weights/thresholds in
Obsidian and have them reflected in the actual code.

Usage:
    python scripts/sync_obsidian_configs.py          # dry-run (print changes)
    python scripts/sync_obsidian_configs.py --apply  # commit changes

How matching works
------------------
Each PARAMS entry has:
  * md_regex    — extracts the TARGET value from the Obsidian markdown.
  * code_regex  — locates the CURRENT value inside the code file (the value is
                  captured in group 1). Only the captured substring is replaced,
                  so the rest of the file (including line endings) is preserved.

If the captured current value already equals the markdown target, the file is
left untouched ("OK (already)"). Only genuine differences are written. This
avoids the old bug where the search string was built from the new value, which
made the script unable to change an existing value and report no-op rewrites as
"changes".
"""

import re
import sys
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────
VAULT = Path("D:/PokeRedus/Hermes Memory")
PROJECT = Path("D:/PokeRedus/pokeredus")


# ── Parameter definitions ─────────────────────────────────────────────
# md_regex   : captures the target value from the Obsidian markdown (group 1).
# code_regex : locates the current value in code; group 1 is the value to swap.
PARAMS = [
    # ── config.py ────────────────────────────────────────────────────
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "MATCHUP_SCORING.md",
        "md_regex": r"Default \(TTK calc\) \| (\d+\.?\d*)",
        "code_file": PROJECT / "pokeredus" / "config.py",
        "code_regex": r"DEFAULT_MATCHUP_CONFIDENCE: float = (\d+\.?\d*)",
        "label": "config.py:DEFAULT_MATCHUP_CONFIDENCE",
    },
    # ── damage_calc.py modifier priorities ──────────────────────────
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "DAMAGE_FORMULAS.md",
        "md_regex": r"ChoiceBandModifier \| (\d+) \| Physical moves: Atk",
        "code_file": PROJECT / "pokeredus" / "graph" / "damage_calc.py",
        "code_regex": r"class ChoiceBandModifier\b.*?priority = (\d+)",
        "label": "damage_calc.py:ChoiceBand",
    },
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "DAMAGE_FORMULAS.md",
        "md_regex": r"ChoiceSpecsModifier \| (\d+) \| Special moves: SpA",
        "code_file": PROJECT / "pokeredus" / "graph" / "damage_calc.py",
        "code_regex": r"class ChoiceSpecsModifier\b.*?priority = (\d+)",
        "label": "damage_calc.py:ChoiceSpecs",
    },
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "DAMAGE_FORMULAS.md",
        "md_regex": r"LifeOrbModifier \| (\d+) \| All damage",
        "code_file": PROJECT / "pokeredus" / "graph" / "damage_calc.py",
        "code_regex": r"class LifeOrbModifier\b.*?priority = (\d+)",
        "label": "damage_calc.py:LifeOrb",
    },
    # ── matchup_graph.py SCU constants ──────────────────────────────
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "3D_MATCHUP_GRAPH.md",
        "md_regex": r"pivot_or_recovery_count / (\d+\.?\d*)",
        "code_file": PROJECT / "pokeredus" / "graph" / "matchup_graph.py",
        "code_regex": r"CONTROL_DENOMINATOR: float = (\d+\.?\d*)",
        "label": "matchup_graph.py:CONTROL_DENOMINATOR",
    },
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "3D_MATCHUP_GRAPH.md",
        "md_regex": r"utility = (\d+\.?\d*)\s*\*\s*has_hazard_setter",
        "code_file": PROJECT / "pokeredus" / "graph" / "matchup_graph.py",
        "code_regex": r"UTILITY_HAZARD_SETTER_WEIGHT: float = (\d+\.?\d*)",
        "label": "matchup_graph.py:UTILITY_HAZARD_SETTER_WEIGHT",
    },
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "3D_MATCHUP_GRAPH.md",
        "md_regex": r"has_hazard_setter \+ (\d+\.?\d*)\s*\*\s*has_hazard_remover",
        "code_file": PROJECT / "pokeredus" / "graph" / "matchup_graph.py",
        "code_regex": r"UTILITY_HAZARD_REMOVER_WEIGHT: float = (\d+\.?\d*)",
        "label": "matchup_graph.py:UTILITY_HAZARD_REMOVER_WEIGHT",
    },
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "3D_MATCHUP_GRAPH.md",
        "md_regex": r"has_hazard_remover \+ (\d+\.?\d*)\s*\*\s*has_field_setter",
        "code_file": PROJECT / "pokeredus" / "graph" / "matchup_graph.py",
        "code_regex": r"UTILITY_FIELD_SETTER_WEIGHT: float = (\d+\.?\d*)",
        "label": "matchup_graph.py:UTILITY_FIELD_SETTER_WEIGHT",
    },
    # ── matchup_engine.py scoring ──────────────────────────────────
    {
        "md": VAULT / "Project Knowledge" / "Formulas & Weights" / "MATCHUP_SCORING.md",
        "md_regex": r"tanh\(ttk_diff / (\d+\.?\d*)\)",
        "code_file": PROJECT / "pokeredus" / "graph" / "matchup_engine.py",
        "code_regex": r"math\.tanh\(ttk_diff / (\d+\.?\d*)\)",
        "label": "matchup_engine.py:ttk_diff",
    },
]


def extract_value(text: str, regex: str, label: str) -> str | None:
    """Extract a parameter value from markdown text (group 1)."""
    m = re.search(regex, text, re.IGNORECASE | re.DOTALL)
    if m:
        return m.group(1)
    return None


def main():
    apply = "--apply" in sys.argv
    changes = []

    for param in PARAMS:
        # Read markdown file
        try:
            md_text = param["md"].read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"⚠  SKIP (md not found): {param['md'].name}")
            continue

        # Extract target value from markdown
        val = extract_value(md_text, param["md_regex"], param["label"])
        if val is None:
            print(f"⚠  SKIP (no md match): {param['label']}")
            continue

        # Read code file
        try:
            code_text = param["code_file"].read_text(encoding="utf-8")
        except FileNotFoundError:
            print(f"⚠  SKIP (code not found): {param['code_file']}")
            continue

        # Locate the current value in code via the code-side regex
        m = re.search(param["code_regex"], code_text, re.DOTALL)
        if not m:
            print(f"⚠  SKIP (no code match): {param['label']}")
            continue

        current = m.group(1)
        if current == val:
            print(f"✓  OK (already {val}): {param['label']}")
            continue

        # Genuine difference -> build patched code (only swap the captured value)
        new_code = code_text[: m.start(1)] + val + code_text[m.end(1) :]
        changes.append((param["code_file"], code_text, new_code, param["label"], current, val))
        print(f"🔧  CHANGE: {param['label']} = {current} → {val}")

    # ── Apply changes ───────────────────────────────────────────────
    if apply:
        if not changes:
            print("\n✅  No changes to apply.")
            return
        print(f"\n📝  Applying {len(changes)} change(s)...")
        for code_file, old_text, new_text, label, current, val in changes:
            code_file.write_text(new_text, encoding="utf-8")
            print(f"  ✓ {label}: {current} → {val}")
        print("\n✅  All changes applied. Recommend: rebuild knowledge graph.")
    else:
        if changes:
            print(f"\n🧪  {len(changes)} change(s) pending. Run with --apply to commit.")
        else:
            print("\n✅  No changes pending. All parameters match code.")


if __name__ == "__main__":
    main()
