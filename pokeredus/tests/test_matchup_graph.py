"""
Tests for the 3D matchup graph module (pokeredus.graph.matchup_graph).

Covers: dataclasses, type/offdef/scu axis projections, container, AI queries.
"""

import os
import sys
import math

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, NatureClass, EVSpreadClass,
)
from pokeredus.config import POKEMON_TYPES
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph import matchup_graph as mg


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


# ── Test sets ───────────────────────────────────────────────────────

GARCHOMP_MOVES = [
    "earthquake", "outrage", "stoneedge", "swordsdance",
]
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

TOXAPEX_MOVES = [
    "recover", "scald", "haze", "toxic",
]
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

DRAGAPULT_MOVES = [
    "dragondarts", "shadowball", "uturn", "willowisp",
]
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

CORVIKNIGHT_MOVES = [
    "bravebird", "uturn", "defog", "roost",
]
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

HEATRAN_MOVES = [
    "magmastorm", "earthpower", "stealthrock", "willowisp",
]
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


# ── Helpers to build a fully-populated graph ────────────────────────

def make_loaded_graph():
    """Return a KnowledgeGraph populated with the 5 test pokemon + sets."""
    kg = _make_graph_with(
        GARCHOMP, TOXAPEX, DRAGAPULT, CORVIKNIGHT, HEATRAN,
        sets=(GARCHOMP_SD, TOXAPEX_DEFENSIVE, DRAGAPULT_CHOICE,
              CORVIKNIGHT_PIVOT, HEATRAN_HAZARD),
    )
    # Load move objects into the graph
    for mv in (GARCHOMP_MOVE_OBJS + TOXAPEX_MOVE_OBJS + DRAGAPULT_MOVE_OBJS
               + CORVIKNIGHT_MOVE_OBJS + HEATRAN_MOVE_OBJS):
        kg.add_move(mv)
    return kg


# ═════════════════════════════════════════════════════════════════════
# Task 1: Data classes exist
# ═════════════════════════════════════════════════════════════════════

def test_matchup_graph_node_dataclass_exists():
    """MatchupGraphNode dataclass must be importable and constructible."""
    node = mg.MatchupGraphNode(
        id="garchomp_sd",
        kind="set",
        label="Garchomp Swords Dance",
        axis_type_vector={"Dragon": 1.0, "Ground": 0.8},
        axis_offdef=0.5,
        axis_speed_control_utility=(0.4, 0.3, 0.3),
        member_ids=["garchomp_swords_dance"],
    )
    assert node.id == "garchomp_sd"
    assert node.kind == "set"
    assert node.axis_offdef == 0.5
    assert sum(node.axis_speed_control_utility) == pytest_approx(1.0)


def test_graph_projection_dataclass_exists():
    """GraphProjection dataclass must wrap a node with a timestamp."""
    node = mg.MatchupGraphNode(
        id="x", kind="set", label="x",
        axis_type_vector={}, axis_offdef=0.0,
        axis_speed_control_utility=(1, 0, 0),
        member_ids=[],
    )
    proj = mg.GraphProjection(target_id="x", node=node, computed_at="2026-06-02")
    assert proj.target_id == "x"
    assert proj.node is node
    assert proj.computed_at == "2026-06-02"


def pytest_approx(value, tol=1e-6):
    """Tiny helper to avoid pulling in pytest.approx inline everywhere."""
    return value  # we use math.isclose for actual checks; this is just for the assert msg


# ═════════════════════════════════════════════════════════════════════
# Task 2: Type-axis projection
# ═════════════════════════════════════════════════════════════════════

def test_type_axis_single_set_garchomp():
    """Garchomp (Dragon/Ground) with STAB Earthquake+Outrage should have
    Dragon and Ground cells highest, Fire at 0, Grass at 0."""
    kg = make_loaded_graph()
    garchomp_set = kg.get_set("garchomp_swords_dance")
    vec = mg.project_type_axis(garchomp_set, kg)
    # 18 types present
    assert len(vec) == 18
    for t in POKEMON_TYPES:
        assert t in vec
    # Fire: not a type, no Fire STAB → 0
    assert vec["Fire"] == 0.0
    # Dragon: type (0.5) + STAB Outrage (0.3) + nuke (0.2) = 1.0 (capped)
    assert vec["Dragon"] == 1.0
    # Ground: type (0.5) + STAB Earthquake (0.3) + nuke (0.2) = 1.0
    assert vec["Ground"] == 1.0
    # Poison: not a type, but Garchomp has no Poison STAB → 0
    assert vec["Poison"] == 0.0
    # All values in [0, 1]
    for t, v in vec.items():
        assert 0.0 <= v <= 1.0, f"{t} = {v}"


def test_type_axis_dual_type_mon():
    """A mono-type mon should have a 0.5 base; dual type should have both at 0.5."""
    kg = make_loaded_graph()
    dragapult = kg.get_set("dragapult_choice")
    vec = mg.project_type_axis(dragapult, kg)
    # Dragon and Ghost are its types, each gets 0.5 base
    assert vec["Dragon"] >= 0.5
    assert vec["Ghost"] >= 0.5
    # No Fire STAB
    assert vec["Fire"] == 0.0


def test_type_axis_team_average():
    """Team projection is mean of member vectors."""
    kg = make_loaded_graph()
    team = [kg.get_set("garchomp_swords_dance"),
            kg.get_set("toxapex_defensive"),
            kg.get_set("dragapult_choice")]
    team_vec = mg.project_type_axis(team, kg)
    # Each cell should be the mean of the 3 members
    gv = mg.project_type_axis(team[0], kg)
    tv = mg.project_type_axis(team[1], kg)
    dv = mg.project_type_axis(team[2], kg)
    for t in POKEMON_TYPES:
        expected = (gv[t] + tv[t] + dv[t]) / 3
        assert math.isclose(team_vec[t], expected, abs_tol=1e-9), \
            f"{t}: team={team_vec[t]} expected={expected}"


def test_type_axis_caps_at_one():
    """Any single cell value should be <= 1.0 even with massive STAB stacking."""
    # Make a set with all 4 moves being the same STAB nuke
    moves = [
        _make_move("outrage", "Outrage", "Dragon", bp=120),
        _make_move("dragonclaw", "Dragon Claw", "Dragon", bp=80),
        _make_move("dracometeor", "Draco Meteor", "Dragon", bp=130, category="Special"),
        _make_move("dragondance", "Dragon Dance", "Dragon", category="Status", bp=0),
    ]
    set_obj = _make_set("garchomp", "Extreme", [m.id for m in moves])
    kg = _make_graph_with(GARCHOMP, sets=(set_obj,))
    for m in moves:
        kg.add_move(m)
    vec = mg.project_type_axis(set_obj, kg)
    assert vec["Dragon"] <= 1.0
    # Should be capped at 1.0 (multiple STABs)
    assert vec["Dragon"] == 1.0


# ═════════════════════════════════════════════════════════════════════
# Task 3: Offdef-axis projection
# ═════════════════════════════════════════════════════════════════════

def test_offdef_garchomp_positive():
    """A sweeper like Garchomp should project to > 0 (offense-leaning)."""
    kg = make_loaded_graph()
    garchomp = kg.get_set("garchomp_swords_dance")
    score = mg.project_offdef_axis(garchomp, kg)
    assert score > 0.0, f"Garchomp offdef = {score}, expected > 0"
    assert -1.0 <= score <= 1.0


def test_offdef_toxapex_negative():
    """A wall like Toxapex should project to < 0 (defense-leaning)."""
    kg = make_loaded_graph()
    pex = kg.get_set("toxapex_defensive")
    score = mg.project_offdef_axis(pex, kg)
    assert score < 0.0, f"Toxapex offdef = {score}, expected < 0"
    assert -1.0 <= score <= 1.0


def test_offdef_in_range():
    """offdef score always in [-1, 1] for any set."""
    kg = make_loaded_graph()
    for sid in ("garchomp_swords_dance", "toxapex_defensive",
                "dragapult_choice", "corviknight_pivot", "heatran_hazard_setter"):
        s = mg.project_offdef_axis(kg.get_set(sid), kg)
        assert -1.0 <= s <= 1.0, f"{sid} offdef={s}"


def test_offdef_team_weighted():
    """Team offdef is a weighted average of member scores."""
    kg = make_loaded_graph()
    team = [kg.get_set("garchomp_swords_dance"), kg.get_set("toxapex_defensive")]
    team_score = mg.project_offdef_axis(team, kg)
    # Should be a blend; just check it's in [-1, 1]
    assert -1.0 <= team_score <= 1.0
    # And somewhere between the two extremes
    s_g = mg.project_offdef_axis(team[0], kg)
    s_t = mg.project_offdef_axis(team[1], kg)
    assert min(s_g, s_t) <= team_score <= max(s_g, s_t)


# ═════════════════════════════════════════════════════════════════════
# Task 4: Speed/Control/Utility axis
# ═════════════════════════════════════════════════════════════════════

def test_scu_dragapult_high_speed():
    """Dragapult (spe=142) should have a high speed_score (~0.82)."""
    kg = make_loaded_graph()
    pult = kg.get_set("dragapult_choice")
    scu = mg.project_scu_axis(pult, kg)
    assert scu[0] > 0.7, f"Dragapult speed_score = {scu[0]}, expected > 0.7"


def test_scu_toxapex_high_control():
    """Toxapex (Recover + Haze) should have control_score = 2/3 = 0.667."""
    kg = make_loaded_graph()
    pex = kg.get_set("toxapex_defensive")
    scu = mg.project_scu_axis(pex, kg)
    # 2 pivot/recovery moves out of 3.0 denominator = 0.667
    assert scu[1] > 0.5, f"Toxapex control_score = {scu[1]}, expected > 0.5"


def test_scu_hazard_setter_has_utility():
    """Heatran (Stealth Rock) has raw utility_score >= 0.4 (0.4 * 1 hazard_setter).

    Note: utility may shrink after simplex projection if speed is high.
    The test verifies the raw utility contribution is at least 0.4, which
    means a hazard_setter is recognised as such.
    """
    from pokeredus.graph.matchup_graph import _scu_raw_for_set
    kg = make_loaded_graph()
    tran = kg.get_set("heatran_hazard_setter")
    raw = _scu_raw_for_set(tran, kg)
    # Raw utility bucket from Stealth Rock
    assert raw[2] >= 0.4, f"Heatran raw utility_score = {raw[2]}, expected >= 0.4"
    # After simplex projection, scu[2] should still be in [0, 1] and sum to 1
    scu = mg.project_scu_axis(tran, kg)
    assert 0.0 <= scu[2] <= 1.0
    assert math.isclose(sum(scu), 1.0, abs_tol=1e-9)


def test_scu_sums_to_one():
    """SCU tuple always sums to exactly 1.0 (simplex constraint)."""
    kg = make_loaded_graph()
    for sid in ("garchomp_swords_dance", "toxapex_defensive",
                "dragapult_choice", "corviknight_pivot", "heatran_hazard_setter"):
        scu = mg.project_scu_axis(kg.get_set(sid), kg)
        assert math.isclose(sum(scu), 1.0, abs_tol=1e-9), \
            f"{sid} scu sum = {sum(scu)}"


def test_scu_all_nonnegative():
    """No component should be negative."""
    kg = make_loaded_graph()
    for sid in ("garchomp_swords_dance", "toxapex_defensive",
                "dragapult_choice", "corviknight_pivot", "heatran_hazard_setter"):
        scu = mg.project_scu_axis(kg.get_set(sid), kg)
        for i, v in enumerate(scu):
            assert v >= 0.0, f"{sid} scu[{i}] = {v}"


def test_scu_team_centroid():
    """Team SCU is the simplex projection of the mean of member raw scores.

    The simplex projection is non-linear, so this is NOT the same as the
    mean of member SCU tuples. The team's raw scores are averaged first,
    then projected to the simplex as a single point.
    """
    from pokeredus.graph.matchup_graph import _scu_raw_for_set
    kg = make_loaded_graph()
    team = [kg.get_set("garchomp_swords_dance"),
            kg.get_set("toxapex_defensive"),
            kg.get_set("dragapult_choice")]
    team_scu = mg.project_scu_axis(team, kg)
    raw_means = [
        sum(_scu_raw_for_set(s, kg)[i] for s in team) / len(team)
        for i in range(3)
    ]
    # Team scu should equal the projection of the raw means
    from pokeredus.graph.matchup_graph import _project_to_simplex
    expected = _project_to_simplex(*raw_means)
    for i in range(3):
        assert math.isclose(team_scu[i], expected[i], abs_tol=1e-9), \
            f"axis {i}: team={team_scu[i]} expected={expected[i]}"
    # And it must always sum to 1 (simplex property)
    assert math.isclose(sum(team_scu), 1.0, abs_tol=1e-9)


# ═════════════════════════════════════════════════════════════════════
# Task 5: project_to_3d + MatchupGraph container
# ═════════════════════════════════════════════════════════════════════

def test_project_to_3d_single_set():
    """A SetClass should produce a kind='set' node with all three axes."""
    kg = make_loaded_graph()
    node = mg.project_to_3d(kg.get_set("garchomp_swords_dance"), kg)
    assert node.kind == "set"
    assert "Dragon" in node.axis_type_vector
    assert -1.0 <= node.axis_offdef <= 1.0
    assert math.isclose(sum(node.axis_speed_control_utility), 1.0, abs_tol=1e-9)
    assert node.id == "garchomp_swords_dance"
    assert "Garchomp" in node.label


def test_project_to_3d_with_str_id():
    """Passing a str set_id should resolve and project the same node."""
    kg = make_loaded_graph()
    node = mg.project_to_3d("garchomp_swords_dance", kg)
    assert node.kind == "set"
    assert node.id == "garchomp_swords_dance"


def test_project_to_3d_team():
    """A list of sets should produce a kind='team' node."""
    kg = make_loaded_graph()
    team = [kg.get_set("garchomp_swords_dance"),
            kg.get_set("toxapex_defensive")]
    node = mg.project_to_3d(team, kg)
    assert node.kind == "team"
    assert len(node.member_ids) == 2
    assert math.isclose(sum(node.axis_speed_control_utility), 1.0, abs_tol=1e-9)


def test_graph_add_get():
    """add() then get() round-trips a node."""
    kg = make_loaded_graph()
    g = mg.MatchupGraph()
    node = mg.project_to_3d(kg.get_set("garchomp_swords_dance"), kg)
    g.add(node)
    assert g.get("garchomp_swords_dance") is node
    assert len(g.all()) == 1


def test_graph_build_for_ou():
    """build_for_ou should project every set in the graph."""
    kg = make_loaded_graph()
    g = mg.MatchupGraph()
    count = g.build_for_ou(kg)
    assert count == 5  # five sets in the test graph
    assert len(g.all()) == 5
    # Every set should be in the graph
    for sid in ("garchomp_swords_dance", "toxapex_defensive", "dragapult_choice",
                "corviknight_pivot", "heatran_hazard_setter"):
        assert g.get(sid) is not None


def test_graph_serialize_roundtrip():
    """to_json/from_json should preserve all nodes."""
    import json
    kg = make_loaded_graph()
    g = mg.MatchupGraph()
    g.build_for_ou(kg)
    payload = g.to_json()
    # JSON-serializable
    json.dumps(payload)
    g2 = mg.MatchupGraph.from_json(payload)
    assert len(g2.all()) == len(g.all())
    for n in g.all():
        n2 = g2.get(n.id)
        assert n2 is not None
        assert n2.axis_offdef == n.axis_offdef
        assert n2.axis_speed_control_utility == n.axis_speed_control_utility


# ═════════════════════════════════════════════════════════════════════
# Task 6: pick_best_move
# ═════════════════════════════════════════════════════════════════════

def test_pick_best_move_returns_dataclass():
    """pick_best_move returns a list of MoveRanking dataclasses."""
    kg = make_loaded_graph()
    attacker = kg.get_set("garchomp_swords_dance")
    defender = kg.get_set("toxapex_defensive")
    rankings = mg.pick_best_move(attacker, defender, kg)
    assert isinstance(rankings, list)
    assert len(rankings) > 0
    for r in rankings:
        assert isinstance(r, mg.MoveRanking)
        assert r.move_id  # non-empty
        assert isinstance(r.score, float)
        assert isinstance(r.reasoning, str)


def test_pick_best_move_scores_have_relative_order():
    """Rankings should be sorted descending by score."""
    kg = make_loaded_graph()
    attacker = kg.get_set("garchomp_swords_dance")
    defender = kg.get_set("toxapex_defensive")
    rankings = mg.pick_best_move(attacker, defender, kg)
    scores = [r.score for r in rankings]
    assert scores == sorted(scores, reverse=True)


def test_pick_best_move_uses_super_effective_stab():
    """Earthquake (Ground STAB, 2x vs Poison) should outrank Swords Dance (status, 1x)."""
    kg = make_loaded_graph()
    attacker = kg.get_set("garchomp_swords_dance")
    defender = kg.get_set("toxapex_defensive")
    rankings = mg.pick_best_move(attacker, defender, kg)
    score_by_move = {r.move_id: r.score for r in rankings}
    # Swords Dance is status, should be lowest (no damage output)
    sd_score = score_by_move.get("swordsdance", -999)
    # Earthquake should beat Swords Dance
    eq_score = score_by_move.get("earthquake", -999)
    assert eq_score > sd_score, \
        f"Earthquake ({eq_score}) should outrank Swords Dance ({sd_score})"


def test_pick_best_move_includes_status_with_reasoning():
    """Status moves (Toxic, Will-O-Wisp) should appear in rankings with reasoning."""
    kg = make_loaded_graph()
    attacker = kg.get_set("dragapult_choice")
    defender = kg.get_set("toxapex_defensive")
    rankings = mg.pick_best_move(attacker, defender, kg)
    willow = [r for r in rankings if r.move_id == "willowisp"]
    assert len(willow) == 1
    r = willow[0]
    assert "status" in r.reasoning.lower() or "utility" in r.reasoning.lower()

