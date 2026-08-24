"""PokeLink game-state HUD: snapshot load + idle page construct."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.gui.game_state import (
    GameStatePage,
    load_live_state,
    live_state_path,
    score_color,
    species_label,
)
from pokeredus.gui.theme import MATCHUP_LOSE, MATCHUP_WIN


def test_load_live_state_round_trip():
    payload = {
        "ts": "2026-08-25T00:00:00.000Z",
        "status": "waiting",
        "room": "battle-gen9randombattle-1",
        "dryRun": True,
        "policy": "quantum",
        "turn": 3,
        "field": {"weather": "rain", "terrain": "", "trickroom": False},
        "ours": [{"speciesId": "garchomp", "hp": 200, "maxHp": 250, "status": "", "fainted": False, "active": True, "revealed": True}],
        "theirs": [{"speciesId": "toxapex", "hp": 80, "maxHp": 250, "status": "tox", "fainted": False, "active": True, "revealed": True}],
        "eval": {
            "roundScore": 0.42,
            "forcedOutcome": "none",
            "mateProbability": 0,
            "sampledAction": "move:earthquake",
            "choices": [{"id": "move:earthquake", "type": "move", "cta": 0.9, "expectedImpact": 1.2, "choiceScore": 1.1, "probability": 1}],
        },
        "events": [{"ts": "2026-08-25T00:00:01.000Z", "text": "Turn 3"}],
    }
    with tempfile.TemporaryDirectory() as td:
        path = Path(td) / "live-state.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        loaded = load_live_state(path)
        assert loaded is not None
        assert loaded["eval"]["roundScore"] == 0.42
        assert loaded["ours"][0]["speciesId"] == "garchomp"
        assert load_live_state(path.parent / "missing.json") is None


def test_labels_and_score_color():
    assert species_label("iron-treads") == "Iron Treads"
    assert score_color(0.4) == MATCHUP_WIN
    assert score_color(-0.4) == MATCHUP_LOSE


def test_game_state_page_renders_eval():
    import tkinter as tk

    payload = {
        "ts": "t1",
        "status": "deciding",
        "room": "battle-gen9randombattle-1",
        "dryRun": True,
        "policy": "quantum",
        "turn": 2,
        "field": {"weather": "", "terrain": "", "trickroom": False},
        "ours": [{"speciesId": "garchomp", "hp": 250, "maxHp": 250, "status": "", "fainted": False, "active": True, "revealed": True}],
        "theirs": [],
        "eval": {
            "roundScore": -0.2,
            "forcedOutcome": "none",
            "mateProbability": 0,
            "sampledAction": "switch:2",
            "choices": [{"id": "switch:2", "type": "switch", "cts": 0.5, "expectedImpact": 0.1, "choiceScore": 0.05}],
        },
        "events": [{"ts": "2026-08-25T00:00:01.000Z", "text": "Garchomp used earthquake"}],
    }
    root = tk.Tk()
    root.withdraw()
    try:
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "live-state.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            page = GameStatePage(root, go_home_cb=lambda: None, state_path=path)
            page._render(payload)
            assert "roundScore" in page._eval_body.winfo_children()[0].cget("text")
            assert "sampled" in page._eval_body.winfo_children()[2].cget("text")
            log = page._log.get("1.0", "end")
            assert "Garchomp used earthquake" in log
    finally:
        root.destroy()


def test_live_state_path_env(monkeypatch, tmp_path):
    target = tmp_path / "hud.json"
    monkeypatch.setenv("POKELINK_STATE", str(target))
    assert live_state_path() == target
