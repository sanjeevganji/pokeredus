"""
Tests for the interactive behavior of the 2D / 3D matchup-graph view.

These cover what the user noticed: drag rotates the polygon, the
graph fits the canvas, and there is no zoom (per the renderer-simplify
plan).  Wheel/arrow-key zoom and the 3D scroll have been removed.

The pure-math helpers are tested headlessly in
``test_matchup_graph_view.py``; here we focus on the widget state
machine and event bindings.
"""
import os
import sys
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest
import tkinter as tk

from pokeredus.gui.matchup_graph_view import (
    MatchupGraph2D, MatchupGraph3D,
    Camera, attribute_polygon_points_one,
)


# A single Tk root reused across all tests in this module.  Some
# sandboxes (notably uv-managed Python on Windows) only allow one
# successful Tk() creation per process; creating + destroying a new
# root per test triggers a "Can't find init.tcl" error on the second
# attempt.  Sharing a root sidesteps the issue and matches the
# pattern in ``test_combined_view_starts_in_2d``.
_TK_ROOT = None


def _root():
    global _TK_ROOT
    if _TK_ROOT is None:
        _TK_ROOT = tk.Tk()
        _TK_ROOT.withdraw()
    return _TK_ROOT


# ── Shared test helpers ──────────────────────────────────────────────


class FakeNode:
    """Minimal stand-in for SetMatchupNode used by the renderer."""
    def __init__(self):
        self.attributes = np.zeros((8, 18), dtype=np.float32)
        # Activate the 4 compound axes so disc_radius() > base.
        self.attributes[4] = 1.0
        self.attributes[5] = 1.0
        self.attributes[6] = 1.0
        self.attributes[7] = 1.0
        self.vase_order = list(range(18))
        self.bias = 1.0
        self.set_id = "fake"
        self.pokemon_id = "fake"


def fake_event(**kw):
    """Build a minimal event-like object with the given attributes."""
    return type("E", (), kw)()


# ── 2D view: state, bindings, input handlers ────────────────────────


def test_camera_defaults_anchored_at_world_origin():
    """The default camera must look at the world origin (0,0,0) so
    dragging the 3D view rotates the world around its center."""
    cam = Camera()
    assert cam.center == (0.0, 0.0, 0.0)
    # Distance stays at 750 — there is no zoom.
    assert cam.distance == 750.0


def test_2d_initial_state_defaults():
    v = MatchupGraph2D(_root(), sets_dir=".")
    assert v.rotation == 0.0
    assert v.node is None
    # No zoom attribute.
    assert not hasattr(v, "zoom")


def test_2d_bindings_include_drag_arrows_and_reset():
    """The 2D view must have handlers for drag, arrow keys, and reset
    (no wheel / no Up/Down zoom anymore)."""
    v = MatchupGraph2D(_root(), sets_dir=".")
    bindings = set(v.canvas.bind())
    for tag in ("<Button-1>", "<B1-Motion>", "<ButtonRelease-1>",
                "<Double-Button-1>",
                "<Key-Left>", "<Key-Right>",
                "r", "R"):
        assert tag in bindings, f"missing 2D binding {tag}"
    # Wheel and Up/Down zoom are gone.
    for tag in ("<MouseWheel>", "<Button-4>", "<Button-5>",
                "<Key-Up>", "<Key-Down>"):
        assert tag not in bindings, f"2D should not bind {tag}"


def test_2d_drag_updates_rotation_state():
    """A horizontal drag mutates self.rotation by dx * DRAG_RAD_PER_PX.

    Vertical motion is ignored (per the renderer-simplify plan).
    """
    v = MatchupGraph2D(_root(), sets_dir=".")
    v._on_press(fake_event(x=200, y=200))
    # 100 px right at 0.01 rad/px = 1.0 rad
    v._on_drag(fake_event(x=300, y=200))
    v._on_release(fake_event(x=300, y=200))
    assert abs(v.rotation - 1.0) < 1e-9


def test_2d_vertical_drag_does_not_rotate():
    """Vertical drag must NOT change rotation — the polygon stays
    anchored to the canvas center."""
    v = MatchupGraph2D(_root(), sets_dir=".")
    v._on_press(fake_event(x=200, y=200))
    v._on_drag(fake_event(x=200, y=100))   # 100 px up
    v._on_release(fake_event(x=200, y=100))
    assert v.rotation == 0.0, \
        f"vertical drag rotated the polygon: rotation={v.rotation}"


def test_2d_release_clears_drag_moved_flag():
    """After a release the drag-moved flag must be cleared, so a
    subsequent event doesn't think a drag is still in progress."""
    v = MatchupGraph2D(_root(), sets_dir=".")
    v._on_press(fake_event(x=200, y=200))
    v._on_drag(fake_event(x=210, y=200))
    assert v._drag_moved is True
    v._on_release(fake_event(x=210, y=200))
    assert v._drag_moved is False


def test_2d_double_click_resets_rotation():
    v = MatchupGraph2D(_root(), sets_dir=".")
    v.rotation = 1.23
    v._on_double_click(None)
    assert v.rotation == 0.0


# ── 3D view: state, bindings, input handlers ────────────────────────


def test_3d_bindings_include_drag_arrows_and_reset():
    v = MatchupGraph3D(_root(), sets_dir=".")
    bindings = set(v.canvas.bind())
    for tag in ("<Button-1>", "<B1-Motion>", "<ButtonRelease-1>",
                "<Double-Button-1>",
                "<Key-Left>", "<Key-Right>",
                "r", "R"):
        assert tag in bindings, f"missing 3D binding {tag}"
    # No wheel, no scroll.
    for tag in ("<MouseWheel>", "<Button-4>", "<Button-5>",
                "<Key-Up>", "<Key-Down>"):
        assert tag not in bindings, f"3D should not bind {tag}"


def test_3d_keyboard_bound_on_canvas_not_frame():
    """The arrow keys MUST be bound on the canvas, not the Frame.

    Binding on the Frame (the previous behaviour) means the arrow
    keys never fire because the Frame has no keyboard focus.
    """
    v = MatchupGraph3D(_root(), sets_dir=".")
    canvas_bindings = set(v.canvas.bind())
    assert "<Key-Left>" in canvas_bindings
    assert "<Key-Right>" in canvas_bindings


def test_3d_drag_does_not_pick_a_disc():
    """A drag should not run pick_disc — that would jump-select whatever
    happens to be under the mouse on release."""
    v = MatchupGraph3D(_root(), sets_dir=".")
    v.set_node(FakeNode())
    v._on_press(fake_event(x=200, y=200))
    v._on_drag(fake_event(x=250, y=250))
    v._on_release(fake_event(x=250, y=250))
    assert v.selected_idx is None


def test_3d_clean_click_does_not_crash():
    """A click (no drag) should run the pick path without raising."""
    v = MatchupGraph3D(_root(), sets_dir=".")
    v.set_node(FakeNode())
    v._on_press(fake_event(x=200, y=200))
    v._on_release(fake_event(x=200, y=200))
    assert v._drag_moved is False


def test_3d_double_click_resets_camera():
    v = MatchupGraph3D(_root(), sets_dir=".")
    v.cam = v.cam._replace(yaw=1.2, pitch=0.9)
    v._on_double_click(None)
    assert v.cam.yaw == Camera().yaw
    assert v.cam.pitch == Camera().pitch


def test_3d_pitch_is_clamped():
    """The pitch must be clamped to ±1.0 rad (per the plan)."""
    v = MatchupGraph3D(_root(), sets_dir=".")
    # Many big upward drags should not push pitch above the clamp.
    for _ in range(1000):
        v._on_drag(fake_event(x=200, y=200))   # not strictly needed
        v._on_press(fake_event(x=200, y=200))
        v._on_drag(fake_event(x=200, y=10000))
    assert v.cam.pitch <= v.PITCH_CLAMP + 1e-9, \
        f"pitch {v.cam.pitch} not clamped to {v.PITCH_CLAMP}"


def test_3d_no_zoom_method():
    """MatchupGraph3D no longer exposes _zoom_by (zoom removed)."""
    v = MatchupGraph3D(_root(), sets_dir=".")
    assert not hasattr(v, "_zoom_by"), "MatchupGraph3D must not expose _zoom_by"
    assert not hasattr(v, "_scroll"), "MatchupGraph3D must not expose _scroll"


def test_2d_polygon_always_inside_canvas():
    """For any attribute magnitude (1.0, 1e3, 1e9), the drawn polygon
    must lie inside the canvas (the auto-fit scale guarantees this)."""
    import tkinter as tk
    from pokeredus.gui.matchup_graph_view import MatchupGraph2D
    for mag in (1.0, 1e3, 1e9):
        root = tk.Tk()
        root.geometry("400x300")
        try:
            v = MatchupGraph2D(root, sets_dir=".")
            v.pack(fill="both", expand=True)
            n = type("N", (), {})()
            n.attributes = np.ones((8, 18), dtype=np.float32) * mag
            n.vase_order = list(range(18))
            n.bias = 1.0
            v.set_node(n)
            root.update()
            v._redraw()
            bbox = v.canvas.bbox("all")
            assert bbox is not None, f"no polygon drawn for mag={mag}"
            x0, y0, x1, y1 = bbox
            assert x0 >= 0 and y0 >= 0, f"mag={mag} x0={x0} y0={y0}"
            assert x1 <= 400 and y1 <= 300, f"mag={mag} x1={x1} y1={y1}"
        finally:
            root.destroy()


# ── Geometry helpers: rotation ─────────────────────────────────────


def test_attribute_polygon_points_one_rotation():
    """Rotating by π/2 should map attribute 0 to where attribute 2 was."""
    p0 = attribute_polygon_points_one(0, 1.0, (0, 0), scale=10.0)
    p0_rot = attribute_polygon_points_one(0, 1.0, (0, 0), scale=10.0,
                                          rotation=math.pi / 2)
    p2 = attribute_polygon_points_one(2, 1.0, (0, 0), scale=10.0)
    np.testing.assert_allclose(p0_rot, p2, atol=1e-6)
    # And at zero rotation, attribute 0 is still on the +x axis.
    assert p0 == pytest.approx((10.0, 0.0))


def test_attribute_polygon_points_one_scale():
    """Doubling scale should double the radial distance from center."""
    p_small = attribute_polygon_points_one(0, 1.0, (0, 0), scale=10.0)
    p_big = attribute_polygon_points_one(0, 1.0, (0, 0), scale=20.0)
    assert math.hypot(*p_big) == pytest.approx(2 * math.hypot(*p_small))


def test_attribute_polygon_points_one_value_zero():
    """value=0 should place the vertex at the center (radius=0)."""
    p = attribute_polygon_points_one(3, 0.0, (50, 50), scale=10.0,
                                     rotation=0.7)
    assert p == pytest.approx((50.0, 50.0))
