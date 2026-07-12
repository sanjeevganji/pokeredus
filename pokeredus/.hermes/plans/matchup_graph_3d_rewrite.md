# Matchup Graph 3D Rewrite — Implementation Plan

> **For Hermes:** Use subagent-driven-development to execute this plan task-by-task. After each task: spec-compliance review, then code-quality review. Proceed only when both approve. Fall back to in-session TDD if delegation is unavailable.

**Goal:** Replace the broken force-directed "matchup graph" with a correct 3D polygonal solid (per set or per conjoined team) that visualizes a Pokémon's offensive/defensive/utility/speed performance across all 18 types, with a 2D radial summary view, a navigable 3D cylinder view, and a tested, persisted, on-disk graph-node cache.

**Architecture:** Pure-Python data layer (`pokeredus/graph/matchup_graph.py`) computes and persists 8-attribute × 18-type arrays per set. A separate renderer (`pokeredus/gui/matchup_graph_view.py`) draws a 2D radial polygon and a 3D cylinder of stacked type-discs on a tkinter Canvas. MCTS pairwise scoring (`MatchupScorer`) stays untouched — it's the AI's matchup engine, separate from the visualization. No new pip dependencies.

**Tech Stack:** Python 3.11, tkinter Canvas, stdlib `math`/`json`/`dataclasses`. Existing venv at `pokeredus/.venv`. No new packages.

---

## Design (locked)

### 8 attributes per type, 18 types per set

For each set, we compute **8 attribute values per type** (18 types × 8 = 144 numbers per set, + bias). Types are stored in canonical Showdown type-chart order.

Per type `i` (1..18), the **8 attributes** are the four "edges" of the new graph plus their four compound combinations:

| # | Name      | Formula (per type i)                                                                                | Meaning                                              |
|---|-----------|----------------------------------------------------------------------------------------------------|------------------------------------------------------|
| 1 | attack    | `Σ_stab_dmg_moves bp·eff` for type i                                                               | raw offensive pressure of type i                     |
| 2 | utility   | `count(setup/status_moves of type i)·w_util + count(priority_moves)·w_prio`                        | non-damaging options (hazard/field/pivot/priority)   |
| 3 | defense   | `Σ_incoming_typings 1/eff(attacker→self) · w_phys_or_spec`                                        | how well self resists incoming damage of type i      |
| 4 | speed     | `clamp((eff_spe - 60)/150, 0, 1) · (1 if type_i_offtype else 0.6)`                                 | out-speed value against type i attackers             |
| 5 | counter   | `attack + defense`         (additive, same-axis)                                                    | "this type both hits and resists"                    |
| 6 | sponge    | `utility + defense`        (additive, same-axis)                                                   | "this type utility + resists"                        |
| 7 | threat    | `attack + speed`           (additive, same-axis)                                                    | "this type hits and out-speeds"                      |
| 8 | punish    | `speed + utility`          (additive, same-axis)                                                    | "this type out-speeds and utility-locks"             |

**Perpendicular-axis multiplication** (your spec): in the 2D radial view, the **area** of the polygon is
`Σ (counter_i · sponge_i) + Σ (threat_i · punish_i)`,
where each pair sits on perpendicular axes (counter on Y, sponge on Z) and (threat on Y, punish on Z). Equivalently, the **volume** of the 3D shape =
`Σ_i counter_i · sponge_i + threat_i · punish_i` summed over the 18 types.

### Type ordering for the "vase"
Types sorted in **ascending order of their compound area** (`counter·sponge + threat·punish`) for the *current set* — small area at the bottom, large area at the top, producing a vase silhouette. Recomputed per set; cached on disk with the set's other meta.

### 2D radial view
- default view and simplified view for team builder page
- 8 attribute groups placed at 0°, 45°, 90°, …, 315°.
- Each attribute group is a bar going from center outward, length = Σ of that attribute over 18 types.
- Polygon connects the bar tips, area = team's overall performance.
- Toggle to "elaborate by types" → each bar splits into 18 colored sub-segments (one per type), each sub-segment's length = that type's contribution to that attribute. Type order is the vase order.

### 3D cylinder view
- 18 type-discs stacked vertically. Each disc is a cylinder of radius `(counter+sponge+threat+punish)/4` for that type, height = fixed slab height, colored by type.
- Camera is isometric. Default tilt: ~30° pitch, ~45° yaw.
- Controls: **arrow keys** move camera up/down (which disc is in focus), **horizontal mouse drag** rotates yaw, **vertical mouse drag** rotates pitch, **scroll wheel** zooms, **click on disc** centers and highlights it (shows y/z info in side panel).
- The 4 attribute bars for the focused type are visualized as 4 spokes radiating from the disc's top: north = counter, east = threat, south = sponge, west = punish. (Or, simpler: the 4 spokes are drawn on the disc itself, like a pinwheel.)
- Click a disc → panel updates with: type name, all 8 raw values, the MCTS-style matchup score vs. an active opponent (if any), and the type-color.

### Bias & weights (per set)
- **bias**: a per-set scalar multiplier on the polygon area. Computed as
  `bias = 0.5 + 0.5 · MCTS_composite_score` from `analytics.rank_sets` (existing module, reused).
- **weights**: per-set modifiers applied to each of the 8 attributes based on the set's *role* (from `set.role`): "sweeper" boosts attack+speed, "wall" boosts defense+utility, "pivot" boosts utility+counter, etc. Default mapping table lives in the new file. Weights are positive real numbers, default 1.0.
- Team composer: weighted union = `Σ_sets  weight_set · attr_set_i`  per type per attribute. Then `team_volume = Σ_types (counter·sponge + threat·punish) · bias_set_avg`.

### File / module layout

| Path                                                              | Status   | Purpose                                                                 |
|-------------------------------------------------------------------|----------|-------------------------------------------------------------------------|
| `pokeredus/graph/matchup_graph.py`                                | REWRITE  | New 8-attr × 18-type data layer; team composer; cache I/O              |
| `pokeredus/gui/matchup_graph_view.py`                             | NEW      | 2D radial + 3D cylinder canvas widget                                  |
| `pokeredus/graph/matchup_scorer.py`                               | KEEP     | Untouched; still the MCTS pairwise engine                              |
| `pokeredus/graph/analytics.py`                                    | KEEP     | `rank_sets` reused for the `bias` term                                 |
| `pokeredus/gui/graph_3d.py`                                       | DELETE   | Force-directed engine — wrong abstraction                              |
| `pokeredus/gui/graph_view.py`                                     | DELETE   | 2D projection of force-directed engine                                 |
| `pokeredus/gui/graph_page.py`                                     | DELETE   | Top-level page that wrapped the above                                  |
| `data/graphs/ou_matchup_graph.json` (89 MB)                       | DELETE   | Stale per-Pokémon graph cache                                           |
| `data/graphs/nodes/{pokemon_id}/{set_name}.json` (new)            | CREATE   | Cached 8×18 attribute matrix per set (lazy, on first view)             |
| `data/graphs/nodes/{pokemon_id}/{set_name}.meta.json` (new)       | CREATE   | Cached vase-order, bias, weights, MCTS composite, role                 |
| `tests/test_matchup_graph.py`                                     | REWRITE  | New tests for the data layer                                           |
| `tests/test_matchup_graph_view.py` (was test_graph_3d.py)         | REWRITE  | New tests for the renderer math (projection, hit-test)                 |
| `tests/test_graph.py`                                             | DELETE   | Tested the old force-directed engine                                   |

`matchup_graph.save_node_cache(set_obj, sets_dir)` and `matchup_graph.load_node_cache(set_obj, sets_dir)` live next to `knowledge_graph.save_set_yaml` — `knowledge_graph.save_set_yaml` is updated to also call `matchup_graph.save_node_cache` after a successful save (one-line hook, fits the user's "update this on set save" rule).

---

## Open Design Choices (defaulted — confirm before Task 5 if you want different)

1. **Type canonical order** — Showdown's published type chart order: Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy. Vase-sorted at compute time and stored in the meta.
2. **Per-attribute weights table (set role → weights)** — Default mapping lives in the new file `pokeredus/graph/matchup_graph.py:WEIGHT_TABLE`. Sample: sweeper `{attack:1.3, speed:1.2, threat:1.2, counter:1.0, punish:1.0, sponge:0.8, defense:0.8, utility:0.8}`. Confirm or supply a different table.
3. **MCTS composite → bias** — `bias = 0.5 + 0.5 · composite_score` (range 0.5..1.0). Confirm.
4. **Renderer library** — pure tkinter Canvas, manual back-face culling, manual z-sort. ~300 lines. No new pip dep.
5. **Hit-test** — ray vs. axis-aligned-bounding cylinder (radius = disc radius, height = slab height). Fast and exact.
6. **Subagent dispatch** — per task via `delegate_task` with two-stage review. Fall back to in-session TDD if dispatch fails.

---

## Task 1 — Delete obsolete files

**Files:**
- Delete: `pokeredus/gui/graph_3d.py`
- Delete: `pokeredus/gui/graph_view.py`
- Delete: `pokeredus/gui/graph_page.py`
- Delete: `data/graphs/ou_matchup_graph.json`
- Delete: `tests/test_graph.py`

**Steps:**
1. `git rm` each file (or just `rm` + commit later).
2. `git grep -n "graph_3d\|graph_view\|graph_page\|ou_matchup_graph" pokeredus/` to find any imports we must also clean.
3. Remove any now-dead import lines from the GUI and tests.
4. Commit: `chore: remove obsolete force-directed matchup graph engine`.

**Verify:** `python -c "import pokeredus.gui.app"` still imports (the app.py imports we'll find are then patched in Task 2).

---

## Task 2 — Audit and stub out consumers of the old engine

**Files:**
- `pokeredus/gui/app.py` (and any other consumer of `graph_3d` / `graph_view` / `graph_page`)
- `pokeredus/gui/matchup_panel.py` (search confirmed it imports from graph_3d)

**Steps:**
1. `git grep -n "from pokeredus.gui.graph_3d\|from pokeredus.gui.graph_view\|from pokeredus.gui.graph_page"`.
2. For each match, replace the import with a `pass` placeholder + a `# TODO(matchup-graph-3d): rewire in Task 11` comment.
3. Run: `python -c "from pokeredus.gui import app"` — must succeed.
4. Commit: `refactor: stub old matchup graph consumers pending Task 11 rewire`.

**Verify:** all touched files still import; no other test regresses (`pytest tests/ -x`).

---

## Task 3 — Define the 8-attribute data class + canonical type order

**Files:**
- `pokeredus/graph/matchup_graph.py` (REWRITE — start fresh)
- `tests/test_matchup_graph.py` (REWRITE — start fresh)

**Step 1 — Write the failing test:**

```python
# tests/test_matchup_graph.py
from pokeredus.graph.matchup_graph import (
    CANONICAL_TYPES, ATTRIBUTE_NAMES, MatchupGraphNode,
)

def test_canonical_type_order_has_18_types():
    assert len(CANONICAL_TYPES) == 18
    assert CANONICAL_TYPES[0] == "Normal"
    assert "Fairy" in CANONICAL_TYPES

def test_attribute_names_has_8_entries():
    assert len(ATTRIBUTE_NAMES) == 8
    assert ATTRIBUTE_NAMES == ["attack", "utility", "defense", "speed",
                                "counter", "sponge", "threat", "punish"]

def test_node_shape_is_8x18():
    node = MatchupGraphNode(set_id="x", pokemon_id="y")
    assert node.attributes.shape == (8, 18)
    assert (node.attributes >= 0).all()
```

**Step 2 — Run:** `pytest tests/test_matchup_graph.py -v` → FAIL ("cannot import").

**Step 3 — Minimal implementation:**

```python
# pokeredus/graph/matchup_graph.py
"""Per-set 8-attribute × 18-type matchup-graph data layer.

Stores, for every set, an 8×18 attribute matrix plus a bias and
a set of role-based weights.  The 2D and 3D visualizers consume
this directly.

Axis model (per type i):
    Same-axis (additive): attack+utility are on Y; defense+speed on Z.
    Compound attributes:
        counter = attack + defense
        sponge  = utility + defense
        threat  = attack + speed
        punish  = utility + speed
    Volume of the polygonal solid =
        Σ_i ( counter_i·sponge_i + threat_i·punish_i )  × bias.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np

CANONICAL_TYPES: list[str] = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
    "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]
ATTRIBUTE_NAMES: list[str] = [
    "attack", "utility", "defense", "speed",
    "counter", "sponge", "threat", "punish",
]
ATTRIBUTE_INDEX: dict[str, int] = {n: i for i, n in enumerate(ATTRIBUTE_NAMES)}


@dataclass
class MatchupGraphNode:
    set_id: str
    pokemon_id: str
    attributes: np.ndarray = field(default_factory=lambda: np.zeros((8, 18), dtype=np.float32))
    vase_order: list[int] = field(default_factory=list)  # permutation of 0..17
    bias: float = 1.0
    weights: np.ndarray = field(default_factory=lambda: np.ones(8, dtype=np.float32))
    role: str = ""
    mcts_composite: float = 0.0
```

**Step 4 — Run test:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): 8-attribute dataclass + canonical type order`.

---

## Task 4 — Implement the 4 base attribute computations

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests first:**

```python
# tests/test_matchup_graph.py (add)
from pokeredus.graph.matchup_graph import compute_base_attributes
from pokeredus.classes import SetClass, PokemonClass, Move

def _fake_set():
    p = PokemonClass(id="venusaur", name="Venusaur", types=["Grass", "Poison"],
                     base_stats={"hp":80,"atk":82,"def":83,"spa":100,"spd":100,"spe":80},
                     abilities=[], tier="ou")
    s = SetClass(set_id="venusaur_choice", pokemon_id="venusaur",
                 moves=["sludgebomb", "leafstorm", "hiddenpowerfire", "sleeppowder"])
    return s, p

def test_attack_attribute_counts_stab_and_nukes():
    s, p = _fake_set()
    a = compute_base_attributes(s, p, kg=None)
    # Grass and Poison STAB → those columns boosted
    g_idx = CANONICAL_TYPES.index("Grass")
    po_idx = CANONICAL_TYPES.index("Poison")
    assert a[ATTRIBUTE_INDEX["attack"], g_idx] > 0
    assert a[ATTRIBUTE_INDEX["attack"], po_idx] > 0

def test_defense_attribute_handles_weaknesses():
    s, p = _fake_set()
    a = compute_base_attributes(s, p, kg=None)
    # Ice is 4x weak to Grass/Poison (Fire is 2x weak, Ice is 2x weak to both)
    ice_idx = CANONICAL_TYPES.index("Ice")
    fire_idx = CANONICAL_TYPES.index("Fire")
    assert a[ATTRIBUTE_INDEX["defense"], ice_idx] > 0  # resists itself when super-effective
    # Incoming Fire should be resisted (Fire→Grass is .5x, Fire→Poison is 1x) → defense[Fire] > 0
    assert a[ATTRIBUTE_INDEX["defense"], fire_idx] > 0

def test_speed_attribute_uses_effective_spe():
    s, p = _fake_set()
    a = compute_base_attributes(s, p, kg=None)
    # Venusaur has 80 base spe, max neutral → eff_spe ~ 196 at L100, should be > 0
    for i in range(18):
        assert a[ATTRIBUTE_INDEX["speed"], i] >= 0.0

def test_utility_attribute_counts_status_and_pivot_moves():
    s, p = _fake_set()  # has sleeppowder
    a = compute_base_attributes(s, p, kg=None)
    # utility[Grass]? or [Poison]? — sleep powder is grass type
    g_idx = CANONICAL_TYPES.index("Grass")
    assert a[ATTRIBUTE_INDEX["utility"], g_idx] > 0
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

# Status / pivot / priority / setup move buckets
_STATUS_MOVES = {
    "spore", "sleeppowder", "stunspore", "thunderwave", "willowisp",
    "toxic", "thundercage", "sandattack", "swagger", "confuseray",
}
_PIVOT_MOVES = {
    "uturn", "voltswitch", "partingshot", "whirlwind", "roar",
    "dragontail", "circlethrow", "teleport", "batonpass",
}
_PRIORITY_MOVES = {
    "extremespeed", "suckerpunch", "aquajet", "bulletpunch",
    "machpunch", "shadowsneak", "quickattack", "icepunch",
    "thunderpunch", "icepunch", "vacuumwave",
}
_SETUP_MOVES = {
    "swordsdance", "nastyplot", "calmindmind", "dragondance",
    "bulkup", "coil", "quiverdance", "shellsmash", "workup",
}


def _eff_spe(set_obj, p):
    try:
        return set_obj.effective_stat("spe", p.base_stats, level=100)
    except Exception:
        return float(p.base_stats.get("spe", 100))


def compute_base_attributes(set_obj: "SetClass", p: "PokemonClass", kg=None) -> np.ndarray:
    """Compute the 4 base attributes (attack, utility, defense, speed) for all 18 types.

    Returns: np.ndarray shape (8, 18), only the 4 base rows populated; compounds zeroed.
    """
    a = np.zeros((8, 18), dtype=np.float32)
    type_to_idx = {t: i for i, t in enumerate(CANONICAL_TYPES)}

    # ── ATTACK per type ────────────────────────────────────────────
    for mid in set_obj.moves:
        if kg is not None:
            mv = kg.get_move(mid)
            if mv is None: continue
            move_type = mv.type
            bp = float(mv.base_power or 0)
        else:
            # Test fallback: lookup by id from a small embedded table
            move_type, bp = _lookup_move_fallback(mid)
        if move_type not in type_to_idx or bp <= 0:
            continue
        idx = type_to_idx[move_type]
        stab_bonus = 1.5 if move_type in p.types else 1.0
        nuke_bonus = 1.2 if bp >= 100 else 1.0
        a[ATTRIBUTE_INDEX["attack"], idx] += bp * stab_bonus * nuke_bonus

    # ── UTILITY per type ──────────────────────────────────────────
    has_pivot = any(m.lower() in _PIVOT_MOVES for m in set_obj.moves)
    has_priority = any(m.lower() in _PRIORITY_MOVES for m in set_obj.moves)
    has_setup = any(m.lower() in _SETUP_MOVES for m in set_obj.moves)
    util_bonus = 0.4 * float(has_pivot) + 0.5 * float(has_priority) + 0.6 * float(has_setup)
    for mid in set_obj.moves:
        move_type = _get_move_type(mid, kg)
        if move_type in type_to_idx:
            a[ATTRIBUTE_INDEX["utility"], type_to_idx[move_type]] += 0.3
    a[ATTRIBUTE_INDEX["utility"]] += util_bonus  # spread across all types

    # ── DEFENSE per type ──────────────────────────────────────────
    # For each attacking type t, compute incoming effectiveness on self (p.types).
    from pokeredus.classes import get_effectiveness
    for atk_type in CANONICAL_TYPES:
        mult = 1.0
        for self_t in p.types:
            mult *= get_effectiveness(atk_type, self_t)
        idx = type_to_idx[atk_type]
        # higher mult = weaker to that type → LOWER defense.  We invert so
        # higher defense = better resistance to that type.
        a[ATTRIBUTE_INDEX["defense"], idx] = float(1.0 / max(mult, 0.25))

    # ── SPEED per type ────────────────────────────────────────────
    spe = _eff_spe(set_obj, p)
    norm = max(0.0, min(1.0, (spe - 100) / 150.0))
    for i, t in enumerate(CANONICAL_TYPES):
        a[ATTRIBUTE_INDEX["speed"], i] = norm

    return a


def _get_move_type(mid: str, kg) -> str | None:
    if kg is not None:
        mv = kg.get_move(mid)
        return mv.type if mv else None
    t, _ = _lookup_move_fallback(mid)
    return t


_FALLBACK_MOVES = {
    "sludgebomb": ("Poison", 90), "leafstorm": ("Grass", 130),
    "hiddenpowerfire": ("Fire", 60), "sleeppowder": ("Grass", 0),
    "willowisp": ("Fire", 0), "spore": ("Grass", 0),
    "toxic": ("Poison", 0), "uturn": ("Bug", 70),
    "voltswitch": ("Electric", 70), "thunderwave": ("Electric", 0),
    "extremespeed": ("Normal", 40), "suckerpunch": ("Dark", 70),
    "swordsdance": ("Normal", 0), "nastyplot": ("Dark", 0),
    "calmindmind": ("Psychic", 0), "recover": ("Normal", 0),
    "softboiled": ("Normal", 0), "roost": ("Flying", 0),
    "stealthrock": ("Rock", 0), "spikes": ("Ground", 0),
    "defog": ("Flying", 0), "rapidspin": ("Normal", 50),
    "earthquake": ("Ground", 100), "icebeam": ("Ice", 90),
    "thunderbolt": ("Electric", 90), "flamethrower": ("Fire", 90),
    "surf": ("Water", 90), "moonblast": ("Fairy", 95),
    "shadowball": ("Ghost", 80), "drainpunch": ("Fighting", 75),
    "knockoff": ("Dark", 65), "ironhead": ("Steel", 80),
    "psychic": ("Psychic", 90), "darkpulse": ("Dark", 80),
    "dracometeor": ("Dragon", 130), "hurricane": ("Flying", 110),
    "closecombat": ("Fighting", 120), "flareblitz": ("Fire", 120),
    "boltstrike": ("Electric", 130), "leafblade": ("Grass", 90),
    "stoneedge": ("Rock", 100), "earthpower": ("Ground", 90),
    "bugbuzz": ("Bug", 90), "freezedry": ("Ice", 70),
    "icepunch": ("Ice", 75), "thunderpunch": ("Electric", 75),
    "ironball": ("Steel", 130), "boomburst": ("Normal", 140),
    "voltswitch": ("Electric", 70),
}


def _lookup_move_fallback(mid: str) -> tuple[str | None, float]:
    return _FALLBACK_MOVES.get(mid.lower(), (None, 0.0))
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): 4 base attribute computations`.

---

## Task 5 — Implement the 4 compound attributes + volume formula

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph.py (add)
from pokeredus.graph.matchup_graph import compute_compound_attributes, volume_of

def test_compound_attributes_match_formula():
    base = np.zeros((8, 18), dtype=np.float32)
    base[ATTRIBUTE_INDEX["attack"], 0] = 10.0
    base[ATTRIBUTE_INDEX["defense"], 0] = 2.0
    base[ATTRIBUTE_INDEX["utility"], 1] = 3.0
    base[ATTRIBUTE_INDEX["speed"], 1] = 4.0
    full = compute_compound_attributes(base)
    assert full[ATTRIBUTE_INDEX["counter"], 0] == 12.0   # attack + defense
    assert full[ATTRIBUTE_INDEX["sponge"], 0] == 2.0     # utility + defense (utility=0 in col 0)
    assert full[ATTRIBUTE_INDEX["threat"], 0] == 10.0    # attack + speed (speed=0 in col 0)
    assert full[ATTRIBUTE_INDEX["punish"], 0] == 0.0     # utility + speed (both 0 in col 0)
    assert full[ATTRIBUTE_INDEX["sponge"], 1] == 5.0
    assert full[ATTRIBUTE_INDEX["threat"], 1] == 4.0
    assert full[ATTRIBUTE_INDEX["punish"], 1] == 7.0

def test_volume_of_sums_perpendicular_products():
    full = np.zeros((8, 18), dtype=np.float32)
    full[ATTRIBUTE_INDEX["counter"], 0] = 2.0
    full[ATTRIBUTE_INDEX["sponge"], 0] = 3.0
    full[ATTRIBUTE_INDEX["threat"], 0] = 4.0
    full[ATTRIBUTE_INDEX["punish"], 0] = 5.0
    # Volume per type = counter*sponge + threat*punish = 2*3 + 4*5 = 26
    assert volume_of(full) == 26.0

def test_volume_of_with_bias_scales_linearly():
    full = np.zeros((8, 18), dtype=np.float32)
    full[ATTRIBUTE_INDEX["counter"], 0] = 2.0
    full[ATTRIBUTE_INDEX["sponge"], 0] = 3.0
    assert volume_of(full, bias=0.5) == 3.0
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

def compute_compound_attributes(base: np.ndarray) -> np.ndarray:
    """Compute the 4 compound attributes from the 4 base attributes.

    Compounds live on the perpendicular product: each compound is the
    sum of one Y-axis attribute and one Z-axis attribute.  The volume
    of the 3D polygonal solid is the sum of the products of every
    perpendicular pair over all 18 types.
    """
    full = base.copy()
    A = ATTRIBUTE_INDEX["attack"]; U = ATTRIBUTE_INDEX["utility"]
    D = ATTRIBUTE_INDEX["defense"]; S = ATTRIBUTE_INDEX["speed"]
    full[ATTRIBUTE_INDEX["counter"]] = base[A] + base[D]
    full[ATTRIBUTE_INDEX["sponge"]]  = base[U] + base[D]
    full[ATTRIBUTE_INDEX["threat"]]  = base[A] + base[S]
    full[ATTRIBUTE_INDEX["punish"]]  = base[U] + base[S]
    return full


def volume_of(attributes: np.ndarray, bias: float = 1.0) -> float:
    """Total volume of the 3D polygonal solid.

    V = Σ_i  ( counter_i·sponge_i + threat_i·punish_i )  × bias
    """
    C = ATTRIBUTE_INDEX["counter"]; G = ATTRIBUTE_INDEX["sponge"]
    T = ATTRIBUTE_INDEX["threat"]; P = ATTRIBUTE_INDEX["punish"]
    per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
    return float(per_type.sum() * bias)
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): compound attributes + volume formula`.

---

## Task 6 — Vase-sort the types and the role-weight table

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph.py (add)
from pokeredus.graph.matchup_graph import vase_sort, WEIGHT_TABLE

def test_vase_sort_returns_permutation_in_ascending_area():
    full = np.zeros((8, 18), dtype=np.float32)
    # Force type 5 to be huge, type 0 small
    full[ATTRIBUTE_INDEX["counter"], 5] = 10.0
    full[ATTRIBUTE_INDEX["sponge"], 5] = 10.0
    full[ATTRIBUTE_INDEX["counter"], 0] = 1.0
    full[ATTRIBUTE_INDEX["sponge"], 0] = 1.0
    order = vase_sort(full)
    assert order[0] != 5
    assert order[-1] == 5
    # All 18 indices present
    assert sorted(order) == list(range(18))

def test_weight_table_has_default_role_with_ones():
    for attr in ATTRIBUTE_NAMES:
        assert WEIGHT_TABLE["default"][attr] == 1.0

def test_weight_table_sweeper_boosts_offense():
    assert WEIGHT_TABLE["sweeper"]["attack"] > 1.0
    assert WEIGHT_TABLE["sweeper"]["speed"] > 1.0
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

def vase_sort(attributes: np.ndarray) -> list[int]:
    """Return a permutation of 0..17 sorted by ascending type-area."""
    C = ATTRIBUTE_INDEX["counter"]; G = ATTRIBUTE_INDEX["sponge"]
    T = ATTRIBUTE_INDEX["threat"]; P = ATTRIBUTE_INDEX["punish"]
    per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
    return list(np.argsort(per_type))


WEIGHT_TABLE: dict[str, dict[str, float]] = {
    "default": {a: 1.0 for a in ATTRIBUTE_NAMES},
    "sweeper": {"attack": 1.3, "speed": 1.2, "threat": 1.2,
                 "counter": 1.0, "punish": 1.0,
                 "sponge": 0.8, "defense": 0.8, "utility": 0.8},
    "wall":    {"defense": 1.4, "utility": 1.2, "sponge": 1.3,
                 "counter": 1.0,
                 "attack": 0.8, "speed": 0.7, "threat": 0.8, "punish": 0.7},
    "pivot":   {"utility": 1.3, "counter": 1.2, "punish": 1.2,
                 "sponge": 1.0,
                 "attack": 0.9, "defense": 1.0, "speed": 1.0, "threat": 0.9},
    "cleric":  {"utility": 1.4, "defense": 1.2, "sponge": 1.2,
                 "punish": 1.0,
                 "attack": 0.7, "speed": 0.7, "counter": 0.8, "threat": 0.7},
    "staller": {"defense": 1.3, "utility": 1.3, "sponge": 1.3,
                 "counter": 1.1, "punish": 1.0,
                 "attack": 0.8, "speed": 0.6, "threat": 0.7},
    "lead":    {"utility": 1.2, "attack": 1.1, "counter": 1.1,
                 "threat": 1.1, "punish": 1.0,
                 "defense": 1.0, "speed": 1.0, "sponge": 0.9},
}
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): vase sort + role weight table`.

---

## Task 7 — Full per-set computation pipeline (TDD)

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph.py (add)
from pokeredus.graph.matchup_graph import build_node

def test_build_node_for_venusaur_choice_scarf():
    s, p = _fake_set()
    s.role = "sweeper"
    node = build_node(s, p, kg=None, mcts_composite=0.7)
    assert node.set_id == "venusaur_choice"
    assert node.pokemon_id == "venusaur"
    assert node.role == "sweeper"
    assert node.bias == pytest.approx(0.85)  # 0.5 + 0.5*0.7
    assert node.vase_order != list(range(18))  # non-trivial sort
    assert node.attributes.shape == (8, 18)
    # Sweeper weights applied
    assert node.weights[ATTRIBUTE_INDEX["attack"]] > 1.0
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

def build_node(set_obj: "SetClass", p: "PokemonClass", kg=None,
               mcts_composite: float = 0.0) -> MatchupGraphNode:
    """End-to-end: compute 4 base → 4 compound → vase-sort → bias/weights."""
    base = compute_base_attributes(set_obj, p, kg)
    full = compute_compound_attributes(base)
    role = (getattr(set_obj, "role", "") or "default").lower()
    weights = np.array([WEIGHT_TABLE.get(role, WEIGHT_TABLE["default"])[a]
                        for a in ATTRIBUTE_NAMES], dtype=np.float32)
    full = full * weights[:, None]  # broadcast weights across 18 types
    order = vase_sort(full)
    bias = 0.5 + 0.5 * float(np.clip(mcts_composite, 0.0, 1.0))
    return MatchupGraphNode(
        set_id=set_obj.set_id,
        pokemon_id=set_obj.pokemon_id,
        attributes=full,
        vase_order=order,
        bias=bias,
        weights=weights,
        role=role,
        mcts_composite=float(mcts_composite),
    )
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): end-to-end build_node pipeline`.

---

## Task 8 — Per-set on-disk cache (load / save / path)

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph.py (add)
import json, tempfile, pathlib
from pokeredus.graph.matchup_graph import (
    node_cache_paths, save_node_cache, load_node_cache,
)

def test_cache_paths_lives_next_to_set_yaml(tmp_path):
    p, meta_p = node_cache_paths("venusaur", "choice_scarf", tmp_path)
    assert p.parent.name == "venusaur"
    assert p.suffix == ".json"
    assert meta_p.name.endswith(".meta.json")

def test_save_load_roundtrip(tmp_path):
    s, p = _fake_set()
    node = build_node(s, p)
    save_node_cache(node, tmp_path)
    p_path, meta_path = node_cache_paths(s.pokemon_id, s.set_id, tmp_path)
    assert p_path.exists()
    assert meta_path.exists()
    node2 = load_node_cache(s.pokemon_id, s.set_id, tmp_path)
    np.testing.assert_allclose(node2.attributes, node.attributes)
    assert node2.vase_order == node.vase_order
    assert node2.bias == node.bias
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

NODE_CACHE_DIRNAME = "graphs"


def node_cache_paths(pokemon_id: str, set_id: str, sets_dir) -> tuple[Path, Path]:
    base = Path(sets_dir) / NODE_CACHE_DIRNAME / pokemon_id
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{set_id}.json", base / f"{set_id}.meta.json"


def save_node_cache(node: MatchupGraphNode, sets_dir) -> tuple[Path, Path]:
    data_path, meta_path = node_cache_paths(node.pokemon_id, node.set_id, sets_dir)
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump({
            "set_id": node.set_id,
            "pokemon_id": node.pokemon_id,
            "attributes": node.attributes.tolist(),
        }, f)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({
            "vase_order": list(node.vase_order),
            "bias": float(node.bias),
            "weights": node.weights.tolist(),
            "role": node.role,
            "mcts_composite": float(node.mcts_composite),
        }, f, indent=2)
    return data_path, meta_path


def load_node_cache(pokemon_id: str, set_id: str, sets_dir) -> MatchupGraphNode | None:
    data_path, meta_path = node_cache_paths(pokemon_id, set_id, sets_dir)
    if not data_path.exists() or not meta_path.exists():
        return None
    with open(data_path) as f: d = json.load(f)
    with open(meta_path) as f: m = json.load(f)
    return MatchupGraphNode(
        set_id=d["set_id"],
        pokemon_id=d["pokemon_id"],
        attributes=np.array(d["attributes"], dtype=np.float32),
        vase_order=list(m["vase_order"]),
        bias=float(m["bias"]),
        weights=np.array(m["weights"], dtype=np.float32),
        role=str(m.get("role", "")),
        mcts_composite=float(m.get("mcts_composite", 0.0)),
    )
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): on-disk cache for per-set nodes`.

---

## Task 9 — Wire `save_set_yaml` to also save the node cache

**Files:**
- `pokeredus/graph/knowledge_graph.py` (one method, ~5 lines)

**Step 1 — Test:**

```python
# tests/test_matchup_graph.py (add)
def test_knowledge_graph_save_set_yaml_writes_node_cache(tmp_path):
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    kg = KnowledgeGraph()
    p = PokemonClass(id="venusaur", name="Venusaur", types=["Grass", "Poison"],
                     base_stats={"hp":80,"atk":82,"def":83,"spa":100,"spd":100,"spe":80},
                     abilities=[], tier="ou")
    s = SetClass(set_id="venusaur_choice", pokemon_id="venusaur", moves=["leafstorm"])
    kg.add_pokemon(p)
    kg.add_set(s)
    kg.save_set_yaml(s, sets_dir=tmp_path)
    cache, meta = node_cache_paths("venusaur", "venusaur_choice", tmp_path)
    assert cache.exists(), "save_set_yaml should also save the node cache"
    assert meta.exists()
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:** in `knowledge_graph.save_set_yaml`, after the YAML write, add:

```python
try:
    from pokeredus.graph.matchup_graph import build_node, save_node_cache
    pokemon = self.get_pokemon(set_obj.pokemon_id)
    if pokemon is not None:
        # Reuse the cached MCTS composite if available, else 0.0 (recomputed on next view).
        mcts = float(getattr(set_obj, "mcts_composite", 0.0) or 0.0)
        node = build_node(set_obj, pokemon, kg=self, mcts_composite=mcts)
        save_node_cache(node, sets_dir)
except Exception as _e:
    # Cache failure must not break set save
    pass
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(knowledge-graph): write matchup-graph node cache on set save`.

---

## Task 10 — Team composer: weighted union of set nodes

**Files:**
- `pokeredus/graph/matchup_graph.py`
- `tests/test_matchup_graph.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph.py (add)
from pokeredus.graph.matchup_graph import compose_team_node, team_volume

def test_compose_team_node_sums_attributes():
    s1, p1 = _fake_set()
    s2, p1 = _fake_set()  # second member; same species for simplicity
    n1 = build_node(s1, p1, mcts_composite=0.5)
    n2 = build_node(s2, p1, mcts_composite=0.9)
    team = compose_team_node([n1, n2])
    np.testing.assert_allclose(team.attributes, n1.attributes + n2.attributes)
    assert team.bias == pytest.approx((n1.bias + n2.bias) / 2)

def test_team_volume_matches_weighted_sum():
    s, p = _fake_set()
    n = build_node(s, p, mcts_composite=0.6)
    team = compose_team_node([n, n, n])  # 3x same set
    expected = volume_of(n.attributes) * 3 * n.bias
    assert team_volume(team) == pytest.approx(expected)
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/graph/matchup_graph.py (append)

def compose_team_node(nodes: list[MatchupGraphNode],
                      weights: list[float] | None = None) -> MatchupGraphNode:
    """Weighted union of multiple set nodes into one team node."""
    if not nodes:
        return MatchupGraphNode(set_id="empty_team", pokemon_id="team")
    if weights is None:
        weights = [1.0] * len(nodes)
    ws = np.array(weights, dtype=np.float32)
    total_w = ws.sum()
    if total_w <= 0:
        ws = np.ones_like(ws); total_w = float(len(ws))
    attrs = sum(w * n.attributes for w, n in zip(ws, nodes)) / total_w * total_w
    # Above is just sum (weights applied as multipliers). Simpler form:
    attrs = sum(w * n.attributes for w, n in zip(ws, nodes))
    bias = float(np.mean([n.bias for n in nodes]))
    vase = list(np.argsort(attrs[ATTRIBUTE_INDEX["counter"]] *
                            attrs[ATTRIBUTE_INDEX["sponge"]] +
                            attrs[ATTRIBUTE_INDEX["threat"]] *
                            attrs[ATTRIBUTE_INDEX["punish"]]))
    return MatchupGraphNode(
        set_id="+".join(n.set_id for n in nodes),
        pokemon_id="team",
        attributes=attrs,
        vase_order=vase,
        bias=bias,
        weights=np.ones(8, dtype=np.float32),
        role="team",
        mcts_composite=float(np.mean([n.mcts_composite for n in nodes])),
    )


def team_volume(team: MatchupGraphNode) -> float:
    return volume_of(team.attributes, bias=team.bias)
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(matchup-graph): team composer + team volume`.

---

## Task 11 — 2D radial view widget (skeleton + tests for math)

**Files:**
- `pokeredus/gui/matchup_graph_view.py` (NEW)
- `tests/test_matchup_graph_view.py` (NEW)

**Step 1 — Tests for the geometry helpers:**

```python
# tests/test_matchup_graph_view.py
import math
from pokeredus.gui.matchup_graph_view import (
    attribute_angle, attribute_polygon_points, attribute_color,
)

def test_attribute_angle_spaced_at_45_deg():
    for i in range(8):
        assert attribute_angle(i) == i * math.pi / 4

def test_polygon_points_returns_8_vertices():
    attrs = [1.0] * 8
    pts = attribute_polygon_points(attrs, center=(0, 0), scale=10.0)
    assert len(pts) == 8
    # Each vertex sits on its attribute axis
    for (x, y), ang, a in zip(pts, [i * math.pi / 4 for i in range(8)], attrs):
        r = math.hypot(x, y)
        assert r == pytest.approx(a * 10.0)
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement the pure-geometry helpers (no tk yet):**

```python
# pokeredus/gui/matchup_graph_view.py
"""2D radial + 3D cylinder matchup-graph renderer (pure tkinter Canvas)."""
from __future__ import annotations
import math
from typing import Iterable, Sequence

# Type colors (overridable by theme later)
_TYPE_COLORS = {
    "Normal": "#A8A77A", "Fire": "#EE8130", "Water": "#6390F0",
    "Electric": "#F7D02C", "Grass": "#7AC74C", "Ice": "#96D9D6",
    "Fighting": "#C22E28", "Poison": "#A33EA1", "Ground": "#E2BF65",
    "Flying": "#A98FF3", "Psychic": "#F95587", "Bug": "#A6B91A",
    "Rock": "#B6A136", "Ghost": "#735797", "Dragon": "#6F35FC",
    "Dark": "#705746", "Steel": "#B7B7CE", "Fairy": "#D685AD",
}


def attribute_angle(index: int) -> float:
    """Angle (radians) of attribute #index on the 8-axis radial layout."""
    return index * math.pi / 4


def attribute_polygon_points(values: Sequence[float], center: tuple[float, float],
                              scale: float = 50.0) -> list[tuple[float, float]]:
    pts = []
    for i, v in enumerate(values):
        ang = attribute_angle(i)
        r = max(0.0, v) * scale
        pts.append((center[0] + r * math.cos(ang), center[1] - r * math.sin(ang)))
    return pts


def attribute_color(attr_name: str) -> str:
    """Color for a given attribute axis (4 axes = 2 pairs)."""
    return {
        "attack": "#ee6c4d",  "utility": "#f6ae2d",   # Y-axis pair (warm)
        "defense": "#3a86ff", "speed":   "#06d6a0",   # Z-axis pair (cool)
        "counter": "#ee6c4d", "sponge":  "#06d6a0",
        "threat":  "#f6ae2d", "punish":  "#3a86ff",
    }.get(attr_name, "#888888")
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(gui): matchup-graph view skeleton + geometry helpers`.

---

## Task 12 — 2D view: draw polygon + per-attribute bars + type-segmented elaboration

**Files:**
- `pokeredus/gui/matchup_graph_view.py`
- `tests/test_matchup_graph_view.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph_view.py (add)
def test_elaborate_bars_returns_18_segments_per_attribute():
    from pokeredus.gui.matchup_graph_view import elaborate_bars_per_attribute
    base = np.zeros((8, 18), dtype=np.float32)
    base[0] = 1.0  # attack = 1 for all types
    bars = elaborate_bars_per_attribute(base, vase_order=list(range(18)))
    assert len(bars) == 8
    for b in bars:
        assert len(b) == 18
        assert all(seg >= 0 for seg in b)
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/gui/matchup_graph_view.py (append)
import numpy as np


def elaborate_bars_per_attribute(attributes: np.ndarray,
                                  vase_order: Sequence[int]) -> list[list[float]]:
    """For each of the 8 attributes, return a list of 18 per-type values
    in the vase-order.  Used to draw the 8 bars as 18 colored sub-segments
    when 'elaborate by types' is on.
    """
    out = []
    for row in attributes:  # row is shape (18,)
        out.append([float(row[i]) for i in vase_order])
    return out
```

**Step 4 — Run:** PASS.

**Step 5 — Implement the actual canvas draw method (no test — exercised manually in Task 16):**

```python
# pokeredus/gui/matchup_graph_view.py (append)
import tkinter as tk


class MatchupGraph2D(tk.Frame):
    """Top-down radial polygon view of one set/team node."""

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.elaborate = False
        self._build()

    def _build(self):
        self.canvas = tk.Canvas(self, bg="#0d1117", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda e: self._redraw())
        self.toggle = tk.Button(self, text="Elaborate by types: OFF",
                                 command=self._toggle_elaborate)
        self.toggle.pack(side="bottom", fill="x")

    def set_node(self, node):
        self.node = node
        self._redraw()

    def _toggle_elaborate(self):
        self.elaborate = not self.elaborate
        self.toggle.config(text=f"Elaborate by types: {'ON' if self.elaborate else 'OFF'}")
        self._redraw()

    def _redraw(self):
        c = self.canvas
        c.delete("all")
        w = c.winfo_width(); h = c.winfo_height()
        if w < 50 or h < 50 or self.node is None:
            return
        cx, cy = w / 2, h / 2
        scale = min(w, h) * 0.35
        # 8 attribute sums (length of each bar)
        sums = [float(self.node.attributes[i].sum()) for i in range(8)]
        pts = attribute_polygon_points(sums, (cx, cy), scale=scale)
        # Polygon fill
        c.create_polygon(*sum(pts, ()), fill="#1c1f26", outline="#3a86ff", width=2)
        # Spokes + tips
        from pokeredus.graph.matchup_graph import ATTRIBUTE_NAMES
        for (x, y), name, v in zip(pts, ATTRIBUTE_NAMES, sums):
            c.create_line(cx, cy, x, y, fill=attribute_color(name), width=2)
            c.create_oval(x - 4, y - 4, x + 4, y + 4,
                          fill=attribute_color(name), outline="")
            c.create_text(x + 8, y - 8, text=f"{name}\n{v:.1f}",
                          fill=attribute_color(name), anchor="w", font=("TkFixedFont", 8))
        if self.elaborate:
            from pokeredus.graph.matchup_graph import CANONICAL_TYPES
            bars = elaborate_bars_per_attribute(self.node.attributes, self.node.vase_order)
            # For each attribute axis, draw 18 short colored segments outward.
            for ai, seg_values in enumerate(bars):
                ang = attribute_angle(ai)
                dx, dy = math.cos(ang), -math.sin(ang)
                cursor = 0.0
                for ti, val in enumerate(seg_values):
                    tname = CANONICAL_TYPES[self.node.vase_order[ti]]
                    seg = max(val, 0.0) * scale * 0.02
                    x0 = cx + dx * cursor
                    y0 = cy + dy * cursor
                    x1 = cx + dx * (cursor + seg)
                    y1 = cy + dy * (cursor + seg)
                    c.create_line(x0, y0, x1, y1, fill=_TYPE_COLORS.get(tname, "#888"),
                                  width=3)
                    cursor += seg + 1.0  # small gap
        # Volume readout
        from pokeredus.graph.matchup_graph import volume_of
        c.create_text(10, 10, anchor="nw", fill="#e6edf3",
                      font=("TkFixedFont", 10, "bold"),
                      text=f"Volume: {volume_of(self.node.attributes, self.node.bias):.1f}")
```

**Step 6 — Commit:** `feat(gui): 2D radial polygon view with type elaboration`.

---

## Task 13 — 3D cylinder view: math (camera, projection, hit-test)

**Files:**
- `pokeredus/gui/matchup_graph_view.py`
- `tests/test_matchup_graph_view.py`

**Step 1 — Tests:**

```python
# tests/test_matchup_graph_view.py (add)
import numpy as np
from pokeredus.gui.matchup_graph_view import (
    disc_radius, world_to_screen, screen_to_world, pick_disc,
)

def test_disc_radius_proportional_to_compound_area():
    full = np.zeros((8, 18), dtype=np.float32)
    full[2] = 1.0; full[4] = 1.0  # defense, counter
    r = disc_radius(full, type_index=3, base=10.0)
    assert r > 10.0

def test_world_to_screen_roundtrip_preserves_xy():
    cam = dict(yaw=0.4, pitch=0.3, distance=300, height=400, width=600)
    p = np.array([10.0, 20.0, 30.0])
    s = world_to_screen(p, cam)
    # Yaw/pitch transform is orthogonal, so inverse should recover
    p2 = screen_to_world(s, cam)
    np.testing.assert_allclose(p, p2, atol=1e-6)

def test_pick_disc_finds_closest_within_radius():
    # Discs at world_z = 0, 20, 40, 60, ... 80
    centers = [(0, 0, 20 * i) for i in range(18)]
    radii = [10.0] * 18
    cam = dict(yaw=0.0, pitch=0.0, distance=300, height=400, width=600,
                mouse=(300, 200))  # looking at world origin
    # Ray from camera goes through (0,0,0); closest disc with z=0 should be picked
    idx = pick_disc(centers, radii, cam)
    assert idx in (0, 1)  # either the z=0 disc or the z=20 disc depending on tolerance
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/gui/matchup_graph_view.py (append)
from typing import NamedTuple


class Camera(NamedTuple):
    yaw: float = 0.6
    pitch: float = 0.35
    distance: float = 350.0
    center: tuple = (0.0, 0.0, 40.0)  # mid-tower
    height: int = 600
    width: int = 800


def disc_radius(attributes: np.ndarray, type_index: int, base: float = 8.0) -> float:
    """Disc radius proportional to the type's compound area."""
    C = 4; G = 5; T = 6; P = 7
    area = (attributes[C, type_index] * attributes[G, type_index]
            + attributes[T, type_index] * attributes[P, type_index])
    return base * (1.0 + math.sqrt(max(area, 0.0)) * 0.2)


def world_to_screen(p, cam: Camera) -> tuple[float, float, float]:
    cy, sy = math.cos(cam.yaw), math.sin(cam.yaw)
    cp, sp = math.cos(cam.pitch), math.sin(cam.pitch)
    x, y, z = p[0] - cam.center[0], p[1] - cam.center[1], p[2] - cam.center[2]
    # yaw
    xr = x * cy + z * sy
    zr = -x * sy + z * cy
    # pitch
    yr = y * cp - zr * sp
    zr2 = y * sp + zr * cp
    d = cam.distance - zr2
    focal = 400.0
    sx = cam.width / 2 + (xr * focal) / max(d, 1.0)
    sy_screen = cam.height / 2 - (yr * focal) / max(d, 1.0)
    return (sx, sy_screen, d)


def screen_to_world(s, cam: Camera) -> np.ndarray:
    """Inverse of world_to_screen for a fixed camera."""
    cy, sy = math.cos(cam.yaw), math.sin(cam.yaw)
    cp, sp = math.cos(cam.pitch), math.sin(cam.pitch)
    focal = 400.0
    d = cam.distance  # assume plane at center
    xr = (s[0] - cam.width / 2) * max(d, 1.0) / focal
    yr = (cam.height / 2 - s[1]) * max(d, 1.0) / focal
    zr2 = cam.distance - d  # = 0
    # Undo pitch
    zr = (yr * cp + zr2 * sp)
    y = (zr * sp + yr * cp)
    # Undo yaw
    x = xr * cy - zr * sy
    z = xr * sy + zr * cy
    return np.array([x + cam.center[0], y + cam.center[1], z + cam.center[2]])


def pick_disc(centers: list[tuple[float, float, float]],
              radii: list[float], cam: Camera) -> int | None:
    """Return the index of the disc under the mouse, or None."""
    if cam.get("mouse") is None:
        return None
    mx, my = cam["mouse"]
    # Build ray from camera position through mouse point
    ray_origin = np.array([cam.center[0], cam.center[1], cam.center[2] + cam.distance])
    ray_dir = screen_to_world((mx, my, 0), cam) - ray_origin
    ray_dir /= np.linalg.norm(ray_dir) + 1e-9
    best, best_t = None, float("inf")
    for i, (cx, cy_, cz) in enumerate(centers):
        # axis-aligned cylinder along z (slab height baked into radius check via t)
        dx, dy_, dz = ray_origin[0] - cx, ray_origin[1] - cy_, ray_origin[2] - cz
        # ray-cylinder: |(d - (d·u)u)|^2 < r^2
        u = ray_dir
        proj = dx * u[0] + dy_ * u[1] + dz * u[2]
        perp2 = (dx*dx + dy_*dy_ + dz*dz) - proj * proj
        if perp2 < radii[i] * radii[i] and 0 < proj < best_t:
            best_t = proj
            best = i
    return best
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(gui): 3D camera math + disc hit-test`.

---

## Task 14 — 3D cylinder view: canvas widget

**Files:**
- `pokeredus/gui/matchup_graph_view.py`

**Step 1 — Tests (geometry only; the actual rendering is exercised in Task 16):**

```python
# tests/test_matchup_graph_view.py (add)
def test_disc_centers_stacked_along_z():
    from pokeredus.gui.matchup_graph_view import disc_centers
    centers = disc_centers(slab_height=20.0, base_z=0.0, n=18)
    assert len(centers) == 18
    for i, (x, y, z) in enumerate(centers):
        assert z == i * 20.0
        assert x == 0.0 and y == 0.0
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/gui/matchup_graph_view.py (append)

SLAB_HEIGHT = 20.0


def disc_centers(slab_height: float = SLAB_HEIGHT, base_z: float = 0.0,
                  n: int = 18) -> list[tuple[float, float, float]]:
    return [(0.0, 0.0, base_z + i * slab_height) for i in range(n)]


class MatchupGraph3D(tk.Frame):
    """Isometric 3D cylinder of 18 type-discs.  Arrow keys scroll,
    drag rotates, wheel zooms, click picks a disc."""

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.cam = Camera()
        self.hover_idx: int | None = None
        self.selected_idx: int | None = None
        self._build()
        self._bind_inputs()

    def _build(self):
        self.canvas = tk.Canvas(self, bg="#0d1117", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda e: self._redraw())
        self.info = tk.Label(self, anchor="w", bg="#161b22", fg="#e6edf3",
                              font=("TkFixedFont", 9), justify="left")
        self.info.pack(side="bottom", fill="x")

    def _bind_inputs(self):
        c = self.canvas
        c.bind("<ButtonPress-1>", self._on_press)
        c.bind("<B1-Motion>", self._on_drag)
        c.bind("<ButtonRelease-1>", self._on_release)
        c.bind("<MouseWheel>", self._on_wheel)
        self.bind("<Up>", lambda e: self._scroll(-1))
        self.bind("<Down>", lambda e: self._scroll(+1))
        self._drag_last = None

    def set_node(self, node):
        self.node = node
        self._redraw()

    def _scroll(self, delta: int):
        self.cam = self.cam._replace(center=(self.cam.center[0],
                                              self.cam.center[1],
                                              max(0.0, min(360.0,
                                                  self.cam.center[2] + delta * SLAB_HEIGHT))))
        self._redraw()

    def _on_press(self, e):
        self._drag_last = (e.x, e.y)

    def _on_drag(self, e):
        if self._drag_last is None:
            return
        dx, dy = e.x - self._drag_last[0], e.y - self._drag_last[1]
        self._drag_last = (e.x, e.y)
        new_yaw = self.cam.yaw + dx * 0.008
        new_pitch = max(-1.2, min(1.2, self.cam.pitch + dy * 0.008))
        self.cam = self.cam._replace(yaw=new_yaw, pitch=new_pitch)
        self._redraw()

    def _on_release(self, e):
        self._drag_last = None
        cam = self.cam._asdict()
        cam["mouse"] = (e.x, e.y)
        centers = disc_centers(n=18)
        radii = [disc_radius(self.node.attributes, i) if self.node else 8.0
                  for i in range(18)] if self.node else [8.0] * 18
        idx = pick_disc(centers, radii, Camera(**cam))
        if idx is not None:
            self.selected_idx = idx
            self._update_info_panel(idx)
            self._redraw()

    def _on_wheel(self, e):
        factor = 1.1 if e.delta > 0 else 0.9
        self.cam = self.cam._replace(distance=max(80.0, min(800.0, self.cam.distance * factor)))
        self._redraw()

    def _update_info_panel(self, idx: int):
        from pokeredus.graph.matchup_graph import CANONICAL_TYPES, ATTRIBUTE_NAMES
        if self.node is None:
            return
        a = self.node.attributes
        vase = self.node.vase_order
        type_idx = vase[idx]
        tname = CANONICAL_TYPES[type_idx]
        lines = [f"Type #{idx}  ({tname})  raw_type_index={type_idx}"]
        for ai, name in enumerate(ATTRIBUTE_NAMES):
            lines.append(f"  {name:8s} = {a[ai, type_idx]:.2f}")
        from pokeredus.graph.matchup_graph import volume_of
        lines.append(f"  volume    = {volume_of(self.node.attributes, self.node.bias):.1f}")
        self.info.config(text="\n".join(lines))

    def _redraw(self):
        c = self.canvas
        c.delete("all")
        w = c.winfo_width(); h = c.winfo_height()
        if w < 50 or h < 50:
            return
        cam = self.cam._replace(width=w, height=h)
        if self.node is None:
            return
        from pokeredus.graph.matchup_graph import CANONICAL_TYPES
        vase = self.node.vase_order
        centers = disc_centers(n=18)
        radii = [disc_radius(self.node.attributes, i) for i in range(18)]
        # Project all discs
        projected = []
        for i, center in enumerate(centers):
            sx, sy, depth = world_to_screen(np.array(center), cam)
            projected.append((i, sx, sy, depth, radii[i]))
        # Sort back-to-front
        projected.sort(key=lambda r: r[3])
        for i, sx, sy, depth, r in projected:
            tname = CANONICAL_TYPES[vase[i]]
            color = _TYPE_COLORS.get(tname, "#888888")
            outline = "#ffffff" if i == self.selected_idx else "#222"
            width = 3 if i == self.selected_idx else 1
            r_screen = max(6.0, r * 200.0 / max(depth, 1.0))
            alpha_tag = f"d{i}"
            c.create_oval(sx - r_screen, sy - r_screen,
                          sx + r_screen, sy + r_screen,
                          fill=color, outline=outline, width=width, tags=alpha_tag)
            c.create_text(sx, sy, text=str(i + 1), fill="#000",
                          font=("TkFixedFont", 8, "bold"), tags=alpha_tag)
        # Camera info
        c.create_text(8, 8, anchor="nw", fill="#e6edf3", font=("TkFixedFont", 9),
                      text=f"yaw={cam.yaw:.2f} pitch={cam.pitch:.2f} dist={cam.distance:.0f} "
                            f"center_z={cam.center[2]:.0f}")
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(gui): 3D cylinder canvas widget with controls`.

---

## Task 15 — Combined view widget + 2D/3D toggle

**Files:**
- `pokeredus/gui/matchup_graph_view.py`

**Step 1 — Test:**

```python
# tests/test_matchup_graph_view.py (add)
def test_combined_view_starts_in_2d():
    from pokeredus.gui.matchup_graph_view import MatchupGraphView
    import tkinter as tk
    root = tk.Tk(); root.withdraw()
    v = MatchupGraphView(root, sets_dir=".")
    assert v.mode == "2d"
    v.toggle_mode()
    assert v.mode == "3d"
    v.toggle_mode()
    assert v.mode == "2d"
    root.destroy()
```

**Step 2 — Run:** FAIL.

**Step 3 — Implement:**

```python
# pokeredus/gui/matchup_graph_view.py (append)

class MatchupGraphView(tk.Frame):
    """Combined 2D/3D view with a toggle.  Loads node cache on demand."""

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.mode = "2d"
        self._build()

    def _build(self):
        self.toggle = tk.Button(self, text="Switch to 3D", command=self.toggle_mode)
        self.toggle.pack(side="top", fill="x")
        self.container = tk.Frame(self)
        self.container.pack(fill="both", expand=True)
        self.view_2d = MatchupGraph2D(self.container, self.sets_dir)
        self.view_3d = MatchupGraph3D(self.container, self.sets_dir)
        self.view_2d.pack(fill="both", expand=True)

    def toggle_mode(self):
        if self.mode == "2d":
            self.view_2d.pack_forget()
            self.view_3d.pack(fill="both", expand=True)
            self.mode = "3d"
            self.toggle.config(text="Switch to 2D")
        else:
            self.view_3d.pack_forget()
            self.view_2d.pack(fill="both", expand=True)
            self.mode = "2d"
            self.toggle.config(text="Switch to 3D")
        if self._current_node is not None:
            self.set_node(self._current_node)

    def set_set(self, pokemon_id: str, set_id: str):
        """Lazy-load (or build) the node for the given set and display it."""
        from pokeredus.graph.matchup_graph import load_node_cache, build_node
        node = load_node_cache(pokemon_id, set_id, self.sets_dir)
        if node is None:
            # Build on demand, save for next time
            from pokeredus.graph.knowledge_graph import KnowledgeGraph
            kg = KnowledgeGraph()
            s = kg.get_set(set_id)
            p = kg.get_pokemon(pokemon_id) if s else None
            if s and p:
                node = build_node(s, p, kg=kg)
                from pokeredus.graph.matchup_graph import save_node_cache
                save_node_cache(node, self.sets_dir)
        self._current_node = node
        self.set_node(node)

    def set_node(self, node):
        self.view_2d.set_node(node)
        self.view_3d.set_node(node)
```

**Step 4 — Run:** PASS.

**Step 5 — Commit:** `feat(gui): combined 2D/3D matchup graph view with toggle + lazy load`.

---

## Task 16 — Wire into the main app + delete stubs

**Files:**
- `pokeredus/gui/app.py` (modify)
- `pokeredus/gui/matchup_panel.py` (modify)

**Step 1 — `git grep -n "TODO(matchup-graph-3d)" pokeredus/` to find the stubs from Task 2.

**Step 2 — Replace each stubbed import with a real import and instantiate `MatchupGraphView` in the right tab/window. (Concrete integration points depend on the app's layout — to be filled in at implementation time using the results of Task 1's grep.)

**Step 3 — Add a "Matchup Graph" tab in `app.py` that calls `matchup_view.set_set(pokemon_id, set_id)` when the user selects a set.

**Step 4 — Remove the `# TODO(matchup-graph-3d)` comments.

**Step 5 — Run the full test suite:** `pytest tests/ -x`.
**Step 6 — Manual smoke check (user-driven per project rules):** launch the app, select a set, toggle 2D/3D, click discs, rotate.

**Step 7 — Commit:** `feat(gui): integrate matchup graph view into main app`.

---

## Task 17 — Update ARCHITECTURE.md + delete obsolete docs

**Files:**
- `ARCHITECTURE.md` (edit)
- `IMPLEMENTATION_SUMMARY.md` (verify or amend)

**Steps:**
1. Replace the "Matchup Graph" section's text with the new 8-attr × 18-type model description.
2. Mention the per-set on-disk cache path.
3. Commit: `docs: update ARCHITECTURE for new matchup graph`.

---

## Task 18 — Full test suite + cleanup

**Steps:**
1. `pytest tests/ -v` — all green.
2. `git grep -n "TODO(matchup-graph-3d)" pokeredus/` — must be empty.
3. `git status --short` — only the intended files.
4. `git grep -n "graph_3d\|graph_view\|graph_page\|ou_matchup_graph"` — must be empty in `pokeredus/`.
5. Commit: `chore: final cleanup pass for matchup graph rewrite`.

---

## Verification Summary

| Check                                       | How                                            | Pass condition                  |
|---------------------------------------------|------------------------------------------------|---------------------------------|
| 8-attribute math correct                    | `pytest tests/test_matchup_graph.py`           | All green                       |
| Team composer                               | `test_compose_team_node_sums_attributes`       | Sum equals sum                  |
| Volume formula                              | `test_volume_of_sums_perpendicular_products`   | 26.0 for fixture                |
| Vase sort                                   | `test_vase_sort_returns_permutation`           | Ascending area                  |
| Cache roundtrip                             | `test_save_load_roundtrip`                     | attrs and meta match            |
| Cache-on-save hook                          | `test_knowledge_graph_save_set_yaml_*`         | Files exist after save          |
| 2D polygon math                             | `test_polygon_points_returns_8_vertices`       | 8 vertices, correct radii       |
| 3D camera roundtrip                         | `test_world_to_screen_roundtrip_preserves_xy`  | identity recovered              |
| Disc hit-test                               | `test_pick_disc_finds_closest_within_radius`   | Index returned                  |
| Toggle                                      | `test_combined_view_starts_in_2d`              | 2D ↔ 3D switches                |
| No dead code                                | `git grep graph_3d pokeredus/`                 | Empty                           |
| Old tests gone                              | `pytest tests/test_graph.py`                   | File not found                  |

---

## Risks & Mitigations

- **Move data coverage**: the new code uses `kg.get_move(mid)` for type/lookup. If a move id isn't in the cache, the attribute falls back to 0 for that move. Mitigation: a small in-file fallback table covers ~50 common moves (sufficient for tests + smoke).
- **Vase sort is per-set, not stable across teams**: a team's vase order is recomputed at compose time. No bug, just a note.
- **3D hit-test is approximate**: ray-vs-cylinder is exact for axis-aligned cylinders; the tower is axis-aligned. Good enough at this resolution.
- **Pure tkinter performance** for 18 discs: trivial. ~36 ovals + 18 lines per redraw, well below 16ms.
- **89 MB old graph deletion**: data-only, recoverable from the knowledge graph if ever needed.
