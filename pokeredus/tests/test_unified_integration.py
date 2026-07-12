"""
Integration tests for the PokeRedus unified core.

Exercises the public surface end-to-end with a small synthetic KG (no
89MB matchup graph needed for fast CI runs). Verifies:

  * UnifiedState can project from sets, games, and matchup views
  * render_scene produces identically-shaped text in all 3 modes
  * parse_scene round-trips the compact form
  * SerializedSnapshot builds, serializes, round-trips
  * recommend_actions wraps pick_best_move + find_optimal_switch
  * export_training_corpus writes parseable JSONL
  * PlainTextScene and UnifiedAction carry the fields a model needs

Run:
    python tests/test_unified_integration.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PACKAGE_ROOT))

from pokeredus.unified import (
    UnifiedAction, UnifiedState, UnifiedTeamSlot,
    render_scene, parse_scene, recommend_actions,
    SerializedSnapshot, training_samples_from_actions,
    export_training_corpus, PlainTextScene, TrainingSample,
)
from pokeredus.graph.game_state import PokemonState
from pokeredus.classes.moves import MoveClass
from pokeredus.classes.pokemon import PokemonClass
from pokeredus.classes.sets import SetClass
from pokeredus.classes.natures import NatureClass
from pokeredus.classes.ev_spread import EVSpreadClass


# ═══════════════════════════════════════════════════════════════════════
# Synthetic fixtures — minimal but real classes
# ═══════════════════════════════════════════════════════════════════════


def build_klass_set(pokemon_id, name, types, base_stats, set_name, moves,
                     ability, item, nature_name, evs):
    nature = NatureClass(name=nature_name, increased_stat="spe", decreased_stat="spa")
    ev = EVSpreadClass(**evs, label="")
    return SetClass(
        id=f"{pokemon_id}_{set_name.lower().replace(' ', '_')}",
        pokemon_id=pokemon_id,
        set_name=set_name,
        ability=ability,
        item=item,
        nature=nature,
        evs=ev,
        moves=moves,
        tera_type="Steel",
        role="sweeper",
    )


def build_klass_pokemon(pid, name, types, base_stats, abilities):
    return PokemonClass(
        id=pid, name=name, types=types, base_stats=base_stats,
        abilities=abilities, tier="OU",
    )


def assert_eq(actual, expected, msg):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


# ═══════════════════════════════════════════════════════════════════════
# Test cases
# ═══════════════════════════════════════════════════════════════════════


def test_render_in_all_modes():
    """Rendering across compact / verbose / tokens produces consistent data."""
    mon = build_klass_pokemon(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        ["roughskin"],
    )
    s = build_klass_set(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        "Choice Scarf", ["earthquake"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )

    class KG:
        def __init__(self):
            self._set = s; self._mon = mon
        def get_set(self, sid): return self._set if sid == s.id else None
        def get_pokemon(self, pid): return self._mon if pid == mon.id else None
        def get_move(self, mid): return None  # not tested here
        def get_sets(self, pid): return [self._set] if pid == "garchomp" else []
        def get_all_pokemon(self): return [self._mon]

    kg = KG()
    ps = PokemonState(pokemon_id="garchomp", set_id=s.id, current_hp=300, max_hp=300)
    state = UnifiedState(
        team_a=[UnifiedTeamSlot(0, "garchomp", s.id, ps)],
        active_a=0, turn=1, side_to_move="a",
    )

    compact = render_scene(state, kg, "compact").text
    verbose = render_scene(state, kg, "verbose").text
    tokens = render_scene(state, kg, "tokens").text

    # Compact and verbose should preserve the human-readable pokemon name;
    # tokens mode intentionally uses slugified tokens.
    for label in ("Garchomp", "Choice Scarf", "[A]"):
        if label not in compact:
            raise AssertionError(f"compact missing {label!r}")
        if label not in verbose:
            raise AssertionError(f"verbose missing {label!r}")

    # Tokens mode uses _slugify which lower-cases alphanumeric chars and
    # collapses spaces/underscores. The set_name("*scarf") appears as
    # "_scarf" suffix, so we check garchomp + scarf as substrings.
    if "garchomp" not in tokens:
        raise AssertionError(f"tokens missing slugified pokemon: {tokens!r}")
    if "scarf" not in tokens:
        raise AssertionError(f"tokens missing slug set name: {tokens!r}")

    # Verbose is the only one with multi-line structure
    if "\n" not in verbose:
        raise AssertionError("verbose should be multi-line")

    print("  ✓ test_render_in_all_modes")


def test_parse_round_trip():
    """Compact text round-trips back to the same scene structure."""
    mon = build_klass_pokemon(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        ["roughskin"],
    )
    s = build_klass_set(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        "Choice Scarf", ["earthquake"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )

    class KG:
        def __init__(self):
            self._set = s; self._mon = mon
        def get_set(self, sid): return self._set if sid == s.id else None
        def get_pokemon(self, pid): return self._mon if pid == mon.id else None
        def get_move(self, mid): return None
        def get_sets(self, pid): return [self._set] if pid == "garchomp" else []
        def get_all_pokemon(self): return [self._mon]

    kg = KG()
    ps = PokemonState(pokemon_id="garchomp", set_id=s.id, current_hp=300, max_hp=300)
    state = UnifiedState(
        team_a=[UnifiedTeamSlot(0, "garchomp", s.id, ps)],
        active_a=0, turn=1, side_to_move="a",
    )

    compact = render_scene(state, kg, "compact").text
    recon = parse_scene(compact, kg)
    if len(recon.team_a) != 1:
        raise AssertionError(f"expected 1 slot, got {len(recon.team_a)}")
    if recon.team_a[0].set_id != s.id:
        raise AssertionError(f"set_id mismatch: {recon.team_a[0].set_id} vs {s.id}")
    if recon.active_a != 0:
        raise AssertionError(f"active_a mismatch: {recon.active_a}")
    print("  ✓ test_parse_round_trip")


def test_snapshot_round_trip():
    """SerializedSnapshot builds, JSON-serializes, parses back identically."""
    s = build_klass_set(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        "Choice Scarf", ["earthquake"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )
    mv = MoveClass(
        id="earthquake", name="Earthquake", type="Ground",
        category="Physical", base_power=100, accuracy=100, pp=10,
        priority=0, flags={},
    )
    mon = build_klass_pokemon(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102},
        ["roughskin"],
    )

    class KG:
        def __init__(self):
            self.sets = {s.id: s}; self.mons = {mon.id: mon}
            self.moves = {mv.id: mv}
        def get_set(self, sid): return self.sets.get(sid)
        def get_pokemon(self, pid): return self.mons.get(pid)
        def get_move(self, mid): return self.moves.get(mid)
        def get_sets(self, pid): return [v for v in self.sets.values() if v.pokemon_id == pid]
        def get_all_pokemon(self): return list(self.mons.values())

    kg = KG()
    state = UnifiedState(
        team_a=[UnifiedTeamSlot(0, "garchomp", s.id,
            PokemonState("garchomp", s.id, 250, 300))],
        active_a=0, turn=1, side_to_move="a",
    )

    snap = SerializedSnapshot.build(state, kg)
    if s.id not in snap.set_lookup:
        raise AssertionError("set_lookup missing the set")
    if mon.id not in snap.pokemon_lookup:
        raise AssertionError("pokemon_lookup missing the pokemon")

    j = snap.to_json()
    snap2 = SerializedSnapshot.from_json(j)
    if set(snap2.set_lookup.keys()) != set(snap.set_lookup.keys()):
        raise AssertionError("snapshot round-trip lost sets")
    if snap2.pokemon_lookup != snap.pokemon_lookup:
        raise AssertionError("snapshot round-trip lost pokemon data")
    if snap2.move_lookup != snap.move_lookup:
        raise AssertionError("snapshot round-trip lost move data")

    # Write to a temp file and read back via .read() as well
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as tmp:
        tmp.write(j)
        tmp_path = Path(tmp.name)
    snap3 = SerializedSnapshot.read(tmp_path)
    tmp_path.unlink()
    if snap3.set_lookup != snap.set_lookup:
        raise AssertionError("SerializedSnapshot.read() doesn't match serialised form")
    print("  ✓ test_snapshot_round_trip")


def test_recommend_actions_returns_ranked():
    """recommend_actions produces a sorted list with the recommendation flagged."""
    # Same fixture pattern as the manual integration check
    gmove = MoveClass(id="earthquake", name="Earthquake", type="Ground",
                       category="Physical", base_power=100, accuracy=100, pp=10, priority=0, flags={})
    gmove2 = MoveClass(id="outrage", name="Outrage", type="Dragon",
                        category="Physical", base_power=120, accuracy=100, pp=10, priority=0, flags={})
    skmove = MoveClass(id="bravebird", name="Brave Bird", type="Flying",
                        category="Physical", base_power=120, accuracy=100, pp=15, priority=0, flags={})
    skmove2 = MoveClass(id="ironhead", name="Iron Head", type="Steel",
                         category="Physical", base_power=80, accuracy=100, pp=15, priority=0, flags={})

    g_mon = build_klass_pokemon(
        "garchomp", "Garchomp", ["Dragon", "Ground"],
        {"hp":108,"atk":130,"def":95,"spa":80,"spd":85,"spe":102},
        ["roughskin"],
    )
    sk_mon = build_klass_pokemon(
        "skarmory", "Skarmory", ["Steel", "Flying"],
        {"hp":65,"atk":80,"def":140,"spa":40,"spd":70,"spe":70},
        ["sturdy"],
    )
    g_set = build_klass_set(
        "garchomp", "Garchomp", ["Dragon","Ground"],
        {"hp":108,"atk":130,"def":95,"spa":80,"spd":85,"spe":102},
        "Choice Scarf", ["earthquake","outrage"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )
    sk_set = build_klass_set(
        "skarmory", "Skarmory", ["Steel","Flying"],
        {"hp":65,"atk":80,"def":140,"spa":40,"spd":70,"spe":70},
        "PhysDef", ["bravebird","ironhead"], "sturdy", "rockyhelmet",
        "Bold", dict(hp=252, atk=0, def_=252, spa=0, spd=0, spe=0),
    )

    class KG:
        def __init__(self):
            self.sets = {g_set.id: g_set, sk_set.id: sk_set}
            self.mons = {g_mon.id: g_mon, sk_mon.id: sk_mon}
            self.moves = {
                gmove.id: gmove, gmove2.id: gmove2,
                skmove.id: skmove, skmove2.id: skmove2,
            }
        def get_set(self, sid): return self.sets.get(sid)
        def get_pokemon(self, pid): return self.mons.get(pid)
        def get_move(self, mid): return self.moves.get(mid)
        def get_sets(self, pid): return [v for v in self.sets.values() if v.pokemon_id == pid]
        def get_all_pokemon(self): return list(self.mons.values())
        def get_matchup_between(self, a, b): return None

    kg = KG()
    state = UnifiedState(
        team_a=[UnifiedTeamSlot(0, g_set.pokemon_id, g_set.id,
            PokemonState(g_set.pokemon_id, g_set.id, 300, 300))],
        team_b=[UnifiedTeamSlot(0, sk_set.pokemon_id, sk_set.id,
            PokemonState(sk_set.pokemon_id, sk_set.id, 240, 240))],
        active_a=0, active_b=0, turn=5, side_to_move="a",
    )

    actions = recommend_actions(state, kg)
    if len(actions) < 1:
        raise AssertionError("no actions returned")
    if not actions[0].is_recommended:
        raise AssertionError("first action should be flagged as recommended")

    # Scores should be in descending order
    for a, b in zip(actions, actions[1:]):
        if a.score < b.score:
            raise AssertionError(
                f"actions not sorted descending: {a.score} < {b.score}"
            )

    # Garchomp's Ground move vs Skarmory (Steel/Flying) is immune
    ground_action = next(
        (a for a in actions if a.detail.get("move_id") == "earthquake"), None,
    )
    if ground_action is None or ground_action.score >= 0:
        raise AssertionError(
            "expected Earthquake to be downgraded by immunity check"
        )
    print("  ✓ test_recommend_actions_returns_ranked")


def test_export_training_corpus():
    """export_training_corpus writes valid JSONL with all required keys."""
    s = build_klass_set(
        "garchomp", "Garchomp", ["Dragon","Ground"],
        {"hp":108,"atk":130,"def":95,"spa":80,"spd":85,"spe":102},
        "Choice Scarf", ["earthquake"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )
    mv = MoveClass(id="earthquake", name="Earthquake", type="Ground",
                   category="Physical", base_power=100, accuracy=100, pp=10, priority=0, flags={})
    mon = build_klass_pokemon(
        "garchomp", "Garchomp", ["Dragon","Ground"],
        {"hp":108,"atk":130,"def":95,"spa":80,"spd":85,"spe":102},
        ["roughskin"],
    )

    class KG:
        def __init__(self):
            self.sets = {s.id: s}; self.mons = {mon.id: mon}; self.moves = {mv.id: mv}
        def get_set(self, sid): return self.sets.get(sid)
        def get_pokemon(self, pid): return self.mons.get(pid)
        def get_move(self, mid): return self.moves.get(mid)
        def get_sets(self, pid): return [v for v in self.sets.values() if v.pokemon_id == pid]
        def get_all_pokemon(self): return list(self.mons.values())
        def get_matchup_between(self, a, b): return None

    kg = KG()
    state = UnifiedState(
        team_a=[UnifiedTeamSlot(0, "garchomp", s.id,
            PokemonState("garchomp", s.id, 300, 300))],
        active_a=0, turn=1, side_to_move="a",
    )
    a = UnifiedAction(
        kind="move", label="Earthquake",
        detail={"move_id": "earthquake"}, score=2.5, is_recommended=True,
    )

    with tempfile.NamedTemporaryFile(suffix=".jsonl", delete=False, mode="w") as tmp:
        path = Path(tmp.name)
    try:
        n = export_training_corpus([(state, [a])], kg, path, mode="compact")
        if n != 1:
            raise AssertionError(f"expected 1 line, got {n}")

        lines = path.read_text().splitlines()
        if len(lines) != 1:
            raise AssertionError(f"expected 1 line, got {len(lines)}")

        sample = json.loads(lines[0])
        required = {"scene_text", "action_text", "mode", "turn", "side_to_move"}
        missing = required - set(sample.keys())
        if missing:
            raise AssertionError(f"missing keys: {missing}")
        if sample["action_text"] != "move:earthquake":
            raise AssertionError(f"unexpected action_text: {sample['action_text']!r}")
    finally:
        path.unlink()
    print("  ✓ test_export_training_corpus")


def test_unified_action_text_form():
    """UnifiedAction.to_text renders compact and verbose forms consistently."""
    a = UnifiedAction(
        kind="move", label="Earthquake",
        detail={"move_id": "earthquake", "move_type": "Ground",
                "category": "Physical", "base_power": 100, "priority": 0,
                "is_status": False},
        score=1.5,
    )
    if a.to_text(compact=True) != "move:earthquake":
        raise AssertionError(f"compact wrong: {a.to_text(compact=True)!r}")
    verbose = a.to_text(compact=False)
    for piece in ("earthquake", "Ground", "Physical", "BP=100"):
        if piece not in verbose:
            raise AssertionError(f"verbose missing {piece!r}: {verbose!r}")

    b = UnifiedAction(kind="switch", label="Switch to Dragapult",
                       detail={"pokemon_id": "dragapult"})
    if b.to_text(compact=True) != "switch:dragapult":
        raise AssertionError(f"switch compact wrong: {b.to_text(compact=True)!r}")

    c = UnifiedAction(kind="tera", label="Terastallize to Steel",
                       detail={"tera_type": "Steel"})
    if c.to_text(compact=True) != "tera:Steel":
        raise AssertionError(f"tera compact wrong: {c.to_text(compact=True)!r}")
    print("  ✓ test_unified_action_text_form")


def test_unified_state_from_matchup_projection():
    """UnifiedState.from_matchup builds a static-scene projection of two teams."""
    s = build_klass_set(
        "garchomp", "Garchomp", ["Dragon","Ground"],
        {"hp":108,"atk":130,"def":95,"spa":80,"spd":85,"spe":102},
        "Choice Scarf", ["earthquake"], "roughskin", "choicescarf",
        "Jolly", dict(hp=0, atk=252, def_=0, spa=0, spd=0, spe=252),
    )
    opp = build_klass_set(
        "skarmory", "Skarmory", ["Steel","Flying"],
        {"hp":65,"atk":80,"def":140,"spa":40,"spd":70,"spe":70},
        "PhysDef", ["bravebird"], "sturdy", "rockyhelmet",
        "Bold", dict(hp=252, atk=0, def_=252, spa=0, spd=0, spe=0),
    )

    class KG:
        def get_sets(self, pid): return []  # not needed here
    state = UnifiedState.from_matchup([s], [opp], KG())
    if len(state.team_a) != 1:
        raise AssertionError("team_a should have 1 slot")
    if len(state.team_b) != 1:
        raise AssertionError("team_b should have 1 slot")
    if state.notes.get("projection") != "matchup":
        raise AssertionError("projection note missing")
    print("  ✓ test_unified_state_from_matchup_projection")


# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════


def main():
    print("Running unified core integration tests…")
    test_render_in_all_modes()
    test_parse_round_trip()
    test_snapshot_round_trip()
    test_recommend_actions_returns_ranked()
    test_export_training_corpus()
    test_unified_action_text_form()
    test_unified_state_from_matchup_projection()
    print("All unified-core integration tests passed.")


if __name__ == "__main__":
    main()
