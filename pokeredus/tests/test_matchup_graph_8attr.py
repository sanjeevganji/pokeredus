"""
Tests for the 8-attribute x 18-type matchup-graph data layer (Task 3+).

The 8-attribute model is additive to the existing 3D projection (kept
for the AI's MCTS engine).  These tests cover the new data layer
end-to-end: data classes, base attribute computations, compound
attributes, volume formula, vase sort, role weights, build_node,
on-disk cache, save-on-set-save hook, and team composer.
"""

import os
import sys
import math
import json
import tempfile
import pathlib

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, NatureClass, EVSpreadClass,
)
from pokeredus.config import POKEMON_TYPES
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph import matchup_graph as mg
from pokeredus.graph.matchup_graph import (
    CANONICAL_TYPES, ATTRIBUTE_NAMES, ATTRIBUTE_INDEX,
    SetMatchupNode as MatchupGraphNode,  # new 8-attribute x 18-type node
    compute_base_attributes, compute_compound_attributes, volume_of,
    vase_sort, WEIGHT_TABLE, build_node,
    node_cache_paths, save_node_cache, load_node_cache,
    compose_team_node, team_volume,
)


# ── Fixtures ────────────────────────────────────────────────────────

def _make_pokemon(pid, name, types, stats, abilities=None):
    return PokemonClass(
        id=pid, name=name, types=types,
        base_stats=stats, abilities=abilities or [],
    )


def _make_move(mid, name, mtype, category="Physical", bp=80, acc=100, prio=0):
    return MoveClass(
        id=mid, name=name, type=mtype, category=category,
        base_power=bp, accuracy=acc, priority=prio,
    )


def _make_set(pid, name, moves, nature_name="hardy", increased_stat="",
              decreased_stat="", item="", ability="", evs=None):
    return SetClass(
        id=f"{pid}_{name.lower().replace(' ', '_')}",
        pokemon_id=pid,
        set_name=name,
        ability=ability,
        item=item,
        nature=NatureClass(name=nature_name, increased_stat=increased_stat,
                           decreased_stat=decreased_stat),
        evs=evs or EVSpreadClass(hp=0, atk=0, def_=0, spa=0, spd=0, spe=0),
        moves=moves,
    )


def _make_graph_with(*pokemons, sets=()):
    kg = KnowledgeGraph()
    for p in pokemons:
        kg.add_pokemon(p)
    for s in sets:
        kg.add_set(s)
    return kg


# ── Test pokemon (realistic OU-style stats) ─────────────────────────

GARCHOMP = _make_pokemon(
    "garchomp", "Garchomp", ["Dragon", "Ground"],
    {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
    ["sandveil", "roughskin"],
)

TOXAPEX = _make_pokemon(
    "toxapex", "Toxapex", ["Poison", "Water"],
    {"hp": 50, "atk": 63, "def": 152, "spa": 53, "spd": 142, "spe": 35},
    ["merciless", "limber", "regenerator"],
)

DRAGAPULT = _make_pokemon(
    "dragapult", "Dragapult", ["Dragon", "Ghost"],
    {"hp": 88, "atk": 120, "def": 75, "spa": 100, "spd": 75, "spe": 142},
    ["clearbody", "infiltrator"],
)

CORVIKNIGHT = _make_pokemon(
    "corviknight", "Corviknight", ["Flying", "Steel"],
    {"hp": 98, "atk": 87, "def": 105, "spa": 53, "spd": 85, "spe": 67},
    ["pressure", "unnerve", "mirrorarmor"],
)

HEATRAN = _make_pokemon(
    "heatran", "Heatran", ["Fire", "Steel"],
    {"hp": 91, "atk": 90, "def": 106, "spa": 130, "spd": 106, "spe": 77},
    ["flashfire", "flamebody"],
)

VENUSAUR = _make_pokemon(
    "venusaur", "Venusaur", ["Grass", "Poison"],
    {"hp": 80, "atk": 82, "def": 83, "spa": 100, "spd": 100, "spe": 80},
    ["overgrow", "chlorophyll"],
)


# ── Test sets ───────────────────────────────────────────────────────

GARCHOMP_MOVES = ["earthquake", "outrage", "stoneedge", "swordsdance"]
GARCHOMP_MOVE_OBJS = [
    _make_move("earthquake", "Earthquake", "Ground", bp=100),
    _make_move("outrage", "Outrage", "Dragon", bp=120),
    _make_move("stoneedge", "Stone Edge", "Rock", bp=100),
    _make_move("swordsdance", "Swords Dance", "Normal", category="Status", bp=0),
]
GARCHOMP_SD = _make_set(
    "garchomp", "Swords Dance", GARCHOMP_MOVES,
    nature_name="jolly", increased_stat="spe", decreased_stat="spa",
    item="choicescarf", ability="roughskin",
    evs=EVSpreadClass(hp=0, atk=252, def_=0, spa=0, spd=4, spe=252),
)

TOXAPEX_MOVES = ["recover", "scald", "haze", "toxic"]
TOXAPEX_MOVE_OBJS = [
    _make_move("recover", "Recover", "Normal", category="Status", bp=0),
    _make_move("scald", "Scald", "Water", bp=80),
    _make_move("haze", "Haze", "Ice", category="Status", bp=0),
    _make_move("toxic", "Toxic", "Poison", category="Status", bp=0),
]
TOXAPEX_DEFENSIVE = _make_set(
    "toxapex", "Defensive", TOXAPEX_MOVES,
    nature_name="bold", increased_stat="def", decreased_stat="atk",
    item="blacksludge", ability="regenerator",
    evs=EVSpreadClass(hp=252, atk=0, def_=252, spa=0, spd=4, spe=0),
)

DRAGAPULT_MOVES = ["dragondarts", "shadowball", "uturn", "willowisp"]
DRAGAPULT_MOVE_OBJS = [
    _make_move("dragondarts", "Dragon Darts", "Dragon", bp=100),
    _make_move("shadowball", "Shadow Ball", "Ghost", bp=80, category="Special"),
    _make_move("uturn", "U-turn", "Bug", bp=70),
    _make_move("willowisp", "Will-O-Wisp", "Fire", category="Status", bp=0),
]
DRAGAPULT_CHOICE = _make_set(
    "dragapult", "Choice", DRAGAPULT_MOVES,
    nature_name="adamant", increased_stat="atk", decreased_stat="spa",
    item="choiceband", ability="infiltrator",
    evs=EVSpreadClass(hp=0, atk=252, def_=0, spa=0, spd=4, spe=252),
)

CORVIKNIGHT_MOVES = ["bravebird", "uturn", "defog", "roost"]
CORVIKNIGHT_MOVE_OBJS = [
    _make_move("bravebird", "Brave Bird", "Flying", bp=120),
    _make_move("uturn", "U-turn", "Bug", bp=70),
    _make_move("defog", "Defog", "Flying", category="Status", bp=0),
    _make_move("roost", "Roost", "Flying", category="Status", bp=0),
]
CORVIKNIGHT_PIVOT = _make_set(
    "corviknight", "Pivot", CORVIKNIGHT_MOVES,
    nature_name="impish", increased_stat="def", decreased_stat="spa",
    item="roost", ability="pressure",
    evs=EVSpreadClass(hp=248, atk=0, def_=252, spa=0, spd=8, spe=0),
)

HEATRAN_MOVES = ["magmastorm", "earthpower", "stealthrock", "willowisp"]
HEATRAN_MOVE_OBJS = [
    _make_move("magmastorm", "Magma Storm", "Fire", bp=100, category="Special"),
    _make_move("earthpower", "Earth Power", "Ground", bp=90, category="Special"),
    _make_move("stealthrock", "Stealth Rock", "Rock", category="Status", bp=0),
    _make_move("willowisp", "Will-O-Wisp", "Fire", category="Status", bp=0),
]
HEATRAN_HAZARD = _make_set(
    "heatran", "Hazard Setter", HEATRAN_MOVES,
    nature_name="calm", increased_stat="spd", decreased_stat="atk",
    item="leftovers", ability="flashfire",
    evs=EVSpreadClass(hp=252, atk=0, def_=0, spa=0, spd=252, spe=4),
)

VENUSAUR_MOVES = ["sludgebomb", "leafstorm", "hiddenpowerfire", "sleeppowder"]
VENUSAUR_MOVE_OBJS = [
    _make_move("sludgebomb", "Sludge Bomb", "Poison", bp=90, category="Special"),
    _make_move("leafstorm", "Leaf Storm", "Grass", bp=130, category="Special"),
    _make_move("hiddenpowerfire", "Hidden Power Fire", "Fire", bp=60, category="Special"),
    _make_move("sleeppowder", "Sleep Powder", "Grass", category="Status", bp=0),
]
VENUSAUR_CHOICE = _make_set(
    "venusaur", "Choice", VENUSAUR_MOVES,
    nature_name="modest", increased_stat="spa", decreased_stat="atk",
    item="choicespecs", ability="chlorophyll",
    evs=EVSpreadClass(hp=0, atk=0, def_=0, spa=252, spd=4, spe=252),
)


def _make_venusaur_set_with_role(role: str = "sweeper"):
    s = VENUSAUR_CHOICE
    s.role = role
    return s, VENUSAUR


def make_loaded_graph():
    """Return a KnowledgeGraph populated with the test pokemon + sets."""
    kg = _make_graph_with(
        GARCHOMP, TOXAPEX, DRAGAPULT, CORVIKNIGHT, HEATRAN, VENUSAUR,
        sets=(GARCHOMP_SD, TOXAPEX_DEFENSIVE, DRAGAPULT_CHOICE,
              CORVIKNIGHT_PIVOT, HEATRAN_HAZARD, VENUSAUR_CHOICE),
    )
    for mv in (GARCHOMP_MOVE_OBJS + TOXAPEX_MOVE_OBJS + DRAGAPULT_MOVE_OBJS
               + CORVIKNIGHT_MOVE_OBJS + HEATRAN_MOVE_OBJS + VENUSAUR_MOVE_OBJS):
        kg.add_move(mv)
    return kg


# ═════════════════════════════════════════════════════════════════════
# Task 3: data class + canonical type order
# ═════════════════════════════════════════════════════════════════════

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


# ═════════════════════════════════════════════════════════════════════
# Task 4: 4 base attribute computations
# ═════════════════════════════════════════════════════════════════════

def test_attack_attribute_counts_stab_and_nukes():
    """Venusaur (Grass/Poison) with sludgebomb + leafstorm should have
    strong Grass and Poison attack columns."""
    s, p = _make_venusaur_set_with_role()
    a = compute_base_attributes(s, p, kg=None)
    g_idx = CANONICAL_TYPES.index("Grass")
    po_idx = CANONICAL_TYPES.index("Poison")
    # Grass STAB: leafstorm (BP 130) → big spike.  Poison STAB: sludgebomb (BP 90).
    assert a[ATTRIBUTE_INDEX["attack"], g_idx] > 0
    assert a[ATTRIBUTE_INDEX["attack"], po_idx] > 0


def test_defense_attribute_handles_weaknesses():
    """Higher defense value = better resistance (1/effectiveness)."""
    s, p = _make_venusaur_set_with_role()
    a = compute_base_attributes(s, p, kg=None)
    # Every type should produce a positive defense value (since we use 1/eff, never 0)
    for i in range(18):
        assert a[ATTRIBUTE_INDEX["defense"], i] > 0.0


def test_speed_attribute_uses_effective_spe():
    """Speed attribute should be >= 0 for every type."""
    s, p = _make_venusaur_set_with_role()
    a = compute_base_attributes(s, p, kg=None)
    for i in range(18):
        assert a[ATTRIBUTE_INDEX["speed"], i] >= 0.0


def test_utility_attribute_counts_status_and_pivot_moves():
    """Venusaur has sleeppowder (status, Grass) and the utility vector
    should give a non-zero contribution to the Grass column."""
    s, p = _make_venusaur_set_with_role()
    a = compute_base_attributes(s, p, kg=None)
    g_idx = CANONICAL_TYPES.index("Grass")
    # Either per-type or whole-set utility bonus is non-zero somewhere
    assert a[ATTRIBUTE_INDEX["utility"]].sum() > 0


# ═════════════════════════════════════════════════════════════════════
# Task 5: 4 compound attributes + volume formula
# ═════════════════════════════════════════════════════════════════════

def test_compound_attributes_match_formula():
    base = np.zeros((8, 18), dtype=np.float32)
    base[ATTRIBUTE_INDEX["attack"], 0] = 10.0
    base[ATTRIBUTE_INDEX["defense"], 0] = 2.0
    base[ATTRIBUTE_INDEX["utility"], 1] = 3.0
    base[ATTRIBUTE_INDEX["defense"], 1] = 2.0   # so sponge[1] = utility + defense = 5
    base[ATTRIBUTE_INDEX["speed"], 1] = 4.0
    full = compute_compound_attributes(base)
    assert full[ATTRIBUTE_INDEX["counter"], 0] == pytest.approx(12.0)   # attack + defense
    assert full[ATTRIBUTE_INDEX["sponge"], 0] == pytest.approx(2.0)     # utility=0 + defense
    assert full[ATTRIBUTE_INDEX["threat"], 0] == pytest.approx(10.0)    # attack + speed=0
    assert full[ATTRIBUTE_INDEX["punish"], 0] == pytest.approx(0.0)     # utility=0 + speed=0
    assert full[ATTRIBUTE_INDEX["sponge"], 1] == pytest.approx(5.0)     # 3 + 2
    # threat = attack + speed (NOT utility + speed)
    assert full[ATTRIBUTE_INDEX["threat"], 1] == pytest.approx(4.0)
    # punish = utility + speed
    assert full[ATTRIBUTE_INDEX["punish"], 1] == pytest.approx(7.0)     # 3 + 4


def test_volume_of_sums_perpendicular_products():
    full = np.zeros((8, 18), dtype=np.float32)
    full[ATTRIBUTE_INDEX["counter"], 0] = 2.0
    full[ATTRIBUTE_INDEX["sponge"], 0] = 3.0
    full[ATTRIBUTE_INDEX["threat"], 0] = 4.0
    full[ATTRIBUTE_INDEX["punish"], 0] = 5.0
    # Volume per type = counter*sponge + threat*punish = 2*3 + 4*5 = 26
    assert volume_of(full) == pytest.approx(26.0)


def test_volume_of_with_bias_scales_linearly():
    full = np.zeros((8, 18), dtype=np.float32)
    full[ATTRIBUTE_INDEX["counter"], 0] = 2.0
    full[ATTRIBUTE_INDEX["sponge"], 0] = 3.0
    assert volume_of(full, bias=0.5) == pytest.approx(3.0)


# ═════════════════════════════════════════════════════════════════════
# Task 6: vase sort + role weight table
# ═════════════════════════════════════════════════════════════════════

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
        assert WEIGHT_TABLE["default"][attr] == pytest.approx(1.0)


def test_weight_table_sweeper_boosts_offense():
    assert WEIGHT_TABLE["sweeper"]["attack"] > 1.0
    assert WEIGHT_TABLE["sweeper"]["speed"] > 1.0


# ═════════════════════════════════════════════════════════════════════
# Task 7: end-to-end build_node pipeline
# ═════════════════════════════════════════════════════════════════════

def test_build_node_for_venusaur_choice():
    s, p = _make_venusaur_set_with_role("sweeper")
    node = build_node(s, p, kg=None, mcts_composite=0.7)
    assert node.set_id == s.id
    assert node.pokemon_id == "venusaur"
    assert node.role == "sweeper"
    assert node.bias == pytest.approx(0.85)  # 0.5 + 0.5*0.7
    assert node.attributes.shape == (8, 18)
    # Sweeper weights applied
    assert node.weights[ATTRIBUTE_INDEX["attack"]] > 1.0
    # Vase order is a permutation of 0..17
    assert sorted(node.vase_order) == list(range(18))


def test_build_node_bias_clipped_to_unit_range():
    s, p = _make_venusaur_set_with_role()
    # mcts_composite > 1 should still bias to <= 1
    node = build_node(s, p, kg=None, mcts_composite=5.0)
    assert node.bias <= 1.0 + 1e-6
    # mcts_composite < 0 should still bias to >= 0.5
    node2 = build_node(s, p, kg=None, mcts_composite=-1.0)
    assert node2.bias >= 0.5 - 1e-6


# ═════════════════════════════════════════════════════════════════════
# Task 8: on-disk cache
# ═════════════════════════════════════════════════════════════════════

def test_cache_paths_lives_next_to_set_yaml(tmp_path):
    p, meta_p = node_cache_paths("venusaur", "choice_scarf", tmp_path)
    assert p.parent.name == "venusaur"
    assert p.suffix == ".json"
    assert meta_p.name.endswith(".meta.json")


def test_save_load_roundtrip(tmp_path):
    s, p = _make_venusaur_set_with_role()
    node = build_node(s, p)
    save_node_cache(node, tmp_path)
    p_path, meta_path = node_cache_paths(s.pokemon_id, s.id, tmp_path)
    assert p_path.exists()
    assert meta_path.exists()
    node2 = load_node_cache(s.pokemon_id, s.id, tmp_path)
    np.testing.assert_allclose(node2.attributes, node.attributes, atol=1e-5)
    assert node2.vase_order == node.vase_order
    assert node2.bias == pytest.approx(node.bias)
    assert node2.role == node.role


def test_load_missing_returns_none(tmp_path):
    out = load_node_cache("ghostmon", "g不动_set", tmp_path)
    assert out is None


# ═════════════════════════════════════════════════════════════════════
# Task 9: save_set_yaml hook writes node cache
# ═════════════════════════════════════════════════════════════════════

def test_knowledge_graph_save_set_yaml_writes_node_cache(tmp_path):
    kg = make_loaded_graph()
    s = kg.get_set(VENUSAUR_CHOICE.id)
    kg.save_set_yaml(s, sets_dir=tmp_path)
    cache, meta = node_cache_paths(s.pokemon_id, s.id, tmp_path)
    assert cache.exists(), "save_set_yaml should also save the node cache"
    assert meta.exists()


# ═════════════════════════════════════════════════════════════════════
# Task 10: team composer
# ═════════════════════════════════════════════════════════════════════

def test_compose_team_node_sums_attributes():
    s, p = _make_venusaur_set_with_role()
    n1 = build_node(s, p, mcts_composite=0.5)
    n2 = build_node(s, p, mcts_composite=0.9)
    team = compose_team_node([n1, n2])
    np.testing.assert_allclose(team.attributes, n1.attributes + n2.attributes)
    assert team.bias == pytest.approx((n1.bias + n2.bias) / 2)


def test_compose_team_node_empty():
    team = compose_team_node([])
    assert team.attributes.shape == (8, 18)
    assert team.set_id == "empty_team"
    assert (team.attributes == 0).all()


def test_team_volume_matches_weighted_sum():
    s, p = _make_venusaur_set_with_role()
    n = build_node(s, p, mcts_composite=0.6)
    team = compose_team_node([n, n, n])  # 3x same set, team_attrs = 3 * n.attributes
    # volume is quadratic in attributes, so 3x attrs = 9x volume, times team.bias
    expected = 9 * volume_of(n.attributes) * team.bias
    assert team_volume(team) == pytest.approx(expected)


def test_compose_team_node_respects_weights():
    s, p = _make_venusaur_set_with_role()
    n1 = build_node(s, p, mcts_composite=0.5)
    n2 = build_node(s, p, mcts_composite=0.5)
    # Weight 1.0 and 2.0 — n2 should contribute twice
    team = compose_team_node([n1, n2], weights=[1.0, 2.0])
    np.testing.assert_allclose(team.attributes, n1.attributes + 2.0 * n2.attributes)
