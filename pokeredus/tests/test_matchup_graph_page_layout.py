"""
Smoke tests for the revamped MatchupGraphPage layout.

Verifies that the page constructs with the three-pane layout
(list left, view center, tuner right) and that the key widgets are
accessible.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tkinter as tk
import pytest


def test_page_constructs_with_three_panes():
    from pokeredus.gui.matchup_graph_view import MatchupGraphPage
    root = tk.Tk(); root.withdraw()
    try:
        page = MatchupGraphPage(root, kg=None)
        assert hasattr(page, "_list"), "missing _list (PokemonSetList)"
        assert hasattr(page, "_tuner"), "missing _tuner (AttributeTuner)"
        assert hasattr(page, "_view"), "missing _view (MatchupGraphView)"
    finally:
        root.destroy()


def test_page_default_tuning_is_unity():
    from pokeredus.gui.matchup_graph_view import MatchupGraphPage
    from pokeredus.graph.attribute_engine import AttributeTuning
    root = tk.Tk(); root.withdraw()
    try:
        page = MatchupGraphPage(root, kg=None)
        assert isinstance(page._tuning, AttributeTuning)
        assert page._tuning.axis_attack == 1.0
        assert page._tuning.compound_threat == 1.0
    finally:
        root.destroy()


def test_page_list_starts_empty_without_kg():
    from pokeredus.gui.matchup_graph_view import MatchupGraphPage
    root = tk.Tk(); root.withdraw()
    try:
        page = MatchupGraphPage(root, kg=None)
        # Without a kg, the list has no pokemon groups.
        assert page._list._groups == []
    finally:
        root.destroy()
