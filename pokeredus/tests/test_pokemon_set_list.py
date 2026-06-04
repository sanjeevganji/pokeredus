"""
Tests for the PokemonSetList data layer (grouping + sorting).

The Tk widget itself is exercised in a separate headless smoke test.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.gui.pokemon_set_list import (
    GroupedSet, SortKey, SortOrder,
    group_sets_by_pokemon, sort_groups,
)


def _fakes():
    return [
        ("garchomp", "swords_dance", 50.0),
        ("garchomp", "choice_scarf", 70.0),
        ("ferrothorn", "defensive", 80.0),
        ("blissey", " cleric", 60.0),  # leading space intentional
    ]


def test_group_sets_by_pokemon():
    groups = group_sets_by_pokemon(_fakes())
    assert {g.pokemon_id for g in groups} == {"garchomp", "ferrothorn", "blissey"}
    garchomp = next(g for g in groups if g.pokemon_id == "garchomp")
    assert len(garchomp.sets) == 2


def test_group_preserves_insertion_order():
    groups = group_sets_by_pokemon(_fakes())
    assert [g.pokemon_id for g in groups] == ["garchomp", "ferrothorn", "blissey"]


def test_sort_groups_alpha_ascending():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.ALPHA, SortOrder.ASCENDING)
    assert [g.pokemon_id for g in groups] == ["blissey", "ferrothorn", "garchomp"]


def test_sort_groups_alpha_descending():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.ALPHA, SortOrder.DESCENDING)
    assert [g.pokemon_id for g in groups] == ["garchomp", "ferrothorn", "blissey"]


def test_sort_groups_volume_ascending():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.VOLUME, SortOrder.ASCENDING)
    # best volume per pokemon: garchomp 70, blissey 60, ferrothorn 80
    assert [g.pokemon_id for g in groups] == ["blissey", "garchomp", "ferrothorn"]


def test_sort_groups_volume_descending():
    groups = sort_groups(group_sets_by_pokemon(_fakes()),
                          SortKey.VOLUME, SortOrder.DESCENDING)
    # best volume per pokemon: ferrothorn 80, garchomp 70, blissey 60
    assert [g.pokemon_id for g in groups] == ["ferrothorn", "garchomp", "blissey"]


def test_best_set_per_pokemon():
    groups = group_sets_by_pokemon(_fakes())
    garchomp = next(g for g in groups if g.pokemon_id == "garchomp")
    assert garchomp.best_set_name == "choice_scarf"
    assert garchomp.best_volume == 70.0
    ferro = next(g for g in groups if g.pokemon_id == "ferrothorn")
    assert ferro.best_set_name == "defensive"
    assert ferro.best_volume == 80.0
    blissey = next(g for g in groups if g.pokemon_id == "blissey")
    assert blissey.best_set_name.strip() == "cleric"
    assert blissey.best_volume == 60.0


def test_set_count():
    groups = group_sets_by_pokemon(_fakes())
    counts = {g.pokemon_id: g.set_count for g in groups}
    assert counts == {"garchomp": 2, "ferrothorn": 1, "blissey": 1}


def test_empty_records():
    groups = group_sets_by_pokemon([])
    assert groups == []


# ── Tk widget smoke test ───────────────────────────────────────────

def test_widget_constructs_and_renders():
    import tkinter as tk
    from pokeredus.gui.pokemon_set_list import PokemonSetList
    root = tk.Tk(); root.withdraw()
    try:
        widget = PokemonSetList(root)
        widget.refresh(_fakes())
        # After refresh the tree should have 3 pokemon rows in alpha
        # order (default), the first one expanded.
        kids = widget._tree.get_children("")
        assert len(kids) == 3
        labels = [widget._tree.item(k, "text").strip("▶▼ ").strip()
                  for k in kids]
        assert labels == ["blissey", "ferrothorn", "garchomp"]
        first_open = widget._tree.item(kids[0], "open")
        assert first_open == 1 or first_open is True
        # garchomp has 2 child set rows; find that group.
        garchomp_iid = next(k for k in kids
                             if widget._tree.item(k, "text").endswith("garchomp"))
        set_rows = widget._tree.get_children(garchomp_iid)
        assert len(set_rows) == 2
    finally:
        root.destroy()


def test_widget_sort_change_triggers_repopulate():
    import tkinter as tk
    from pokeredus.gui.pokemon_set_list import PokemonSetList, SortOrder
    root = tk.Tk(); root.withdraw()
    try:
        widget = PokemonSetList(root)
        widget.refresh(_fakes())
        widget._order_var.set(SortOrder.DESCENDING.value)
        kids = widget._tree.get_children("")
        # alpha desc → garchomp first
        assert widget._tree.item(kids[0], "text").endswith("garchomp")
    finally:
        root.destroy()
