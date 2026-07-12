# Matchup Graph Page Revamp — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Revamp the matchup-graph page in `pokeredus/gui/matchup_graph_view.py`:
1. Collapse the per-set list to one row per Pokémon that expands on click.
2. Add sort modes: alphabetical, best-volume asc, best-volume desc.
3. Make the 2D/3D polygonal-solid model **tunable** (axis weights + per-compound multipliers + move-role tags) and **polynomially scaled to 0-100**.

**Architecture:**
- New pure-math module `pokeredus/graph/attribute_engine.py` that wraps `matchup_graph.compute_base_attributes` + `compute_compound_attributes` with: (a) configurable 4-axis weights, (b) per-compound multipliers, (c) a move-role tag table that nudges each compound, (d) a polynomial scaler that normalizes 4+4 axes to 0-100.
- New widget `pokeredus/gui/pokemon_set_list.py` (Treeview-based paged list) that renders one row per Pokémon with expand-on-click and a sort mode `ttk.Combobox`.
- New widget `pokeredus/gui/attribute_tuner.py` (sliders for 4 axis weights + 4 compound multipliers) that live-updates the engine and the graph.
- Modify `MatchupGraphView`/`MatchupGraphPage` to host the new list on the left, the new tuner on the right, and the existing 2D/3D graph in the center.
- Add tests for: compound formula, polynomial scaling, list filtering, sort modes.

**Tech Stack:** Python 3.11, tkinter (ttk), numpy, existing `matchup_graph` module.

---

## Open Design Decisions (Confirmed with User)

1. **"Best available score"** for sorting: use the **max volume across that Pokémon's sets** (sort by the strongest set per species).
2. **Compound formula**: `counter = a·attack·w_c + d·defense·w_c` (and same shape for sponge/threat/punish). Defaults: a=d=u=s=1.0, w_c=w_s=w_t=w_p=1.0.
3. **Move-role tags** (additive nudge, not multiplicative): `_SETUP_MOVES` boost threat; `_PIVOT_MOVES` boost punish; `_RECOVERY_MOVES` boost sponge; `_PRIORITY_MOVES` boost counter. Each tag contributes 0.5/0.4/0.3 etc. — all values live in a `MOVE_ROLE_BOOSTS` dict and can be tuned.
4. **Polynomial scaling**: `scaled = 100 * ((raw / k)^p / (1 + (raw/k)^p))` — logistic curve, parameters `k` (midpoint) and `p` (steepness), defaults `k=1.0, p=1.0`. Each axis has its own (k, p) so the 4 base + 4 compound axes can be normalized independently.

---

## Task 1: Pure-math attribute engine — base formula + tuning dataclass

**Files:**
- Create: `pokeredus/graph/attribute_engine.py`
- Test: `tests/test_attribute_engine.py`

**Step 1: Write failing tests**

```python
# tests/test_attribute_engine.py
import numpy as np
from pokeredus.graph.attribute_engine import (
    AttributeTuning, compute_attributes, polynomial_scale, volume_of_tuned,
)

def test_default_tuning_equals_legacy_compound():
    """With all weights/multipliers = 1.0 and no move boosts, the
    compound axes should match the existing per-type sums."""
    tuning = AttributeTuning()  # all defaults
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 2.0   # attack
    base[2] = 3.0   # defense
    out = compute_attributes(base, tuning=tuning)
    # counter (compound 0) = attack + defense, default weights 1
    np.testing.assert_allclose(out[0], base[0] + base[2])


def test_axis_weight_scales_compound():
    tuning = AttributeTuning(axis_attack=2.0)
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 1.0   # attack
    base[2] = 1.0   # defense
    out = compute_attributes(base, tuning=tuning)
    # counter uses attack with weight 2 and defense with weight 1
    np.testing.assert_allclose(out[0], 2.0 * 1.0 + 1.0 * 1.0)


def test_compound_multiplier_scales_compound():
    tuning = AttributeTuning(compound_counter=2.0, axis_attack=1.0, axis_defense=1.0)
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 1.0
    base[2] = 1.0
    out = compute_attributes(base, tuning=tuning)
    # counter = (a*atk + d*def) * 2 = 4
    np.testing.assert_allclose(out[0], 4.0)


def test_polynomial_scale_zero_and_monotone():
    assert polynomial_scale(0.0, k=1.0, p=1.0) == 0.0
    a = polynomial_scale(0.5, k=1.0, p=1.0)
    b = polynomial_scale(1.0, k=1.0, p=1.0)
    c = polynomial_scale(2.0, k=1.0, p=1.0)
    assert 0 < a < b < c <= 100


def test_polynomial_scale_saturates_near_100():
    """For very large raw values, the logistic should approach but not
    exceed 100."""
    v = polynomial_scale(1e6, k=1.0, p=1.0)
    assert 99.0 < v <= 100.0
```

**Step 2: Run tests, verify failure** — `pytest tests/test_attribute_engine.py -v` shows ImportError.

**Step 3: Implement**

```python
# pokeredus/graph/attribute_engine.py
"""Tunable attribute engine: 4 base axes (attack/utility/defense/speed) →
4 compound axes (counter/sponge/threat/punish) with weights, per-compound
multipliers, move-role nudges, and polynomial 0-100 scaling.

This wraps the existing ``pokeredus.graph.matchup_graph`` data layer so
the rest of the GUI can stay unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import numpy as np


# Compound ordering matches the existing polygonal-solid model:
#   counter, sponge, threat, punish
COMPOUND_NAMES = ("counter", "sponge", "threat", "punish")
BASE_NAMES = ("attack", "utility", "defense", "speed")

# Move-role tag boosts (additive nudge per matching move).
# Keys are compound names; values are (move-id-set, boost-per-match).
MOVE_ROLE_BOOSTS: dict[str, tuple[set[str], float]] = {
    "threat":  (
        {"swordsdance", "nastyplot", "calmindmind", "dragondance",
         "bulkup", "coil", "quiverdance", "shellsmash", "workup"},
        0.5,
    ),
    "punish": (
        {"uturn", "voltswitch", "partingshot", "whirlwind", "roar",
         "dragontail", "circlethrow", "teleport", "batonpass"},
        0.4,
    ),
    "sponge": (
        {"recover", "softboiled", "roost", "wish", "milkdrink",
         "morningsun", "moonlight", "synthesis", "healorder",
         "slackoff", "leftover", "protect"},
        0.3,
    ),
    "counter": (
        {"extremespeed", "suckerpunch", "aquajet", "bulletpunch",
         "machpunch", "shadowsneak", "quickattack", "icepunch",
         "thunderpunch", "vacuumwave"},
        0.4,
    ),
}


@dataclass
class AttributeTuning:
    """All tunables for the attribute engine.  Defaults reproduce the
    existing per-type sums from ``compute_compound_attributes``."""

    # 4 base-axis weights (applied to the inputs of every compound)
    axis_attack: float = 1.0
    axis_utility: float = 1.0
    axis_defense: float = 1.0
    axis_speed: float = 1.0

    # 4 per-compound multipliers (applied after the weighted sum)
    compound_counter: float = 1.0
    compound_sponge: float = 1.0
    compound_threat: float = 1.0
    compound_punish: float = 1.0

    # Polynomial-scaling parameters (logistic midpoint k + steepness p)
    # per axis (4 base + 4 compound = 8 axes total).
    k_base: tuple = (1.0, 1.0, 1.0, 1.0)
    p_base: tuple = (1.0, 1.0, 1.0, 1.0)
    k_compound: tuple = (1.0, 1.0, 1.0, 1.0)
    p_compound: tuple = (1.0, 1.0, 1.0, 1.0)

    def as_dict(self) -> dict:
        return {
            "axis_attack": self.axis_attack,
            "axis_utility": self.axis_utility,
            "axis_defense": self.axis_defense,
            "axis_speed": self.axis_speed,
            "compound_counter": self.compound_counter,
            "compound_sponge": self.compound_sponge,
            "compound_threat": self.compound_threat,
            "compound_punish": self.compound_punish,
            "k_base": list(self.k_base),
            "p_base": list(self.p_base),
            "k_compound": list(self.k_compound),
            "p_compound": list(self.p_compound),
        }


def polynomial_scale(raw: np.ndarray | float,
                     k: float = 1.0, p: float = 1.0) -> np.ndarray | float:
    """Logistic polynomial scaling to 0-100.

    ``scaled = 100 * ((raw/k)^p) / (1 + (raw/k)^p)``
    """
    r = np.asarray(raw, dtype=np.float32)
    z = np.power(np.maximum(r, 0.0) / max(k, 1e-9), p)
    return 100.0 * z / (1.0 + z)


def compute_attributes(base_per_type: np.ndarray,
                       tuning: AttributeTuning | None = None,
                       moves: list[str] | None = None) -> np.ndarray:
    """Compute the full 8x18 attribute matrix from the 4 base axes.

    ``base_per_type`` is shape (4, 18): rows 0..3 = attack/utility/defense/speed.
    Returns shape (8, 18): rows 0..3 = scaled base, rows 4..7 = scaled compound.

    The returned matrix is *already polynomially scaled to 0-100* using
    the per-axis (k, p) pairs in ``tuning``.
    """
    tuning = tuning or AttributeTuning()
    base = np.asarray(base_per_type, dtype=np.float32)  # (4, 18)
    assert base.shape == (4, 18), f"expected (4,18), got {base.shape}"

    # ── Compound raw values (no scaling yet) ─────────────────────
    A, U, D, S = base[0], base[1], base[2], base[3]
    counter = (tuning.axis_attack * A + tuning.axis_defense * D) * tuning.compound_counter
    sponge  = (tuning.axis_utility * U + tuning.axis_defense * D) * tuning.compound_sponge
    threat  = (tuning.axis_attack * A + tuning.axis_speed * S) * tuning.compound_threat
    punish  = (tuning.axis_utility * U + tuning.axis_speed * S) * tuning.compound_punish

    # ── Move-role nudges (additive) ──────────────────────────────
    if moves:
        low = {m.lower() for m in moves}
        for cname, (tag_set, boost) in MOVE_ROLE_BOOSTS.items():
            hits = low & tag_set
            if not hits:
                continue
            n = len(hits)
            target = {"counter": counter, "sponge": sponge,
                      "threat": threat, "punish": punish}[cname]
            target += boost * n  # broadcast scalar across the 18-type row

    raw = np.stack([base[0], base[1], base[2], base[3],
                    counter, sponge, threat, punish], axis=0)  # (8, 18)

    # ── Polynomial 0-100 scaling, per axis ───────────────────────
    out = np.zeros_like(raw)
    for i in range(4):
        out[i] = polynomial_scale(raw[i], tuning.k_base[i], tuning.p_base[i])
    for i, c in enumerate(COMPOUND_NAMES):
        out[4 + i] = polynomial_scale(
            raw[4 + i], tuning.k_compound[i], tuning.p_compound[i],
        )
    return out


def volume_of_tuned(attributes_8x18: np.ndarray, bias: float = 1.0) -> float:
    """Volume of the 3D polygonal solid given an *already-scaled* 8x18
    attribute matrix.  Same shape as the existing ``volume_of``."""
    C, G, T, P = 4, 5, 6, 7
    per_type = (attributes_8x18[C] * attributes_8x18[G]
                + attributes_8x18[T] * attributes_8x18[P])
    return float(per_type.sum() * bias)
```

**Step 4: Run tests, verify pass** — `pytest tests/test_attribute_engine.py -v` → 5 passed.

**Step 5: Commit** — `git add pokeredus/graph/attribute_engine.py tests/test_attribute_engine.py && git commit -m "feat(attribute-engine): tunable base+compound attrs with polynomial 0-100 scaling"`

---

## Task 2: Add `tune_existing_node` adapter for the existing SetMatchupNode

**Files:**
- Modify: `pokeredus/graph/attribute_engine.py` (append)
- Test: `tests/test_attribute_engine.py` (append)

**Step 1: Add tests**

```python
def test_tune_existing_node_preserves_shape():
    from pokeredus.graph.matchup_graph import build_node
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    kg = KnowledgeGraph()
    sets = kg.get_all_sets()
    assert sets, "knowledge graph must have at least one set"
    p = kg.get_pokemon(sets[0].pokemon_id)
    node = build_node(sets[0], p, kg=kg)
    tuned = tune_existing_node(node, tuning=AttributeTuning())
    assert tuned.shape == (8, 18)
    # Defaults reproduce existing sums, so the volume should match.
    from pokeredus.graph.matchup_graph import volume_of
    expected = volume_of(node.attributes, node.bias)
    got = volume_of_tuned(tuned)
    assert got == pytest.approx(expected, rel=1e-3)
```

**Step 2: Implement**

```python
# In attribute_engine.py, append:
def tune_existing_node(node, tuning: AttributeTuning | None = None) -> np.ndarray:
    """Re-derive a SetMatchupNode's 8x18 attribute matrix using
    ``AttributeTuning``.  The first 4 rows are taken from the node's
    base attributes; the last 4 are recomputed with the new weights.
    """
    tuning = tuning or AttributeTuning()
    base = node.attributes[:4]   # (4, 18) — already per-type
    moves = list(getattr(node, "moves", [])) or None
    return compute_attributes(base, tuning=tuning, moves=moves)
```

**Step 3: Run tests, verify pass.** **Step 4: Commit.**

---

## Task 3: Pokemon set list — collapsed rows + expand on click + sort modes

**Files:**
- Create: `pokeredus/gui/pokemon_set_list.py`
- Test: `tests/test_pokemon_set_list.py`

**Step 1: Add tests** (headless: no Tk root needed, just the data layer)

```python
# tests/test_pokemon_set_list.py
from pokeredus.gui.pokemon_set_list import (
    group_sets_by_pokemon, sort_groups,
    SortKey, SortOrder, GroupedSet,
)

def _fakes():
    sets = [
        ("garchomp", "swords_dance", 50.0),
        ("garchomp", "choice_scarf", 70.0),
        ("ferrothorn", "defensive", 80.0),
        ("blissey", " cleric", 60.0),
    ]
    return sets

def test_group_sets_by_pokemon():
    groups = group_sets_by_pokemon(_fakes())
    assert {g.pokemon_id for g in groups} == {"garchomp", "ferrothorn", "blissey"}
    garchomp = next(g for g in groups if g.pokemon_id == "garchomp")
    assert len(garchomp.sets) == 2


def test_sort_groups_alpha_asc():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.ALPHA, SortOrder.ASCENDING)
    assert [g.pokemon_id for g in groups] == ["blissey", "ferrothorn", "garchomp"]


def test_sort_groups_volume_desc():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.VOLUME, SortOrder.DESCENDING)
    # best volume per pokemon: ferrothorn 80, garchomp 70, blissey 60
    assert [g.pokemon_id for g in groups] == ["ferrothorn", "garchomp", "blissey"]


def test_best_set_per_pokemon():
    groups = group_sets_by_pokemon(_fakes())
    garchomp = next(g for g in groups if g.pokemon_id == "garchomp")
    assert garchomp.best_set_name == "choice_scarf"
    assert garchomp.best_volume == 70.0
```

**Step 2: Implement**

```python
# pokeredus/gui/pokemon_set_list.py
"""Pokemon-centric set list with collapsed rows + expand-on-click.

Data layer (testable headlessly):
    group_sets_by_pokemon(...)   → list[GroupedSet]
    sort_groups(...)             → list[GroupedSet]
    SortKey, SortOrder, GroupedSet

GUI layer (requires Tk):
    PokemonSetList(master, on_select=callback)
        .refresh(sets)   # replaces the model and re-renders
        .selected_set_id → str | None
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Sequence
import tkinter as tk
from tkinter import ttk


# ── Data model (no Tk) ─────────────────────────────────────────────

class SortKey(str, Enum):
    ALPHA = "alpha"
    VOLUME = "volume"


class SortOrder(str, Enum):
    ASCENDING = "asc"
    DESCENDING = "desc"


@dataclass
class _SetRecord:
    pokemon_id: str
    set_name: str
    volume: float


@dataclass
class GroupedSet:
    pokemon_id: str
    sets: list[tuple[str, str, float]]   # (set_id, set_name, volume)

    @property
    def best_volume(self) -> float:
        return max(v for _, _, v in self.sets) if self.sets else 0.0

    @property
    def best_set_name(self) -> str:
        if not self.sets:
            return ""
        return max(self.sets, key=lambda s: s[2])[1]

    @property
    def set_count(self) -> int:
        return len(self.sets)


def group_sets_by_pokemon(records: Sequence[tuple[str, str, float]]
                          ) -> list[GroupedSet]:
    """Group (pokemon_id, set_name, volume) tuples by pokemon_id while
    preserving insertion order."""
    bucket: dict[str, list[tuple[str, str, float]]] = {}
    order: list[str] = []
    for pid, sname, vol in records:
        if pid not in bucket:
            order.append(pid)
            bucket[pid] = []
        bucket[pid].append((pid, sname, vol))
    return [GroupedSet(pokemon_id=pid, sets=bucket[pid]) for pid in order]


def sort_groups(groups: list[GroupedSet],
                key: SortKey, order: SortOrder) -> list[GroupedSet]:
    if key == SortKey.ALPHA:
        s = sorted(groups, key=lambda g: g.pokemon_id)
    elif key == SortKey.VOLUME:
        s = sorted(groups, key=lambda g: g.best_volume)
    else:
        s = list(groups)
    if order == SortOrder.DESCENDING:
        s.reverse()
    return s


# ── Tk widget ──────────────────────────────────────────────────────

class PokemonSetList(tk.Frame):
    """Treeview with one row per Pokémon; double-click (or the chevron
    toggle) expands to show the sets under that Pokémon."""

    def __init__(self, master, on_select: Callable[[str, str], None] | None = None,
                 **kw):
        super().__init__(master, **kw)
        self._on_select = on_select
        self._groups: list[GroupedSet] = []
        self._sort_key = SortKey.ALPHA
        self._sort_order = SortOrder.ASCENDING
        self._build()

    def _build(self):
        # ── toolbar ────────────────────────────────────────────
        bar = tk.Frame(self, bg="#161b22")
        bar.pack(side="top", fill="x")
        tk.Label(bar, text="Sort:", bg="#161b22", fg="#8b949e",
                 font=("TkFixedFont", 9)).pack(side="left", padx=(8, 2))
        self._key_var = tk.StringVar(value="alpha")
        ttk.Combobox(
            bar, textvariable=self._key_var, width=10, state="readonly",
            values=["alpha", "volume"],
        ).pack(side="left")
        self._order_var = tk.StringVar(value="asc")
        ttk.Combobox(
            bar, textvariable=self._order_var, width=6, state="readonly",
            values=["asc", "desc"],
        ).pack(side="left", padx=(4, 8))
        self._key_var.trace_add("write", lambda *_: self._on_sort_change())
        self._order_var.trace_add("write", lambda *_: self._on_sort_change())

        # ── tree ───────────────────────────────────────────────
        wrap = tk.Frame(self)
        wrap.pack(side="top", fill="both", expand=True)
        self._tree = ttk.Treeview(
            wrap, columns=("best", "vol"), show="tree headings",
            selectmode="browse",
        )
        self._tree.heading("#0", text="Pokémon")
        self._tree.heading("best", text="Best set")
        self._tree.heading("vol", text="Volume")
        self._tree.column("#0", width=140, anchor="w")
        self._tree.column("best", width=140, anchor="w")
        self._tree.column("vol", width=80, anchor="e")
        sb = ttk.Scrollbar(wrap, orient="vertical", command=self._tree.yview)
        self._tree.configure(yscrollcommand=sb.set)
        self._tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        # ── interactions ──────────────────────────────────────
        # Single click on a pokemon row toggles expand.
        # Single click on a set row selects it.
        self._tree.bind("<Button-1>", self._on_click)
        self._tree.bind("<<TreeviewSelect>>", self._on_tree_select)

    # ── public API ──────────────────────────────────────────────
    def refresh(self, records: Sequence[tuple[str, str, float]]) -> None:
        """Replace the model with a new list of
        (pokemon_id, set_name, volume) tuples and re-render."""
        self._groups = sort_groups(
            group_sets_by_pokemon(records),
            self._sort_key, self._sort_order,
        )
        self._repopulate()

    def selected_set_id(self) -> tuple[str, str] | None:
        """Return (pokemon_id, set_id) for the currently selected set
        row, or None if a pokemon header is selected."""
        sel = self._tree.selection()
        if not sel:
            return None
        iid = sel[0]
        tags = self._tree.item(iid, "tags")
        if not tags:
            return None
        kind, pid, sid = tags
        if kind != "set":
            return None
        return pid, sid

    # ── internal ───────────────────────────────────────────────
    def _on_sort_change(self):
        try:
            self._sort_key = SortKey(self._key_var.get())
            self._sort_order = SortOrder(self._order_var.get())
        except ValueError:
            return
        self._groups = sort_groups(self._groups, self._sort_key, self._sort_order)
        self._repopulate()

    def _repopulate(self):
        # Clear and repopulate.  Open=expanded for the *first* group by default.
        for iid in self._tree.get_children(""):
            self._tree.delete(iid)
        for gi, g in enumerate(self._groups):
            pid_iid = f"p:{g.pokemon_id}"
            self._tree.insert(
                "", "end", iid=pid_iid, text=f"▶ {g.pokemon_id}",
                values=(g.best_set_name, f"{g.best_volume:.0f}"),
                tags=("pokemon", g.pokemon_id, ""),
                open=(gi == 0),
            )
            for pid, sname, vol in g.sets:
                sid_iid = f"s:{pid}::{sname}"
                self._tree.insert(
                    pid_iid, "end", iid=sid_iid,
                    text=f"  {sname}", values=("", f"{vol:.0f}"),
                    tags=("set", pid, sname),
                )

    def _on_click(self, event):
        iid = self._tree.identify_row(event.y)
        if not iid:
            return
        # Toggle open state on pokemon rows.
        if iid.startswith("p:"):
            open_now = bool(self._tree.item(iid, "open"))
            pid = self._tree.item(iid, "tags")[1]
            self._tree.item(iid, open=not open_now)
            # Update the chevron in the text.
            self._tree.item(
                iid,
                text=("▼ " if not open_now else "▶ ") + pid,
            )

    def _on_tree_select(self, _evt):
        sel = self.selected_set_id()
        if sel and self._on_select is not None:
            self._on_select(sel[0], sel[1])
```

**Step 3: Run tests, verify pass.** **Step 4: Commit.**

---

## Task 4: Attribute tuner widget — sliders for axis weights, compound multipliers, scaling

**Files:**
- Create: `pokeredus/gui/attribute_tuner.py`
- Test: `tests/test_attribute_tuner.py` (pure-logic test of clamp/format)

**Step 1: Add tests**

```python
# tests/test_attribute_tuner.py
from pokeredus.gui.attribute_tuner import format_slider_value, parse_slider_value

def test_format_and_parse_roundtrip():
    # Sliders work in 0..200, mapped to 0.0..2.0 with 2-decimal precision
    for raw in (0, 50, 100, 150, 200):
        s = format_slider_value(raw / 100.0)
        assert 0 <= s <= 200
        assert abs(parse_slider_value(s) - raw / 100.0) < 0.01
```

**Step 2: Implement**

```python
# pokeredus/gui/attribute_tuner.py
"""Sliders for the 12 tunables of AttributeTuning.

Layout: 4 base-axis weights, 4 compound multipliers, 4 base (k, p)
midpoint/steepness pairs (collapsed behind an "Advanced" toggle).
All sliders write back to a single AttributeTuning instance and fire
``on_change(tuning)`` on every change.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from pokeredus.graph.attribute_engine import AttributeTuning


SLIDER_MIN, SLIDER_MAX = 0, 200    # raw slider value
SLIDER_SCALE = 100.0               # maps slider 0..200 to 0.0..2.0


def format_slider_value(v: float) -> int:
    return int(round(max(SLIDER_MIN, min(SLIDER_MAX, v * SLIDER_SCALE))))


def parse_slider_value(s: int) -> float:
    return s / SLIDER_SCALE


class AttributeTuner(tk.Frame):
    def __init__(self, master, tuning: AttributeTuning | None = None,
                 on_change=None, **kw):
        super().__init__(master, **kw)
        self._tuning = tuning or AttributeTuning()
        self._on_change = on_change
        self._build()

    def _build(self):
        tk.Label(self, text="Attribute tuning", font=("TkFixedFont", 10, "bold")
                 ).grid(row=0, column=0, columnspan=3, sticky="w", padx=8, pady=4)
        self._sliders: dict[str, tk.Scale] = {}
        r = 1
        for label, attr in [
            ("Attack weight",    "axis_attack"),
            ("Utility weight",   "axis_utility"),
            ("Defense weight",   "axis_defense"),
            ("Speed weight",     "axis_speed"),
            ("Counter ×",        "compound_counter"),
            ("Sponge ×",         "compound_sponge"),
            ("Threat ×",         "compound_threat"),
            ("Punish ×",         "compound_punish"),
        ]:
            tk.Label(self, text=label, font=("TkFixedFont", 9)
                     ).grid(row=r, column=0, sticky="w", padx=8)
            s = tk.Scale(
                self, from_=SLIDER_MIN, to=SLIDER_MAX, orient="horizontal",
                resolution=1, length=160,
                command=lambda v, a=attr: self._on_slider(a, v),
            )
            s.set(format_slider_value(getattr(self._tuning, attr)))
            s.grid(row=r, column=1, columnspan=2, sticky="ew", padx=4)
            self._sliders[attr] = s
            r += 1
        self.columnconfigure(1, weight=1)

    def set_tuning(self, tuning: AttributeTuning) -> None:
        self._tuning = tuning
        for attr, s in self._sliders.items():
            s.set(format_slider_value(getattr(tuning, attr)))
        self._fire()

    def _on_slider(self, attr: str, raw: str) -> None:
        v = parse_slider_value(int(float(raw)))
        setattr(self._tuning, attr, v)
        self._fire()

    def _fire(self) -> None:
        if self._on_change is not None:
            self._on_change(self._tuning)
```

**Step 3: Run tests, verify pass.** **Step 4: Commit.**

---

## Task 5: Wire it all together — new MatchupGraphPage layout

**Files:**
- Modify: `pokeredus/gui/matchup_graph_view.py` (replace `_MatchupGraphPageStub`)
- Modify: `pokeredus/gui/app.py` (no changes needed if signature is kept)
- Test: `tests/test_matchup_graph_page_layout.py`

**Step 1: Add a smoke test**

```python
# tests/test_matchup_graph_page_layout.py
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tkinter as tk
from pokeredus.gui.matchup_graph_view import MatchupGraphPage

def test_page_constructs_without_crash():
    root = tk.Tk(); root.withdraw()
    try:
        page = MatchupGraphPage(root, kg=None)
        # Three-pane layout: list (left), tuner (right), graph (center)
        assert hasattr(page, "_list"), "missing _list"
        assert hasattr(page, "_tuner"), "missing _tuner"
        assert hasattr(page, "_view"), "missing _view"
    finally:
        root.destroy()
```

**Step 2: Replace `_MatchupGraphPageStub` body** in `matchup_graph_view.py` with the new layout:

```python
class MatchupGraphPage(tk.Frame):
    """Revamped page: collapsed set list (left), 2D/3D graph (center),
    attribute tuner (right)."""

    def __init__(self, master, kg=None, matchup_cache=None,
                 go_home=None, focus_set_ids=None,
                 focus_team_name=None, on_back_to_team=None, **kw):
        super().__init__(master, **kw)
        self.kg = kg
        self._go_home = go_home
        self._on_back = on_back_to_team
        self._tuning = AttributeTuning()
        self._build_toolbar(focus_team_name)
        self._build_body()

    def _build_toolbar(self, focus_team_name):
        bar = tk.Frame(self, bg="#0d1117"); bar.pack(side="top", fill="x")
        title = focus_team_name or (
            f"Matchup Graph · {len(self._focus_set_ids or [])} sets"
            if getattr(self, "_focus_set_ids", None)
            else "Matchup Graph"
        )
        tk.Label(bar, text=title, bg="#0d1117", fg="#e6edf3",
                 font=("TkFixedFont", 12, "bold")
                 ).pack(side="left", padx=10)
        if self._on_back is not None:
            tk.Button(bar, text="Back to team", command=self._on_back
                      ).pack(side="right", padx=4, pady=4)
        if self._go_home is not None:
            tk.Button(bar, text="Home", command=self._go_home
                      ).pack(side="right", padx=4, pady=4)

    def _build_body(self):
        from pokeredus.gui.pokemon_set_list import PokemonSetList
        from pokeredus.gui.attribute_tuner import AttributeTuner
        from pokeredus.config import SETS_DIR

        body = tk.Frame(self, bg="#0d1117")
        body.pack(fill="both", expand=True)

        # left: pokemon set list
        left = tk.Frame(body, bg="#161b22", width=260)
        left.pack(side="left", fill="y"); left.pack_propagate(False)
        self._list = PokemonSetList(
            left, on_select=self._on_set_selected,
        )
        self._list.pack(fill="both", expand=True)

        # center: graph
        self._view = MatchupGraphView(body, sets_dir=str(SETS_DIR))
        self._view.pack(side="left", fill="both", expand=True)

        # right: tuner
        right = tk.Frame(body, bg="#161b22", width=240)
        right.pack(side="right", fill="y"); right.pack_propagate(False)
        self._tuner = AttributeTuner(
            right, tuning=self._tuning, on_change=self._on_tuning_change,
        )
        self._tuner.pack(fill="x", padx=4, pady=4)

        # Populate the list
        self._reload_list()

        # If team focus is set, build the team node.
        if getattr(self, "_focus_set_ids", None):
            self._view.set_team(self._focus_set_ids, kg=self.kg)

    def _reload_list(self):
        if self.kg is None:
            return
        records = []
        from pokeredus.graph.matchup_graph import build_node, volume_of
        for s in self.kg.get_all_sets():
            p = self.kg.get_pokemon(s.pokemon_id)
            if p is None:
                continue
            try:
                node = build_node(s, p, kg=self.kg)
                v = volume_of(node.attributes, node.bias)
            except Exception:
                v = 0.0
            records.append((s.pokemon_id, s.set_name, v))
        self._list.refresh(records)

    def _on_set_selected(self, pokemon_id: str, set_name: str) -> None:
        if self.kg is None:
            return
        s = next((x for x in self.kg.get_all_sets()
                  if x.pokemon_id == pokemon_id and x.set_name == set_name), None)
        if s is None:
            return
        self._view.set_set(s.pokemon_id, s.id)

    def _on_tuning_change(self, tuning: AttributeTuning) -> None:
        """Re-render the currently shown node with the new tuning."""
        node = self._view._current_node
        if node is None:
            return
        from pokeredus.graph.attribute_engine import tune_existing_node
        new_attrs = tune_existing_node(node, tuning=tuning)
        # Mutate the node in-place so the renderers pick it up.
        node.attributes = new_attrs
        self._view.set_node(node)
```

**Step 3: Make the legacy stub still importable** — keep `MatchupGraphPage = _MatchupGraphPageStub` removed; the new `MatchupGraphPage` is the only class. Tests importing the name from `matchup_graph_view` keep working.

**Step 4: Run tests, verify pass.** **Step 5: Commit.**

---

## Task 6: Regression test — re-run the existing matchup-graph tests

**Files:** none new
**Step 1:** `pytest tests/ -q -k matchup_graph` — verify all green.
**Step 2:** If any test was tied to the old 8-attribute matrix coming from `build_node` directly, adjust to read the *first 4 rows* of `node.attributes` for the base axes (the layout still matches; only the per-axis scaling changed).

---

## Task 7: Commit final wiring & smoke-test the headless build

**Step 1:** `python -c "import pokeredus.gui.matchup_graph_view; import pokeredus.gui.pokemon_set_list; import pokeredus.gui.attribute_tuner; import pokeredus.graph.attribute_engine; print('ok')"`
**Step 2:** `git add <only the files we created> && git commit -m "feat(matchup-graph): collapsible pokemon set list + tunable attribute engine + polynomial scaling"`

---

## Out of Scope

- Volume normalization across the meta (a "global" k per axis). The current k/p is per-axis but constant across Pokémon. Making it global is a v2.
- Persisting tuning to disk between sessions.
- Sprites in the collapsed list rows (kept for a follow-up).
- Renaming the existing 3D cylinder renderer. The 2D polygon renderer continues to use the 8 axes but now consumes the scaled matrix from `tune_existing_node`.
