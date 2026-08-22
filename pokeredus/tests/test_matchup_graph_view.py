"""Characterization tests for the team-builder radial matchup graph view."""

import os
import sys
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest


def test_attribute_angle_spaced_at_45_deg():
    from pokeredus.gui.matchup_graph_view import attribute_angle
    for i in range(8):
        assert attribute_angle(i) == pytest.approx(i * math.pi / 4)


def test_sector_points_returns_spoke_or_wedge():
    from pokeredus.gui.matchup_graph_view import sector_points
    spoke = sector_points(0, 0, 10, 0.0)
    assert spoke[0] == 0 and spoke[1] == 0
    assert spoke[2] == pytest.approx(10.0)
    wedge = sector_points(0, 0, 10, math.pi / 2, half_width=0.1)
    assert len(wedge) == 6


def test_team_radial_formulas_load_from_repo_config():
    from pokeredus.config import CONFIG_DIR
    from pokeredus.gui.matchup_graph_view import load_team_radial_formulas
    formulas = load_team_radial_formulas()
    assert (CONFIG_DIR / "team_radial_formulas.json").exists()
    assert formulas["coverage_exponent"] == 1.5
    assert formulas["score_aggregation"] == "sum"


def test_radial_page_classes_exist():
    from pokeredus.gui.matchup_graph_view import (
        TeamRadialGraph, MatchupGraphPage, PokemonRadialScores, TeamRadialData,
    )
    assert TeamRadialGraph is not None
    assert MatchupGraphPage is not None
    assert PokemonRadialScores is not None
    assert TeamRadialData is not None
