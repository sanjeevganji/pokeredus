"""
Tests for the KnowledgeGraph container — add, query, remove, serialization.
"""

import json
import os
import sys
import tempfile

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass,
    NatureClass, EVSpreadClass, MatchupRelation,
)
from pokeredus.graph import KnowledgeGraph, compute_matchup, compute_all_matchups
from pokeredus.graph import (
    best_checks, best_counters, threats_to, weaknesses_of,
    gaps, speed_ranking, role_summary,
)


# ── Fixtures ────────────────────────────────────────────────────────

def _make_garchomp() -> PokemonClass:
    return PokemonClass(
        id="garchomp", name="Garchomp",
        types=["Dragon", "Ground"],
        base_stats={"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        abilities=["sandveil", "roughskin"], weight=95.0, tier="OU",
    )

def _make_toxapex() -> PokemonClass:
    return PokemonClass(
        id="toxapex", name="Toxapex",
        types=["Poison", "Water"],
        base_stats={"hp": 50, "atk": 63, "def": 152, "spa": 53, "spd": 142, "spe": 35},
        abilities=["merciless", "limber", "regenerator"], weight=14.5, tier="OU",
    )

def _make_dragapult() -> PokemonClass:
    return PokemonClass(
        id="dragapult", name="Dragapult",
        types=["Dragon", "Ghost"],
        base_stats={"hp": 88, "atk": 120, "def": 75, "spa": 100, "spd": 75, "spe": 142},
        abilities=["clearbody", "infiltrator"], weight=50.0, tier="OU",
    )

def _make_garchomp_sd_set() -> SetClass:
    return SetClass(
        id="garchomp_swordsdance", pokemon_id="garchomp",
        set_name="Swords Dance", ability="roughskin", item="loadeddice",
        nature=NatureClass("Jolly", "spe", "spa"),
        evs=EVSpreadClass(252, 0, 0, 0, 4, 252, "252 Atk / 4 SpD / 252 Spe"),
        moves=["swordsdance", "earthquake", "scale shot", "fire fang"],
        role="setup_sweeper", tera_type="Steel",
    )

def _make_toxapex_def_set() -> SetClass:
    return SetClass(
        id="toxapex_defensive", pokemon_id="toxapex",
        set_name="Defensive", ability="regenerator", item="blacksludge",
        nature=NatureClass("Bold", "def", "atk"),
        evs=EVSpreadClass(252, 0, 252, 0, 4, 0, "252 HP / 252 Def / 4 SpD"),
        moves=["scald", "haze", "recover", "toxic spikes"],
        role="wall", tera_type="Water",
    )

def _make_dragapult_cb_set() -> SetClass:
    return SetClass(
        id="dragapult_choiceband", pokemon_id="dragapult",
        set_name="Choice Band", ability="infiltrator", item="choiceband",
        nature=NatureClass("Jolly", "spe", "spa"),
        evs=EVSpreadClass(0, 252, 0, 0, 4, 252, "252 Atk / 4 SpD / 252 Spe"),
        moves=["dragon darts", "phantom force", "sucker punch", "u-turn"],
        role="wallbreaker", tera_type="Ghost",
    )

def _make_moves() -> list[MoveClass]:
    return [
        MoveClass("earthquake", "Earthquake", "Ground", "Physical", base_power=100),
        MoveClass("swordsdance", "Swords Dance", "Normal", "Status"),
        MoveClass("scale shot", "Scale Shot", "Dragon", "Physical", base_power=25, accuracy=100),
        MoveClass("fire fang", "Fire Fang", "Fire", "Physical", base_power=65, flags=["contact", "bite"]),
        MoveClass("scald", "Scald", "Water", "Special", base_power=80),
        MoveClass("haze", "Haze", "Poison", "Status"),
        MoveClass("recover", "Recover", "Normal", "Status"),
        MoveClass("toxic spikes", "Toxic Spikes", "Poison", "Status"),
        MoveClass("dragon darts", "Dragon Darts", "Dragon", "Physical", base_power=50),
        MoveClass("phantom force", "Phantom Force", "Ghost", "Physical", base_power=90, flags=["contact"]),
        MoveClass("sucker punch", "Sucker Punch", "Dark", "Physical", base_power=70, priority=1),
        MoveClass("u-turn", "U-turn", "Bug", "Physical", base_power=70),
    ]


def _build_test_graph() -> KnowledgeGraph:
    """Build a small knowledge graph with 3 Pokémon, 3 sets, and moves."""
    kg = KnowledgeGraph()

    for p in [_make_garchomp(), _make_toxapex(), _make_dragapult()]:
        kg.add_pokemon(p)

    for m in _make_moves():
        kg.add_move(m)

    for s in [_make_garchomp_sd_set(), _make_toxapex_def_set(), _make_dragapult_cb_set()]:
        kg.add_set(s)

    return kg


# ── Tests ───────────────────────────────────────────────────────────

def test_add_pokemon_and_retrieve():
    kg = KnowledgeGraph()
    garchomp = _make_garchomp()
    kg.add_pokemon(garchomp)

    assert kg.pokemon_count == 1
    retrieved = kg.get_pokemon("garchomp")
    assert retrieved is not None
    assert retrieved.name == "Garchomp"
    assert "Dragon" in retrieved.types
    assert "Ground" in retrieved.types
    # Check has_type edges
    assert kg.graph.has_edge("garchomp", "type:dragon")
    assert kg.graph.has_edge("garchomp", "type:ground")
    print("  PASS test_add_pokemon_and_retrieve")


def test_add_set_and_query_by_pokemon():
    kg = _build_test_graph()

    sets = kg.get_sets("garchomp")
    assert len(sets) == 1
    assert sets[0].set_name == "Swords Dance"
    assert sets[0].pokemon_id == "garchomp"

    sets_t = kg.get_sets("toxapex")
    assert len(sets_t) == 1
    assert sets_t[0].role == "wall"

    # Edges to moves
    assert kg.graph.has_edge("garchomp_swordsdance", "earthquake")
    assert kg.graph.has_edge("garchomp_swordsdance", "swordsdance")
    # Edge to ability
    assert kg.graph.has_edge("garchomp_swordsdance", "roughskin")
    # Edge to item
    assert kg.graph.has_edge("garchomp_swordsdance", "loadeddice")
    # Edge to nature
    assert kg.graph.has_edge("garchomp_swordsdance", "jolly")
    print("  PASS test_add_set_and_query_by_pokemon")


def test_add_matchup_and_query():
    kg = _build_test_graph()

    mu = MatchupRelation(
        set_a_id="garchomp_swordsdance",
        set_b_id="toxapex_defensive",
        score=-0.6,
        confidence=0.7,
        source="manual",
        tags=["hard_walled"],
    )
    kg.add_matchup(mu)

    assert kg.matchup_count == 1

    # Outbound from garchomp
    matchups = kg.get_matchups("garchomp_swordsdance", min_confidence=0.5)
    assert len(matchups) == 1
    assert matchups[0].set_b_id == "toxapex_defensive"
    assert matchups[0].score == -0.6

    # Inbound to toxapex
    inbound = kg.get_matchups_against("toxapex_defensive", min_confidence=0.5)
    assert len(inbound) == 1
    assert inbound[0].set_a_id == "garchomp_swordsdance"

    # Direct lookup
    direct = kg.get_matchup_between("garchomp_swordsdance", "toxapex_defensive")
    assert direct is not None
    assert direct.score == -0.6
    print("  PASS test_add_matchup_and_query")


def test_remove_set():
    kg = _build_test_graph()
    kg.add_matchup(MatchupRelation("garchomp_swordsdance", "toxapex_defensive", score=-0.5))

    assert kg.set_count == 3
    kg.remove_set("garchomp_swordsdance")
    assert kg.set_count == 2
    assert kg.get_set("garchomp_swordsdance") is None
    # Matchup edge should be gone
    assert kg.get_matchup_between("garchomp_swordsdance", "toxapex_defensive") is None
    print("  PASS test_remove_set")


def test_serialization_roundtrip():
    kg = _build_test_graph()
    kg.add_matchup(MatchupRelation("garchomp_swordsdance", "toxapex_defensive", score=-0.5, confidence=0.7))
    kg.add_matchup(MatchupRelation("dragapult_choiceband", "garchomp_swordsdance", score=0.3, confidence=0.6))

    # Serialize
    payload = kg.to_json()
    assert isinstance(payload, dict)
    assert len(payload["nodes"]) > 0
    assert len(payload["edges"]) > 0

    # Deserialize
    kg2 = KnowledgeGraph.from_json(payload)
    assert kg2.pokemon_count == kg.pokemon_count
    assert kg2.set_count == kg.set_count
    assert kg2.matchup_count == kg.matchup_count

    # Verify data integrity
    g = kg2.get_pokemon("garchomp")
    assert g is not None
    assert g.name == "Garchomp"

    s = kg2.get_set("garchomp_swordsdance")
    assert s is not None
    assert s.item == "loadeddice"

    mu = kg2.get_matchup_between("garchomp_swordsdance", "toxapex_defensive")
    assert mu is not None
    assert mu.score == -0.5
    print("  PASS test_serialization_roundtrip")


def test_file_save_load():
    kg = _build_test_graph()
    kg.add_matchup(MatchupRelation("garchomp_swordsdance", "toxapex_defensive", score=-0.5))

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name

    try:
        kg.save(path)
        kg2 = KnowledgeGraph.load(path)
        assert kg2.pokemon_count == 3
        assert kg2.set_count == 3
        assert kg2.matchup_count == 1
        assert kg2.get_pokemon("garchomp").name == "Garchomp"
    finally:
        os.unlink(path)
    print("  PASS test_file_save_load")


def test_ou_filter():
    kg = KnowledgeGraph()
    ou_mon = _make_garchomp()
    uu_mon = PokemonClass(id="someuu", name="SomeUU", types=["Normal"],
                          base_stats={"hp":80,"atk":80,"def":80,"spa":80,"spd":80,"spe":80},
                          tier="UU")
    kg.add_pokemon(ou_mon)
    kg.add_pokemon(uu_mon)

    ou_list = kg.get_ou_pokemon()
    assert len(ou_list) == 1
    assert ou_list[0].id == "garchomp"
    print("  PASS test_ou_filter")


def test_summary():
    kg = _build_test_graph()
    s = kg.summary()
    assert "3 Pokémon" in s
    assert "3 sets" in s
    print("  PASS test_summary")


def test_compute_matchup():
    kg = _build_test_graph()

    garchomp_sd = kg.get_set("garchomp_swordsdance")
    toxapex_def = kg.get_set("toxapex_defensive")

    mu = compute_matchup(garchomp_sd, toxapex_def, kg)
    assert -1.0 <= mu.score <= 1.0
    assert mu.source == "ttk_calc"  # Phase 5: TTK-based scoring
    assert mu.confidence >= 0.3
    # Garchomp (Dragon/Ground) vs Toxapex (Poison/Water):
    # Earthquake hits Poison super-effectively, Water neutrally
    # Scald hits Dragon neutrally, Ground normally
    # Garchomp should have the type advantage
    print(f"  Garchomp SD vs Toxapex Def: score={mu.score:+.3f} tags={mu.tags}")
    print("  PASS test_compute_matchup")


def test_compute_all_matchups():
    kg = _build_test_graph()
    count = compute_all_matchups(kg)
    # 3 sets × 2 opponents = 6 matchups
    assert count == 6
    assert kg.matchup_count == 6

    # Verify all pairs exist
    sets = kg.get_all_sets()
    for a in sets:
        for b in sets:
            if a.id != b.id:
                mu = kg.get_matchup_between(a.id, b.id)
                assert mu is not None, f"Missing matchup {a.id} vs {b.id}"
    print("  PASS test_compute_all_matchups")


def test_queries():
    kg = _build_test_graph()
    compute_all_matchups(kg)

    # best_checks / best_counters
    checks = best_checks(kg, "toxapex_defensive", top_n=3)
    print(f"  Checks vs Toxapex: {[(c.set_a_id, c.score) for c in checks]}")

    # threats_to
    threats = threats_to(kg, "garchomp_swordsdance", top_n=3)
    print(f"  Garchomp threatens: {[(t.set_b_id, t.score) for t in threats]}")

    # weaknesses_of
    weak = weaknesses_of(kg, "garchomp_swordsdance", top_n=3)
    print(f"  Garchomp weak to: {[(w.set_b_id, w.score) for w in weak]}")

    # speed_ranking
    ranking = speed_ranking(kg)
    print(f"  Speed ranking: {ranking}")

    # role_summary
    roles = role_summary(kg, ["garchomp_swordsdance", "toxapex_defensive", "dragapult_choiceband"])
    print(f"  Roles: {roles}")

    print("  PASS test_queries")


def test_set_yaml_save():
    kg = _build_test_graph()
    with tempfile.TemporaryDirectory() as tmpdir:
        path = kg.save_set_yaml(kg.get_set("garchomp_swordsdance"), tmpdir)
        assert os.path.exists(path)
        import yaml
        with open(path) as f:
            data = yaml.safe_load(f)
        assert data["pokemon_id"] == "garchomp"
        assert data["set_name"] == "Swords Dance"
    print("  PASS test_set_yaml_save")


# ── Run all tests ───────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_add_pokemon_and_retrieve,
        test_add_set_and_query_by_pokemon,
        test_add_matchup_and_query,
        test_remove_set,
        test_serialization_roundtrip,
        test_file_save_load,
        test_ou_filter,
        test_summary,
        test_compute_matchup,
        test_compute_all_matchups,
        test_queries,
        test_set_yaml_save,
    ]

    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"  FAIL {t.__name__}: {e}")
            failed += 1

    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)}")
    if failed == 0:
        print("All tests passed!")
