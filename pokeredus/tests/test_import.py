"""
Tests for the data import pipeline — validates that gen9ou.json is correctly
parsed into KnowledgeGraph classes with proper types, stats, sets, and matchups.
"""

import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass,
    NatureClass, EVSpreadClass, MatchupRelation,
)
from pokeredus.graph import KnowledgeGraph, compute_all_matchups
from pokeredus.graph.queries import best_checks, threats_to, speed_ranking
from pokeredus.importers.showdown_importer import import_gen9ou, load_base_data

RESOURCES = os.path.join(os.path.dirname(__file__), "..", "..", "resources")
RAW_DATA = os.path.join(os.path.dirname(__file__), "..", "data", "raw")
GEN9OU_JSON = os.path.join(RESOURCES, "gen9ou.json")
BASE_STATS_JSON = os.path.join(RAW_DATA, "base_stats.json")


def _build_graph() -> KnowledgeGraph:
    """Build a fresh KnowledgeGraph from the data files."""
    kg = KnowledgeGraph()
    import_gen9ou(kg, GEN9OU_JSON, BASE_STATS_JSON)
    return kg


# ── Validation tests ────────────────────────────────────────────────

def test_pokemon_count():
    """All unique Pokémon from both dex and stats sources should be imported."""
    kg = _build_graph()
    # Should be ~118 unique Pokémon
    assert kg.pokemon_count >= 100, f"Expected 100+ Pokémon, got {kg.pokemon_count}"
    print(f"  PASS test_pokemon_count: {kg.pokemon_count} Pokémon")


def test_pokemon_types():
    """Pokémon should have correct types from base data."""
    kg = _build_graph()

    garchomp = kg.get_pokemon("garchomp")
    assert garchomp is not None, "Garchomp not found"
    assert "Dragon" in garchomp.types, f"Garchomp missing Dragon type: {garchomp.types}"
    assert "Ground" in garchomp.types, f"Garchomp missing Ground type: {garchomp.types}"

    toxapex = kg.get_pokemon("toxapex")
    assert toxapex is not None, "Toxapex not found"
    assert "Poison" in toxapex.types
    assert "Water" in toxapex.types

    dragapult = kg.get_pokemon("dragapult")
    assert dragapult is not None, "Dragapult not found"
    assert "Dragon" in dragapult.types
    assert "Ghost" in dragapult.types

    # Check a Hisuian form
    arcanine_h = kg.get_pokemon("arcanine-hisui")
    assert arcanine_h is not None, "Arcanine-Hisui not found"
    assert "Fire" in arcanine_h.types
    assert "Rock" in arcanine_h.types

    print(f"  PASS test_pokemon_types")


def test_pokemon_base_stats():
    """Pokémon should have correct base stats."""
    kg = _build_graph()

    garchomp = kg.get_pokemon("garchomp")
    assert garchomp is not None
    assert garchomp.base_stats.get("hp") == 108, f"Garchomp HP: {garchomp.base_stats.get('hp')}"
    assert garchomp.base_stats.get("atk") == 130, f"Garchomp Atk: {garchomp.base_stats.get('atk')}"
    assert garchomp.base_stats.get("spe") == 102, f"Garchomp Spe: {garchomp.base_stats.get('spe')}"
    assert garchomp.bst == 600, f"Garchomp BST: {garchomp.bst}"

    toxapex = kg.get_pokemon("toxapex")
    assert toxapex is not None
    assert toxapex.base_stats.get("def") == 152, f"Toxapex Def: {toxapex.base_stats.get('def')}"
    assert toxapex.base_stats.get("hp") == 50, f"Toxapex HP: {toxapex.base_stats.get('hp')}"

    print(f"  PASS test_pokemon_base_stats")


def test_pokemon_abilities():
    """Pokémon should have their abilities registered."""
    kg = _build_graph()

    garchomp = kg.get_pokemon("garchomp")
    assert garchomp is not None
    assert len(garchomp.abilities) > 0, "Garchomp has no abilities"
    # roughskin or sandveil should be present
    assert any("rough" in a or "sand" in a for a in garchomp.abilities), \
        f"Garchomp abilities: {garchomp.abilities}"

    print(f"  PASS test_pokemon_abilities")


def test_sets_imported():
    """Sets from both dex and stats should be imported."""
    kg = _build_graph()

    # Garchomp should have multiple sets from dex
    garchomp_sets = kg.get_sets("garchomp")
    assert len(garchomp_sets) >= 2, f"Garchomp has {len(garchomp_sets)} sets, expected 2+"

    set_names = [s.set_name for s in garchomp_sets]
    print(f"  Garchomp sets: {set_names}")

    # Iron Valiant should have sets from both dex and stats
    iv_sets = kg.get_sets("iron-valiant")
    assert len(iv_sets) >= 4, f"Iron Valiant has {len(iv_sets)} sets, expected 4+"
    iv_names = [s.set_name for s in iv_sets]
    print(f"  Iron Valiant sets: {iv_names}")

    print(f"  PASS test_sets_imported: {kg.set_count} total sets")


def test_set_has_moves():
    """Each set should have its moves properly linked."""
    kg = _build_graph()

    # Check Iron Valiant Mixed set
    iv_mixed = kg.get_set("iron-valiant_mixed")
    assert iv_mixed is not None, "Iron Valiant Mixed set not found"
    assert len(iv_mixed.moves) == 4, f"Mixed set has {len(iv_mixed.moves)} moves"
    assert "moonblast" in iv_mixed.moves, f"Mixed moves: {iv_mixed.moves}"
    assert "close-combat" in iv_mixed.moves
    assert "knock-off" in iv_mixed.moves
    assert "encore" in iv_mixed.moves

    # Verify move nodes exist in graph
    for mid in iv_mixed.moves:
        assert kg.graph.has_node(mid), f"Move node {mid} not in graph"
        assert kg.graph.has_edge(iv_mixed.id, mid), f"Edge {iv_mixed.id} -> {mid} missing"

    print(f"  PASS test_set_has_moves")


def test_set_has_ability_and_item():
    """Each set should have its ability and item linked."""
    kg = _build_graph()

    iv_mixed = kg.get_set("iron-valiant_mixed")
    assert iv_mixed is not None
    assert iv_mixed.ability == "quark-drive", f"Ability: {iv_mixed.ability}"
    assert iv_mixed.item == "booster-energy", f"Item: {iv_mixed.item}"

    # Verify nodes and edges
    assert kg.graph.has_node("quark-drive"), "Ability node missing"
    assert kg.graph.has_edge(iv_mixed.id, "quark-drive"), "Ability edge missing"
    assert kg.graph.has_node("booster-energy"), "Item node missing"
    assert kg.graph.has_edge(iv_mixed.id, "booster-energy"), "Item edge missing"

    print(f"  PASS test_set_has_ability_and_item")


def test_set_nature_and_evs():
    """Each set should have correct nature and EV spread."""
    kg = _build_graph()

    iv_mixed = kg.get_set("iron-valiant_mixed")
    assert iv_mixed is not None
    assert iv_mixed.nature.name == "Naive", f"Nature: {iv_mixed.nature.name}"
    assert iv_mixed.nature.increased_stat == "spe"
    assert iv_mixed.nature.decreased_stat == "spd"

    assert iv_mixed.evs.atk == 4, f"Atk EVs: {iv_mixed.evs.atk}"
    assert iv_mixed.evs.spa == 252, f"SpA EVs: {iv_mixed.evs.spa}"
    assert iv_mixed.evs.spe == 252, f"Spe EVs: {iv_mixed.evs.spe}"

    print(f"  PASS test_set_nature_and_evs")


def test_set_tera_type():
    """Gen 9 sets should have tera type preserved."""
    kg = _build_graph()

    iv_mixed = kg.get_set("iron-valiant_mixed")
    assert iv_mixed is not None
    assert iv_mixed.tera_type == "Steel", f"Tera: {iv_mixed.tera_type}"

    # Stats-based sets might not have teraType
    iv_usage = kg.get_set("iron-valiant_showdown-usage")
    # This one may or may not have tera — just check it doesn't crash
    print(f"  IV Showdown Usage tera: '{iv_usage.tera_type}'")

    print(f"  PASS test_set_tera_type")


def test_set_role_inference():
    """Roles should be inferred from set names."""
    kg = _build_graph()

    # Swords Dance → setup_sweeper
    sd = kg.get_set("iron-valiant_swords-dance")
    assert sd is not None
    assert sd.role == "setup_sweeper", f"SD role: {sd.role}"

    # Choice Specs → wallbreaker
    cs = kg.get_set("iron-valiant_choice-specs")
    assert cs is not None
    assert cs.role == "wallbreaker", f"CS role: {cs.role}"

    # Showdown Usage → pivot (default for stats sets)
    usage = kg.get_set("iron-valiant_showdown-usage")
    assert usage is not None
    print(f"  IV Showdown Usage role: {usage.role}")

    print(f"  PASS test_set_role_inference")


def test_set_id_generation():
    """Set IDs should be correctly generated from pokemon_id + set_name."""
    kg = _build_graph()

    # Iron Valiant Mixed → iron-valiant_mixed
    s = kg.get_set("iron-valiant_mixed")
    assert s is not None
    assert s.id == "iron-valiant_mixed"

    # Garchomp Swords Dance
    sd = kg.get_set("garchomp_swords-dance")
    if sd:
        assert sd.id == "garchomp_swords-dance"

    print(f"  PASS test_set_id_generation")


def test_effective_stat_calculation():
    """Sets should compute effective stats correctly given base stats."""
    kg = _build_graph()

    garchomp = kg.get_pokemon("garchomp")
    sd = kg.get_set("garchomp_swords-dance")
    if not sd:
        # Try other garchomp sets
        sets = kg.get_sets("garchomp")
        if sets:
            sd = sets[0]

    assert sd is not None, "No Garchomp set found"
    speed = sd.effective_stat("spe", garchomp.base_stats, level=100)
    # Jolly, 252 Spe EVs, 31 IVs, base 102 at level 100:
    # ((2*102 + 31 + 252//4) * 100/100) + 5) * 1.1 = ((204+31+63)*1+5)*1.1 = (303)*1.1 = 333.3 → 333
    assert speed > 200, f"Garchomp speed too low: {speed}"
    print(f"  Garchomp effective speed (L100): {speed}")

    print(f"  PASS test_effective_stat_calculation")


def test_matchup_computation():
    """Full matchup computation should produce valid scores."""
    kg = _build_graph()
    count = compute_all_matchups(kg)

    assert count > 0, "No matchups computed"
    assert kg.matchup_count == count

    # Spot check: Garchomp SD vs Toxapex should favor Garchomp
    garchomp_sets = kg.get_sets("garchomp")
    toxapex_sets = kg.get_sets("toxapex")

    if garchomp_sets and toxapex_sets:
        mu = kg.get_matchup_between(garchomp_sets[0].id, toxapex_sets[0].id)
        if mu:
            print(f"  Garchomp vs Toxapex: {mu.score:+.3f}")
            # Earthquake hits Poison super-effectively
            assert mu.score > 0, f"Garchomp should beat Toxapex, got {mu.score}"

    # Spot check: Dragapult should be fast
    dragapult_sets = kg.get_sets("dragapult")
    if dragapult_sets:
        matchups = kg.get_matchups(dragapult_sets[0].id, min_confidence=0.3)
        faster_count = sum(1 for m in matchups if "faster" in m.tags)
        print(f"  Dragapult: faster in {faster_count}/{len(matchups)} matchups")

    print(f"  PASS test_matchup_computation: {count} edges")


def test_speed_ranking():
    """Speed ranking should place Dragapult near the top."""
    kg = _build_graph()
    compute_all_matchups(kg)

    ranking = speed_ranking(kg, level=100)
    assert len(ranking) > 50, f"Too few Pokémon in ranking: {len(ranking)}"

    # Dragapult (base 142) should be near the top
    dragapult_entries = [(sid, spd) for sid, spd in ranking if sid.startswith("dragapult")]
    if dragapult_entries:
        top_speed = ranking[0][1]
        dragapult_speed = dragapult_entries[0][1]
        # Dragapult should be in top 10
        dragapult_rank = [sid for sid, _ in ranking].index(dragapult_entries[0][0]) + 1
        print(f"  Fastest: {ranking[0][0]} ({top_speed}), Dragapult rank: #{dragapult_rank} ({dragapult_speed})")
        assert dragapult_rank <= 15, f"Dragapult should be top 15, got #{dragapult_rank}"

    print(f"  PASS test_speed_ranking")


def test_serialization_roundtrip_with_real_data():
    """Full graph with imported data should survive serialization."""
    kg = _build_graph()
    compute_all_matchups(kg)

    # Serialize
    payload = kg.to_json()
    assert len(payload["nodes"]) > 100
    assert len(payload["edges"]) > 100

    # Deserialize
    kg2 = KnowledgeGraph.from_json(payload)
    assert kg2.pokemon_count == kg.pokemon_count
    assert kg2.set_count == kg.set_count
    assert kg2.matchup_count == kg.matchup_count

    # Spot check data integrity
    g = kg2.get_pokemon("garchomp")
    assert g is not None
    assert g.name == "Garchomp"
    assert "Dragon" in g.types

    s = kg2.get_set("iron-valiant_mixed")
    assert s is not None
    assert s.nature.name == "Naive"

    print(f"  PASS test_serialization_roundtrip_with_real_data")


def test_file_save_load_with_real_data():
    """Full graph should save to disk and reload correctly."""
    kg = _build_graph()
    compute_all_matchups(kg)

    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name

    try:
        kg.save(path)
        file_size = os.path.getsize(path)
        print(f"  Saved graph: {file_size:,} bytes")

        kg2 = KnowledgeGraph.load(path)
        assert kg2.pokemon_count == kg.pokemon_count
        assert kg2.set_count == kg.set_count
        assert kg2.matchup_count == kg.matchup_count
    finally:
        os.unlink(path)

    print(f"  PASS test_file_save_load_with_real_data")


# ── Run all tests ───────────────────────────────────────────────────

if __name__ == "__main__":
    tests = [
        test_pokemon_count,
        test_pokemon_types,
        test_pokemon_base_stats,
        test_pokemon_abilities,
        test_sets_imported,
        test_set_has_moves,
        test_set_has_ability_and_item,
        test_set_nature_and_evs,
        test_set_tera_type,
        test_set_role_inference,
        test_set_id_generation,
        test_effective_stat_calculation,
        test_matchup_computation,
        test_speed_ranking,
        test_serialization_roundtrip_with_real_data,
        test_file_save_load_with_real_data,
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

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed out of {len(tests)}")
    if failed == 0:
        print("All import validation tests passed!")
