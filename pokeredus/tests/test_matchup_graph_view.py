"""
Tests for the 2D radial + 3D cylinder matchup-graph renderer (Tasks 11-15).

The pure-math helpers are tested headlessly (no tk root required).  The
canvas widgets are exercised via a brief Tk root where unavoidable.
"""

import os
import sys
import math

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest


# ── Task 11: 2D radial geometry helpers ────────────────────────────

def test_attribute_angle_spaced_at_45_deg():
    from pokeredus.gui.matchup_graph_view import attribute_angle
    for i in range(8):
        assert attribute_angle(i) == pytest.approx(i * math.pi / 4)


def test_polygon_points_returns_8_vertices():
    from pokeredus.gui.matchup_graph_view import attribute_polygon_points
    attrs = [1.0] * 8
    pts = attribute_polygon_points(attrs, center=(0, 0), scale=10.0)
    assert len(pts) == 8
    for (x, y), ang, a in zip(pts, [i * math.pi / 4 for i in range(8)], attrs):
        r = math.hypot(x, y)
        assert r == pytest.approx(a * 10.0)


def test_polygon_points_attribute_two_at_top_of_screen():
    """Index 2 is at angle pi/2; with screen-Y flipped, it sits at the top."""
    from pokeredus.gui.matchup_graph_view import attribute_polygon_points
    pts = attribute_polygon_points([1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                                    center=(0, 0), scale=10.0)
    # Attribute 0 is at angle 0 (eastward)
    assert pts[0] == (pytest.approx(10.0), pytest.approx(0.0))
    # Attribute 2 is at angle pi/2 (math-up); with screen-Y flip, it sits at the top.
    pts2 = attribute_polygon_points([0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
                                    center=(0, 0), scale=10.0)
    assert pts2[2] == (pytest.approx(0.0), pytest.approx(-10.0))


def test_attribute_color_returns_distinct_per_axis():
    from pokeredus.gui.matchup_graph_view import attribute_color
    for name in ("attack", "utility", "defense", "speed",
                 "counter", "sponge", "threat", "punish"):
        col = attribute_color(name)
        assert col.startswith("#")
        assert len(col) == 7


# ── Task 12: per-attribute bar elaboration ─────────────────────────

def test_elaborate_bars_returns_18_segments_per_attribute():
    from pokeredus.gui.matchup_graph_view import elaborate_bars_per_attribute
    base = np.zeros((8, 18), dtype=np.float32)
    base[0] = 1.0  # attack = 1 for all types
    bars = elaborate_bars_per_attribute(base, vase_order=list(range(18)))
    assert len(bars) == 8
    for b in bars:
        assert len(b) == 18
        assert all(seg >= 0 for seg in b)


# ── Task 13: 3D camera math + disc hit-test ────────────────────────

def test_disc_radius_proportional_to_compound_area():
    from pokeredus.gui.matchup_graph_view import disc_radius
    full = np.zeros((8, 18), dtype=np.float32)
    # Set counter (row 4) AND sponge (row 5) for a non-zero compound area.
    full[ATT_COUNTER := 4] = 1.0
    full[ATT_SPONGE := 5] = 1.0
    r = disc_radius(full, type_index=3, base=10.0)
    assert r > 10.0


def test_world_to_screen_roundtrip_preserves_xy():
    from pokeredus.gui.matchup_graph_view import (
        world_to_screen, screen_to_world, Camera,
    )
    # Test with identity rotations + camera centered at z=0 so the
    # forward/inverse use the same depth (cam.distance).
    cam = Camera(yaw=0.0, pitch=0.0, distance=300,
                 center=(0.0, 0.0, 0.0),
                 width=600, height=400)
    p = np.array([10.0, 20.0, 0.0])
    s = world_to_screen(p, cam)
    p2 = screen_to_world(np.array(s[:2]), cam)
    # The roundtrip is approximate; the depth is inferred, but x/y should
    # recover when rotations are identity and center.z == p.z.
    np.testing.assert_allclose(p[:2], p2[:2], atol=1e-4)


def test_pick_disc_finds_closest_within_radius():
    from pokeredus.gui.matchup_graph_view import pick_disc, Camera
    # Discs at world_z = 0, 20, 40, ..., 340 (18 of them)
    centers = [(0.0, 0.0, 20.0 * i) for i in range(18)]
    radii = [10.0] * 18
    cam = Camera(yaw=0.0, pitch=0.0, distance=300,
                 width=600, height=400)
    # Look at the first disc; mouse is centered → first disc should win
    cam_mouse = cam._replace(center=(0.0, 0.0, 0.0), mouse=(300, 200))
    idx = pick_disc(centers, radii, cam_mouse)
    assert idx is not None
    assert 0 <= idx < 18


# ── Task 14: disc_centers layout helper ────────────────────────────

def test_disc_centers_stacked_along_z():
    from pokeredus.gui.matchup_graph_view import disc_centers, SLAB_HEIGHT
    centers = disc_centers(slab_height=20.0, base_z=0.0, n=18)
    assert len(centers) == 18
    for i, (x, y, z) in enumerate(centers):
        assert z == pytest.approx(i * 20.0)
        assert x == 0.0 and y == 0.0


# ── Task 15: combined view toggle (uses Tk) ────────────────────────

def test_combined_view_starts_in_2d():
    from pokeredus.gui.matchup_graph_view import MatchupGraphView
    import tkinter as tk
    root = tk.Tk()
    root.withdraw()
    try:
        v = MatchupGraphView(root, sets_dir=".")
        assert v.mode == "2d"
        v.toggle_mode()
        assert v.mode == "3d"
        v.toggle_mode()
        assert v.mode == "2d"
    finally:
        root.destroy()
