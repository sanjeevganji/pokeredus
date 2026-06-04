"""
Tests for the AttributeTuner slider widget.

Headless tests cover the slider value <-> float helpers.  A smoke test
constructs the widget in a withdrawn Tk root.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus.gui.attribute_tuner import (
    format_slider_value, parse_slider_value,
    SLIDER_MIN, SLIDER_MAX, SLIDER_SCALE,
)


def test_format_and_parse_roundtrip():
    for raw in (0.0, 0.5, 1.0, 1.5, 2.0):
        s = format_slider_value(raw)
        assert SLIDER_MIN <= s <= SLIDER_MAX
        assert abs(parse_slider_value(s) - raw) < 0.01


def test_format_clamps_to_range():
    assert format_slider_value(-1.0) == SLIDER_MIN
    assert format_slider_value(10.0) == SLIDER_MAX


def test_parse_clamps_to_range():
    assert parse_slider_value(-100) <= 0.0
    assert parse_slider_value(10000) >= 1.5  # capped at MAX/100 = 2.0


def test_widget_constructs_and_fires_callback():
    import tkinter as tk
    from pokeredus.gui.attribute_tuner import AttributeTuner
    from pokeredus.graph.attribute_engine import AttributeTuning
    root = tk.Tk(); root.withdraw()
    try:
        seen = []
        tuner = AttributeTuner(
            root, tuning=AttributeTuning(),
            on_change=lambda t: seen.append(t.axis_attack),
        )
        # 8 sliders (4 axes + 4 compounds)
        assert len(tuner._sliders) == 8
        # Bump the attack slider
        tuner._set_slider_value("axis_attack", 150)  # → 1.5
        # The on_change callback should have fired with the new value
        assert seen
        assert seen[-1] == 1.5
    finally:
        root.destroy()


def test_set_tuning_updates_sliders():
    import tkinter as tk
    from pokeredus.gui.attribute_tuner import AttributeTuner
    from pokeredus.graph.attribute_engine import AttributeTuning
    root = tk.Tk(); root.withdraw()
    try:
        seen = []
        tuner = AttributeTuner(
            root, tuning=AttributeTuning(),
            on_change=lambda t: seen.append(t.compound_threat),
        )
        tuner.set_tuning(AttributeTuning(compound_threat=1.8))
        assert tuner._tuning.compound_threat == 1.8
        assert seen and seen[-1] == 1.8
    finally:
        root.destroy()
