"""matchup_graph_view — 2D radial + 3D cylinder matchup-graph renderer.

Pure-tkinter Canvas implementation.  Two visual modes:

* **2D radial polygon** — 8 attribute bars at 0°, 45°, 90°, ... 315°,
  with an "elaborate by types" toggle that breaks each bar into 18
  colored sub-segments (one per Showdown type, in the vase order).
  Interactive: drag to rotate, mouse wheel to zoom, double-click
  to reset, arrow keys once the canvas has focus.

* **3D cylinder** — 18 type-discs stacked vertically.  Each disc's
  radius is proportional to the type's compound area
  (counter·sponge + threat·punish).  Camera controls: arrow keys
  scroll through the stack, horizontal mouse drag rotates yaw,
  vertical mouse drag rotates pitch, mouse wheel zooms, click on a
  disc picks it and shows all 8 raw attribute values.  Defaults are
  chosen so the whole stack fits comfortably in a 1200×800 frame
  on first load (distance ≈ 750, look-at z = 170, 3/4 view).

A combined ``MatchupGraphView`` toggles between the two with a
button and lazy-loads the per-set node cache from disk.

Data source: ``pokeredus.graph.matchup_graph.SetMatchupNode`` (8x18
attribute matrix + vase_order + bias + weights).  The legacy stub
classes for the old ``MiniGraph3DCanvas`` / ``MatchupGraphPage`` are
kept at the bottom for backward compatibility with
``matchup_panel.py`` / ``app.py``.
"""
from __future__ import annotations

import math
import tkinter as tk
from typing import NamedTuple, Sequence

import numpy as np

# Local import for the polygon area + 8x18 attribute matrix that
# the renderer consumes.  Kept lazy inside the widget methods so that
# headless tests can import the geometry helpers without a KnowledgeGraph.


# ═══════════════════════════════════════════════════════════════════
# Type colors (overridable by theme later)
# ═══════════════════════════════════════════════════════════════════

_TYPE_COLORS: dict[str, str] = {
    "Normal": "#A8A77A", "Fire": "#EE8130", "Water": "#6390F0",
    "Electric": "#F7D02C", "Grass": "#7AC74C", "Ice": "#96D9D6",
    "Fighting": "#C22E28", "Poison": "#A33EA1", "Ground": "#E2BF65",
    "Flying": "#A98FF3", "Psychic": "#F95587", "Bug": "#A6B91A",
    "Rock": "#B6A136", "Ghost": "#735797", "Dragon": "#6F35FC",
    "Dark": "#705746", "Steel": "#B7B7CE", "Fairy": "#D685AD",
}


def type_color(type_name: str) -> str:
    return _TYPE_COLORS.get(type_name, "#888888")


# ═══════════════════════════════════════════════════════════════════
# Task 11: 2D radial geometry helpers
# ═══════════════════════════════════════════════════════════════════

def attribute_angle(index: int) -> float:
    """Angle (radians) of attribute #index on the 8-axis radial layout."""
    return index * math.pi / 4


def attribute_polygon_points(values: Sequence[float],
                              center: tuple[float, float],
                              scale: float = 50.0) -> list[tuple[float, float]]:
    """Compute the 8 vertices of the radial polygon in screen coordinates.

    Screen Y is flipped vs. math Y so that attribute #0 (attack) sits
    on the right, attribute #2 (defense) sits at the bottom, etc.
    The renderer is free to rotate the whole layout if a different
    default orientation is desired.
    """
    return [attribute_polygon_points_one(i, v, center, scale)
            for i, v in enumerate(values)]


def attribute_polygon_points_one(index: int, value: float,
                                 center: tuple[float, float],
                                 scale: float = 50.0,
                                 rotation: float = 0.0
                                 ) -> tuple[float, float]:
    """One vertex of the radial polygon, optionally rotated by `rotation`.

    `rotation` is in radians and is added to the natural angle of the
    given attribute index.  Screen Y is flipped vs. math Y so that
    attribute #0 (attack) sits on the right, attribute #2 (defense)
    sits at the bottom, etc.
    """
    ang = attribute_angle(index) + rotation
    r = max(0.0, value) * scale
    return (center[0] + r * math.cos(ang),
            center[1] - r * math.sin(ang))


def attribute_color(attr_name: str) -> str:
    """Color for a given attribute axis (4 base + 4 compound)."""
    return {
        "attack": "#ee6c4d",  "utility": "#f6ae2d",
        "defense": "#3a86ff", "speed":   "#06d6a0",
        "counter": "#ee6c4d", "sponge":  "#06d6a0",
        "threat":  "#f6ae2d", "punish":  "#3a86ff",
    }.get(attr_name, "#888888")


# ═══════════════════════════════════════════════════════════════════
# Task 12: per-attribute bar elaboration (per-type sub-segments)
# ═══════════════════════════════════════════════════════════════════

def elaborate_bars_per_attribute(attributes: np.ndarray,
                                  vase_order: Sequence[int]
                                  ) -> list[list[float]]:
    """Return 8 lists of 18 per-type values, each in the vase-order.

    Used to draw the 8 bars as 18 colored sub-segments when 'elaborate
    by types' is on.
    """
    out = []
    for row in attributes:  # row is shape (18,)
        out.append([float(row[i]) for i in vase_order])
    return out


# ═══════════════════════════════════════════════════════════════════
# Task 13: 3D camera math + disc hit-test
# ═══════════════════════════════════════════════════════════════════

class Camera(NamedTuple):
    # Defaults chosen so the full 18-disc stack fits comfortably in
    # a 1200x800 frame on first load.  ``center`` is fixed at the
    # world origin so drag rotation orbits the world around (0,0,0)
    # (the disc stack's center).  ``distance`` is fixed — there is no
    # zoom.
    yaw: float = 0.55
    pitch: float = 0.50
    distance: float = 750.0
    center: tuple = (0.0, 0.0, 0.0)  # world origin (anchor for rotation)
    height: int = 600
    width: int = 800
    mouse: tuple | None = None  # (mx, my) for pick_disc


def disc_radius(attributes: np.ndarray, type_index: int,
                base: float = 8.0,
                radius_scale: float = 0.005) -> float:
    """Disc radius proportional to the type's compound area.

    ``area = counter·sponge + threat·punish`` (per the polygonal-solid
    model).  ``attributes`` is expected to be in 0-100 (the page tuner
    keeps node.attributes in 0-100).  With max compound area
    ``100*100 + 100*100 = 20000`` (sqrt ≈ 141) the default
    ``radius_scale = 0.005`` caps the radius at about 1.71 × ``base``
    (≈ 13.7 with base=8), so the 18 stacked discs never overlap.
    """
    C, G, T, P = 4, 5, 6, 7
    area = (attributes[C, type_index] * attributes[G, type_index]
            + attributes[T, type_index] * attributes[P, type_index])
    return base * (1.0 + math.sqrt(max(area, 0.0)) * radius_scale)


def world_to_screen(p, cam: Camera) -> tuple[float, float, float]:
    """Project a 3D world point to 2D screen coordinates + depth.

    The camera is at the origin, looking down the -z axis, with the
    focal length baked into the projection.  ``cam.yaw`` rotates the
    world around Y, ``cam.pitch`` around X.  ``cam.center`` is the
    world-origin anchor used for rotation — it is *not* translated
    here, so dragging the camera orbits the world around (0,0,0).
    """
    cy, sy = math.cos(cam.yaw), math.sin(cam.yaw)
    cp, sp = math.cos(cam.pitch), math.sin(cam.pitch)
    x = p[0] - cam.center[0]
    y = p[1] - cam.center[1]
    z = p[2] - cam.center[2]
    # yaw rotation (around Y axis)
    xr = x * cy + z * sy
    zr = -x * sy + z * cy
    # pitch rotation (around X axis)
    yr = y * cp - zr * sp
    zr2 = y * sp + zr * cp
    d = cam.distance - zr2
    focal = 400.0
    sx = cam.width / 2 + (xr * focal) / max(d, 1.0)
    sy_screen = cam.height / 2 - (yr * focal) / max(d, 1.0)
    return (sx, sy_screen, d)


def screen_to_world(s, cam: Camera) -> np.ndarray:
    """Inverse of world_to_screen at the world-origin plane (z=0
    after the cam.center translation is undone).

    Used by ``pick_disc`` to build the ray from camera origin through
    the mouse position.
    """
    cy, sy = math.cos(cam.yaw), math.sin(cam.yaw)
    cp, sp = math.cos(cam.pitch), math.sin(cam.pitch)
    focal = 400.0
    d = cam.distance
    xr = (s[0] - cam.width / 2) * max(d, 1.0) / focal
    yr = (cam.height / 2 - s[1]) * max(d, 1.0) / focal
    zr2 = cam.distance - d  # = 0 (we recover the plane at cam.center)
    # Undo pitch
    zr = -yr * sp + zr2 * cp
    y = yr * cp + zr2 * sp
    # Undo yaw
    x = xr * cy - zr * sy
    z = xr * sy + zr * cy
    return np.array([x + cam.center[0], y + cam.center[1], z + cam.center[2]])


def pick_disc(centers: Sequence[tuple[float, float, float]],
              radii: Sequence[float], cam: Camera) -> int | None:
    """Return the index of the disc under the mouse, or None.

    Uses ray-vs-axis-aligned-cylinder: the ray is from the camera
    origin through the mouse point; the cylinder is the disc's bounding
    region (radius = disc radius, axis = the slab's vertical axis).
    """
    if cam.mouse is None:
        return None
    mx, my = cam.mouse
    # Build ray from camera position (along +z) through the mouse point.
    ray_origin = np.array([cam.center[0], cam.center[1], cam.center[2] + cam.distance])
    ray_dir = screen_to_world((mx, my, 0.0), cam) - ray_origin
    ray_dir /= np.linalg.norm(ray_dir) + 1e-9
    best, best_t = None, float("inf")
    for i, (cx, cy_, cz) in enumerate(centers):
        dx = ray_origin[0] - cx
        dy_ = ray_origin[1] - cy_
        dz = ray_origin[2] - cz
        u = ray_dir
        proj = dx * u[0] + dy_ * u[1] + dz * u[2]
        perp2 = (dx * dx + dy_ * dy_ + dz * dz) - proj * proj
        if perp2 < radii[i] * radii[i] and 0 < proj < best_t:
            best_t = proj
            best = i
    return best


# ═══════════════════════════════════════════════════════════════════
# Task 14: disc layout helper
# ═══════════════════════════════════════════════════════════════════

SLAB_HEIGHT: float = 20.0


def disc_centers(slab_height: float = SLAB_HEIGHT, base_z: float = 0.0,
                  n: int = 18) -> list[tuple[float, float, float]]:
    """Disc centres along the +z axis, starting at ``base_z``."""
    return [(0.0, 0.0, base_z + i * slab_height) for i in range(n)]


def disc_centers_origin_anchored(slab_height: float = SLAB_HEIGHT,
                                  n: int = 18) -> list[tuple[float, float, float]]:
    """Disc centres centred at the world origin (z=0).

    The 18 discs are stacked symmetrically around z=0, with z range
    ``±(n-1)/2 * slab``.  Used by the 3D view so dragging the camera
    orbits the world around (0,0,0).
    """
    half = (n - 1) / 2.0
    return [(0.0, 0.0, (i - half) * slab_height) for i in range(n)]


# ═══════════════════════════════════════════════════════════════════
# 2D radial polygon widget
# ═══════════════════════════════════════════════════════════════════

class MatchupGraph2D(tk.Frame):
    """Top-down radial polygon view of one set/team node.

    Interaction:
      • Drag with left mouse button → rotate the polygon (horizontal only)
      • Double-click → reset rotation

    The polygon auto-fits its canvas — the per-axis max (0-100 scaled)
    drives each radial bar's length, and the largest axis maps to
    ``min(w, h) * 0.40`` pixels.  There is no zoom.
    """

    DRAG_RAD_PER_PX: float = 0.01   # drag sensitivity (radians/pixel)

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.elaborate = False
        self.rotation: float = 0.0     # radians
        self._build()
        self._bind_inputs()

    def _build(self):
        self.canvas = tk.Canvas(self, bg="#0d1117", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._redraw())
        self.toggle = tk.Button(
            self, text="Elaborate by types: OFF",
            command=self._toggle_elaborate,
        )
        self.toggle.pack(side="bottom", fill="x")

    def _bind_inputs(self) -> None:
        c = self.canvas
        c.bind("<ButtonPress-1>", self._on_press)
        c.bind("<B1-Motion>", self._on_drag)
        c.bind("<ButtonRelease-1>", self._on_release)
        c.bind("<Double-Button-1>", self._on_double_click)
        # Keyboard: bind on the canvas (not the Frame) so it actually
        # receives key events once the user clicks into the canvas.
        c.bind("<Left>",  lambda _e: self._rotate_by(+0.1))
        c.bind("<Right>", lambda _e: self._rotate_by(-0.1))
        c.bind("<Key-r>", lambda _e: self._reset_view())
        c.bind("<Key-R>", lambda _e: self._reset_view())
        self._drag_last = None
        self._drag_moved = False

    def set_node(self, node) -> None:
        self.node = node
        self._redraw()

    def _toggle_elaborate(self) -> None:
        self.elaborate = not self.elaborate
        self.toggle.config(
            text=f"Elaborate by types: {'ON' if self.elaborate else 'OFF'}"
        )
        self._redraw()

    # ── input handlers ───────────────────────────────────────────────
    def _on_press(self, e):
        self._drag_last = (e.x, e.y)
        self._drag_moved = False
        # Give the canvas keyboard focus so arrow keys work.
        self.canvas.focus_set()

    def _on_drag(self, e):
        if self._drag_last is None:
            return
        dx = e.x - self._drag_last[0]
        self._drag_last = (e.x, e.y)
        if dx:
            self._drag_moved = True
        # Horizontal drag only — vertical motion is ignored so the
        # polygon stays centered around the canvas middle.
        self.rotation += dx * self.DRAG_RAD_PER_PX
        self._redraw()

    def _on_release(self, _e):
        self._drag_last = None
        self._drag_moved = False
        # (No click-vs-drag distinction needed for the 2D view.)

    def _on_double_click(self, _e):
        self._reset_view()

    def _rotate_by(self, dr: float) -> None:
        self.rotation += dr
        self._redraw()

    def _reset_view(self) -> None:
        self.rotation = 0.0
        self._redraw()

    # ── redraw ───────────────────────────────────────────────────────
    def _redraw(self) -> None:
        c = self.canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 50 or h < 50 or self.node is None:
            return
        cx, cy = w / 2, h / 2
        # Auto-fit: largest axis (max value 0-100) maps to 40% of the
        # shorter canvas side.  No zoom factor.
        radius = min(w, h) * 0.40
        # Per-axis max across 18 types (in 0-100).  The page tuner
        # keeps node.attributes in 0-100; raw sums would dwarf the
        # canvas, so we always read from the already-scaled matrix.
        attrs = self.node.attributes
        if attrs.size == 0 or attrs.shape[0] != 8:
            return
        axis_vals = np.clip(attrs.max(axis=1), 0.0, 100.0)  # (8,)
        # Render the per-axis bar length as a fraction of `radius`,
        # where 100 → full radius.  Clamp to [0, radius].
        scale = radius / 100.0
        pts = [
            attribute_polygon_points_one(
                i, float(axis_vals[i]), (cx, cy), scale, self.rotation,
            )
            for i in range(8)
        ]
        # Polygon fill
        c.create_polygon(*sum(pts, ()), fill="#1c1f26", outline="#3a86ff", width=2)
        # Spokes + tips
        try:
            from pokeredus.graph.matchup_graph import ATTRIBUTE_NAMES, volume_of
        except ImportError:
            ATTRIBUTE_NAMES = ["attack", "utility", "defense", "speed",
                                "counter", "sponge", "threat", "punish"]
            def volume_of(attributes, bias=1.0):  # type: ignore
                C, G, T, P = 4, 5, 6, 7
                per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
                return float(per_type.sum() * bias)
        for (x, y), name, v in zip(pts, ATTRIBUTE_NAMES, axis_vals):
            c.create_line(cx, cy, x, y, fill=attribute_color(name), width=2)
            c.create_oval(x - 4, y - 4, x + 4, y + 4,
                          fill=attribute_color(name), outline="")
            c.create_text(x + 8, y - 8, text=f"{name}\n{v:.0f}",
                          fill=attribute_color(name), anchor="w",
                          font=("TkFixedFont", 8))
        if self.elaborate:
            from pokeredus.graph.matchup_graph import CANONICAL_TYPES
            bars = elaborate_bars_per_attribute(
                self.node.attributes, self.node.vase_order,
            )
            for ai, seg_values in enumerate(bars):
                ang = attribute_angle(ai) + self.rotation
                dx, dy = math.cos(ang), -math.sin(ang)
                cursor = 0.0
                for ti, val in enumerate(seg_values):
                    tname = CANONICAL_TYPES[self.node.vase_order[ti]]
                    seg = max(val, 0.0) * scale * 0.02
                    x0 = cx + dx * cursor
                    y0 = cy + dy * cursor
                    x1 = cx + dx * (cursor + seg)
                    y1 = cy + dy * (cursor + seg)
                    c.create_line(x0, y0, x1, y1,
                                  fill=type_color(tname), width=3)
                    cursor += seg + 1.0  # small gap
        # Header line: volume + view state
        c.create_text(10, 10, anchor="nw", fill="#e6edf3",
                      font=("TkFixedFont", 10, "bold"),
                      text=("Volume: "
                            + f"{volume_of(self.node.attributes, self.node.bias):.1f}"))
        c.create_text(10, 32, anchor="nw", fill="#8b949e",
                      font=("TkFixedFont", 8),
                      text=(f"rot={math.degrees(self.rotation):.0f}°  "
                            f"(drag · dbl-click resets · arrows rotate)"))


# ═══════════════════════════════════════════════════════════════════
# 3D cylinder widget
# ═══════════════════════════════════════════════════════════════════

class MatchupGraph3D(tk.Frame):
    """Isometric 3D cylinder of 18 type-discs.

    Drag rotates the world around its origin (0,0,0).  No zoom, no
    scroll — the camera distance is fixed and the disc stack is
    centred at z=0 so rotation stays symmetric.
    """

    PITCH_CLAMP: float = 1.0   # ±1.0 rad (~±57°) keeps the stack upright

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.cam = Camera()   # center is now (0,0,0) — world origin
        self.selected_idx: int | None = None
        self._build()
        self._bind_inputs()

    def _build(self):
        self.canvas = tk.Canvas(self, bg="#0d1117", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._redraw())
        self.info = tk.Label(
            self, anchor="w", bg="#161b22", fg="#e6edf3",
            font=("TkFixedFont", 9), justify="left",
        )
        self.info.pack(side="bottom", fill="x")

    def _bind_inputs(self):
        c = self.canvas
        c.bind("<ButtonPress-1>", self._on_press)
        c.bind("<B1-Motion>", self._on_drag)
        c.bind("<ButtonRelease-1>", self._on_release)
        c.bind("<Double-Button-1>", self._on_double_click)
        # Keyboard: bind on the canvas (not the Frame) so it actually
        # receives key events once the user clicks into the canvas.
        c.bind("<Left>",  lambda _e: self._rotate_yaw(+0.1))
        c.bind("<Right>", lambda _e: self._rotate_yaw(-0.1))
        c.bind("<Key-r>", lambda _e: self._reset_view())
        c.bind("<Key-R>", lambda _e: self._reset_view())
        # Make the canvas a valid keyboard-focus widget so it actually
        # receives the key events above (a vanilla Canvas doesn't take
        # focus on click until we tell it to).
        c.bind("<ButtonPress-1>",
               lambda e: c.focus_set(), add="+")
        self._drag_last = None
        self._drag_moved = False

    def set_node(self, node) -> None:
        self.node = node
        self._redraw()

    def _rotate_yaw(self, dr: float) -> None:
        self.cam = self.cam._replace(yaw=self.cam.yaw + dr)
        self._redraw()

    def _reset_view(self) -> None:
        self.cam = Camera()
        self._redraw()

    def _on_press(self, e):
        self._drag_last = (e.x, e.y)
        self._drag_moved = False

    def _on_drag(self, e):
        if self._drag_last is None:
            return
        dx, dy = e.x - self._drag_last[0], e.y - self._drag_last[1]
        self._drag_last = (e.x, e.y)
        if dx or dy:
            self._drag_moved = True
        # Rotation orbits the world origin (cam.center is fixed at 0).
        new_yaw = self.cam.yaw + dx * 0.008
        new_pitch = max(-self.PITCH_CLAMP, min(self.PITCH_CLAMP,
                                                self.cam.pitch + dy * 0.008))
        self.cam = self.cam._replace(yaw=new_yaw, pitch=new_pitch)
        self._redraw()

    def _on_release(self, e):
        self._drag_last = None
        # If the user actually dragged, treat it as a rotation, not a
        # pick.  Only run pick_disc on a clean click.
        if getattr(self, "_drag_moved", False):
            self._drag_moved = False
            return
        cam = self.cam._asdict()
        cam["mouse"] = (e.x, e.y)
        centers = disc_centers_origin_anchored(n=18)
        if self.node is not None:
            radii = [disc_radius(self.node.attributes, i) for i in range(18)]
        else:
            radii = [8.0] * 18
        idx = pick_disc(centers, radii, Camera(**cam))
        if idx is not None:
            self.selected_idx = idx
            self._update_info_panel(idx)
            self._redraw()

    def _on_double_click(self, _e):
        self._reset_view()

    def _update_info_panel(self, idx: int) -> None:
        if self.node is None:
            return
        try:
            from pokeredus.graph.matchup_graph import (
                CANONICAL_TYPES, ATTRIBUTE_NAMES, volume_of,
            )
        except ImportError:
            CANONICAL_TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice",
                                "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
                                "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"]
            ATTRIBUTE_NAMES = ["attack", "utility", "defense", "speed",
                                "counter", "sponge", "threat", "punish"]
            def volume_of(attributes, bias=1.0):  # type: ignore
                C, G, T, P = 4, 5, 6, 7
                per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
                return float(per_type.sum() * bias)
        a = self.node.attributes
        vase = self.node.vase_order
        type_idx = vase[idx]
        tname = CANONICAL_TYPES[type_idx]
        lines = [f"Type #{idx}  ({tname})  raw_type_index={type_idx}"]
        for ai, name in enumerate(ATTRIBUTE_NAMES):
            lines.append(f"  {name:8s} = {a[ai, type_idx]:.2f}")
        lines.append(
            f"  volume    = {volume_of(self.node.attributes, self.node.bias):.1f}"
        )
        self.info.config(text="\n".join(lines))

    def _redraw(self) -> None:
        c = self.canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 50 or h < 50 or self.node is None:
            return
        cam = self.cam._replace(width=w, height=h)
        try:
            from pokeredus.graph.matchup_graph import CANONICAL_TYPES
        except ImportError:
            CANONICAL_TYPES = ["Normal", "Fire", "Water", "Electric", "Grass", "Ice",
                                "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
                                "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy"]
        vase = self.node.vase_order
        centers = disc_centers_origin_anchored(n=18)
        radii = [disc_radius(self.node.attributes, i) for i in range(18)]
        projected = []
        for i, center in enumerate(centers):
            sx, sy, depth = world_to_screen(np.array(center), cam)
            projected.append((i, sx, sy, depth, radii[i]))
        projected.sort(key=lambda r: r[3])  # back-to-front
        for i, sx, sy, depth, r in projected:
            tname = CANONICAL_TYPES[vase[i]]
            color = type_color(tname)
            outline = "#ffffff" if i == self.selected_idx else "#222"
            width = 3 if i == self.selected_idx else 1
            r_screen = max(6.0, r * 200.0 / max(depth, 1.0))
            c.create_oval(sx - r_screen, sy - r_screen,
                          sx + r_screen, sy + r_screen,
                          fill=color, outline=outline, width=width)
            c.create_text(sx, sy, text=str(i + 1), fill="#000",
                          font=("TkFixedFont", 8, "bold"))
        c.create_text(8, 8, anchor="nw", fill="#e6edf3", font=("TkFixedFont", 9),
                      text=(f"yaw={cam.yaw:.2f} pitch={cam.pitch:.2f} "
                            f"(drag · dbl-click resets · arrows rotate)"))


# ═══════════════════════════════════════════════════════════════════
# Combined view widget (2D/3D toggle + lazy load)
# ═══════════════════════════════════════════════════════════════════

class MatchupGraphView(tk.Frame):
    """Combined 2D/3D view with a toggle.  Loads node cache on demand."""

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.mode = "2d"
        self._current_node = None
        self._build()

    def _build(self):
        self.toggle = tk.Button(self, text="Switch to 3D",
                                command=self.toggle_mode)
        self.toggle.pack(side="top", fill="x")
        self.container = tk.Frame(self)
        self.container.pack(fill="both", expand=True)
        self.view_2d = MatchupGraph2D(self.container, self.sets_dir)
        self.view_3d = MatchupGraph3D(self.container, self.sets_dir)
        self.view_2d.pack(fill="both", expand=True)

    def toggle_mode(self) -> None:
        if self.mode == "2d":
            self.view_2d.pack_forget()
            self.view_3d.pack(fill="both", expand=True)
            self.mode = "3d"
            self.toggle.config(text="Switch to 2D")
        else:
            self.view_3d.pack_forget()
            self.view_2d.pack(fill="both", expand=True)
            self.mode = "2d"
            self.toggle.config(text="Switch to 3D")
        if self._current_node is not None:
            self.set_node(self._current_node)

    def set_set(self, pokemon_id: str, set_id: str) -> None:
        """Lazy-load (or build) the node for the given set and display it."""
        from pokeredus.graph.matchup_graph import (
            load_node_cache, build_node, save_node_cache,
        )
        node = load_node_cache(pokemon_id, set_id, self.sets_dir)
        if node is None:
            try:
                from pokeredus.graph.knowledge_graph import KnowledgeGraph
                kg = KnowledgeGraph()
                s = kg.get_set(set_id)
                p = kg.get_pokemon(pokemon_id) if s else None
                if s and p:
                    node = build_node(s, p, kg=kg)
                    save_node_cache(node, self.sets_dir)
            except Exception:
                node = None
        self._current_node = node
        self.set_node(node)

    def set_team(self, set_ids: list[str], kg=None) -> None:
        """Build a team node from the given set ids and display it.

        Used by the matchup_panel mini-graph and the full graph page
        when focusing on a specific team.  Falls back to set_set() with
        the first set id if only one is given.
        """
        if not set_ids:
            self.set_node(None)
            return
        from pokeredus.graph.matchup_graph import (
            build_node, compose_team_node,
        )
        if kg is None:
            try:
                from pokeredus.graph.knowledge_graph import KnowledgeGraph
                kg = KnowledgeGraph()
            except Exception:
                kg = None
        nodes = []
        for sid in set_ids:
            if kg is None:
                continue
            s = kg.get_set(sid)
            if s is None:
                continue
            p = kg.get_pokemon(s.pokemon_id)
            if p is None:
                continue
            nodes.append(build_node(s, p, kg=kg))
        if not nodes:
            self.set_node(None)
            return
        team_node = compose_team_node(nodes)
        self._current_node = team_node
        self.set_node(team_node)

    def set_node(self, node) -> None:
        self.view_2d.set_node(node)
        self.view_3d.set_node(node)


class MatchupGraphPage(tk.Frame):
    """Revamped page: collapsible set list (left), 2D/3D graph (center),
    attribute tuner (right).

    The list collapses to one row per Pokémon by default; clicking the
    chevron expands the row to show all of that Pokémon's sets.  A
    sort dropdown lets the user reorder by alpha or by best-volume
    (ascending / descending).

    The tuner panel exposes the 4 base-axis weights and the 4
    per-compound multipliers; moving a slider live-updates the
    currently-shown set's 8-attribute matrix.
    """

    def __init__(self, master, kg=None, matchup_cache=None,
                 go_home=None, focus_set_ids=None,
                 focus_team_name=None, on_back_to_team=None, **kwargs):
        super().__init__(master, **kwargs)
        self.kg = kg
        self._go_home = go_home
        self._on_back = on_back_to_team
        self._focus_set_ids = list(focus_set_ids) if focus_set_ids else []
        self._focus_team_name = focus_team_name

        from pokeredus.graph.attribute_engine import AttributeTuning
        self._tuning = AttributeTuning()

        self._build_toolbar()
        self._build_body()

    # ── toolbar ─────────────────────────────────────────────────
    def _build_toolbar(self):
        bar = tk.Frame(self, bg="#0d1117")
        bar.pack(side="top", fill="x")
        title = self._focus_team_name or (
            f"Matchup Graph · {len(self._focus_set_ids)} sets"
            if self._focus_set_ids else "Matchup Graph"
        )
        tk.Label(bar, text=title, bg="#0d1117", fg="#e6edf3",
                 font=("TkFixedFont", 12, "bold")
                 ).pack(side="left", padx=10)
        if self._on_back is not None:
            tk.Button(bar, text="Back to team", command=self._on_back
                      ).pack(side="right", padx=4, pady=4)
        if self._go_home is not None:
            tk.Button(bar, text="Home", command=self._go_home
                      ).pack(side="right", padx=4, pady=4)

    # ── three-pane body ─────────────────────────────────────────
    def _build_body(self):
        from pokeredus.gui.pokemon_set_list import PokemonSetList
        from pokeredus.gui.attribute_tuner import AttributeTuner
        from pokeredus.config import SETS_DIR

        body = tk.Frame(self, bg="#0d1117")
        body.pack(fill="both", expand=True)

        # left: pokemon set list
        left = tk.Frame(body, bg="#161b22", width=320)
        left.pack(side="left", fill="y")
        left.pack_propagate(False)
        self._list = PokemonSetList(
            left, on_select=self._on_set_selected,
        )
        self._list.pack(fill="both", expand=True)

        # center: graph
        self._view = MatchupGraphView(body, sets_dir=str(SETS_DIR))
        self._view.pack(side="left", fill="both", expand=True)

        # right: tuner
        right = tk.Frame(body, bg="#161b22", width=260)
        right.pack(side="right", fill="y")
        right.pack_propagate(False)
        self._tuner = AttributeTuner(
            right, tuning=self._tuning, on_change=self._on_tuning_change,
        )
        self._tuner.pack(fill="x", padx=4, pady=4)

        # Populate the list and any team focus.
        self._reload_list()
        if self._focus_set_ids:
            self._view.set_team(self._focus_set_ids, kg=self.kg)

    # ── list population ─────────────────────────────────────────
    def _reload_list(self) -> None:
        if self.kg is None:
            return
        from pokeredus.graph.matchup_graph import build_node, volume_of
        records: list[tuple[str, str, float]] = []
        for s in self.kg.get_all_sets():
            p = self.kg.get_pokemon(s.pokemon_id)
            if p is None:
                continue
            try:
                node = build_node(s, p, kg=self.kg)
                v = volume_of(node.attributes, node.bias)
            except Exception:
                v = 0.0
            records.append((s.pokemon_id, s.set_name, v))
        self._list.refresh(records)

    # ── callbacks ───────────────────────────────────────────────
    def _on_set_selected(self, pokemon_id: str, set_name: str) -> None:
        if self.kg is None:
            return
        s = next((x for x in self.kg.get_all_sets()
                  if x.pokemon_id == pokemon_id
                  and x.set_name == set_name), None)
        if s is None:
            return
        self._view.set_set(s.pokemon_id, s.id)

    def _on_tuning_change(self, tuning) -> None:
        """Re-render the currently shown node with the new tuning."""
        node = getattr(self._view, "_current_node", None)
        if node is None:
            return
        from pokeredus.graph.attribute_engine import tune_existing_node
        new_attrs = tune_existing_node(node, tuning=tuning)
        # Mutate the node in-place so the 2D/3D renderers pick it up
        # on the next redraw.
        node.attributes = new_attrs
        self._view.set_node(node)


MatchupGraphPage = MatchupGraphPage  # identity — kept for back-compat alias
