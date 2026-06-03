"""matchup_graph_view — 2D radial + 3D cylinder matchup-graph renderer.

Pure-tkinter Canvas implementation.  Two visual modes:

* **2D radial polygon** — 8 attribute bars at 0°, 45°, 90°, ... 315°,
  with an "elaborate by types" toggle that breaks each bar into 18
  colored sub-segments (one per Showdown type, in the vase order).

* **3D cylinder** — 18 type-discs stacked vertically.  Each disc's
  radius is proportional to the type's compound area
  (counter·sponge + threat·punish).  Camera controls: arrow keys scroll
  through the stack, horizontal mouse drag rotates yaw, vertical
  mouse drag rotates pitch, mouse wheel zooms, click on a disc picks
  it and shows all 8 raw attribute values.

A combined ``MatchupGraphView`` toggles between the two with a button
and lazy-loads the per-set node cache from disk.

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
    pts = []
    for i, v in enumerate(values):
        ang = attribute_angle(i)
        r = max(0.0, v) * scale
        pts.append((center[0] + r * math.cos(ang),
                    center[1] - r * math.sin(ang)))
    return pts


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
    yaw: float = 0.6
    pitch: float = 0.35
    distance: float = 350.0
    center: tuple = (0.0, 0.0, 40.0)  # mid-tower
    height: int = 600
    width: int = 800
    mouse: tuple | None = None  # (mx, my) for pick_disc


def disc_radius(attributes: np.ndarray, type_index: int,
                base: float = 8.0) -> float:
    """Disc radius proportional to the type's compound area.

    area = counter·sponge + threat·punish (per the polygonal-solid model)
    """
    C, G, T, P = 4, 5, 6, 7
    area = (attributes[C, type_index] * attributes[G, type_index]
            + attributes[T, type_index] * attributes[P, type_index])
    return base * (1.0 + math.sqrt(max(area, 0.0)) * 0.2)


def world_to_screen(p, cam: Camera) -> tuple[float, float, float]:
    """Project a 3D world point to 2D screen coordinates + depth.

    The camera is at the origin, looking down the -z axis, with the
    focal length baked into the projection.  ``cam.yaw`` rotates the
    world around Y, ``cam.pitch`` around X.
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
    """Inverse of world_to_screen at z = cam.center[2] plane.

    Forward math (identity rotations for clarity):
        xr   = x
        zr   = z
        yr   = y*cp - zr*sp
        zr2  = y*sp + zr*cp
    Solving for (x, y, zr) given (yr, zr2):
        y  = yr*cp + zr2*sp
        zr = -yr*sp + zr2*cp
    """
    cy, sy = math.cos(cam.yaw), math.sin(cam.yaw)
    cp, sp = math.cos(cam.pitch), math.sin(cam.pitch)
    focal = 400.0
    d = cam.distance
    xr = (s[0] - cam.width / 2) * max(d, 1.0) / focal
    yr = (cam.height / 2 - s[1]) * max(d, 1.0) / focal
    zr2 = cam.distance - d  # = 0 (we recover the plane at cam.center[2])
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
    return [(0.0, 0.0, base_z + i * slab_height) for i in range(n)]


# ═══════════════════════════════════════════════════════════════════
# 2D radial polygon widget
# ═══════════════════════════════════════════════════════════════════

class MatchupGraph2D(tk.Frame):
    """Top-down radial polygon view of one set/team node."""

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.elaborate = False
        self._build()

    def _build(self):
        self.canvas = tk.Canvas(self, bg="#0d1117", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._redraw())
        self.toggle = tk.Button(
            self, text="Elaborate by types: OFF",
            command=self._toggle_elaborate,
        )
        self.toggle.pack(side="bottom", fill="x")

    def set_node(self, node) -> None:
        self.node = node
        self._redraw()

    def _toggle_elaborate(self) -> None:
        self.elaborate = not self.elaborate
        self.toggle.config(
            text=f"Elaborate by types: {'ON' if self.elaborate else 'OFF'}"
        )
        self._redraw()

    def _redraw(self) -> None:
        c = self.canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 50 or h < 50 or self.node is None:
            return
        cx, cy = w / 2, h / 2
        scale = min(w, h) * 0.35
        # 8 attribute sums (length of each bar)
        sums = [float(self.node.attributes[i].sum()) for i in range(8)]
        pts = attribute_polygon_points(sums, (cx, cy), scale=scale)
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
        for (x, y), name, v in zip(pts, ATTRIBUTE_NAMES, sums):
            c.create_line(cx, cy, x, y, fill=attribute_color(name), width=2)
            c.create_oval(x - 4, y - 4, x + 4, y + 4,
                          fill=attribute_color(name), outline="")
            c.create_text(x + 8, y - 8, text=f"{name}\n{v:.1f}",
                          fill=attribute_color(name), anchor="w",
                          font=("TkFixedFont", 8))
        if self.elaborate:
            from pokeredus.graph.matchup_graph import CANONICAL_TYPES
            bars = elaborate_bars_per_attribute(
                self.node.attributes, self.node.vase_order,
            )
            for ai, seg_values in enumerate(bars):
                ang = attribute_angle(ai)
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
        # Volume readout
        c.create_text(10, 10, anchor="nw", fill="#e6edf3",
                      font=("TkFixedFont", 10, "bold"),
                      text=("Volume: "
                            + f"{volume_of(self.node.attributes, self.node.bias):.1f}"))


# ═══════════════════════════════════════════════════════════════════
# 3D cylinder widget
# ═══════════════════════════════════════════════════════════════════

class MatchupGraph3D(tk.Frame):
    """Isometric 3D cylinder of 18 type-discs.

    Arrow keys scroll, drag rotates, wheel zooms, click picks a disc.
    """

    def __init__(self, master, sets_dir, **kw):
        super().__init__(master, **kw)
        self.sets_dir = sets_dir
        self.node = None
        self.cam = Camera()
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
        c.bind("<MouseWheel>", self._on_wheel)
        self.bind("<Up>", lambda _e: self._scroll(-1))
        self.bind("<Down>", lambda _e: self._scroll(+1))
        self._drag_last = None

    def set_node(self, node) -> None:
        self.node = node
        self._redraw()

    def _scroll(self, delta: int) -> None:
        self.cam = self.cam._replace(
            center=(self.cam.center[0], self.cam.center[1],
                    max(0.0, min(360.0,
                                  self.cam.center[2] + delta * SLAB_HEIGHT)))
        )
        self._redraw()

    def _on_press(self, e):
        self._drag_last = (e.x, e.y)

    def _on_drag(self, e):
        if self._drag_last is None:
            return
        dx, dy = e.x - self._drag_last[0], e.y - self._drag_last[1]
        self._drag_last = (e.x, e.y)
        new_yaw = self.cam.yaw + dx * 0.008
        new_pitch = max(-1.2, min(1.2, self.cam.pitch + dy * 0.008))
        self.cam = self.cam._replace(yaw=new_yaw, pitch=new_pitch)
        self._redraw()

    def _on_release(self, e):
        self._drag_last = None
        cam = self.cam._asdict()
        cam["mouse"] = (e.x, e.y)
        centers = disc_centers(n=18)
        if self.node is not None:
            radii = [disc_radius(self.node.attributes, i) for i in range(18)]
        else:
            radii = [8.0] * 18
        idx = pick_disc(centers, radii, Camera(**cam))
        if idx is not None:
            self.selected_idx = idx
            self._update_info_panel(idx)
            self._redraw()

    def _on_wheel(self, e):
        factor = 1.1 if e.delta > 0 else 0.9
        self.cam = self.cam._replace(
            distance=max(80.0, min(800.0, self.cam.distance * factor))
        )
        self._redraw()

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
        centers = disc_centers(n=18)
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
                            f"dist={cam.distance:.0f} "
                            f"center_z={cam.center[2]:.0f}"))


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

    def set_node(self, node) -> None:
        self.view_2d.set_node(node)
        self.view_3d.set_node(node)


# ═══════════════════════════════════════════════════════════════════
# Backward-compat shims (Task 2).  Real implementations replace these
# once the rest of the app is rewired to use MatchupGraphView directly.
# ═══════════════════════════════════════════════════════════════════

class _MiniGraphStub(tk.Frame):
    """No-op placeholder for the old MiniGraph3DCanvas.  See Task 2."""

    def __init__(self, master, kg=None, matchup_cache=None,
                 width: int = 320, height: int = 200, **kwargs):
        super().__init__(master, width=width, height=height, **kwargs)
        self.kg = kg
        self.matchup_cache = matchup_cache
        tk.Label(
            self, text="(graph removed — see Task 15)",
            fg="#888", bg="#0d1117", font=("TkFixedFont", 9),
        ).pack(expand=True, fill="both")

    def set_data(self, set_ids=None, team_anchor_ids=None,
                 run_simulation: bool = True) -> None:
        return


MiniGraph3DCanvas = _MiniGraphStub  # old import path


class _MatchupGraphPageStub(tk.Frame):
    """No-op placeholder for the old MatchupGraphPage.  See Task 2."""

    def __init__(self, master, kg=None, matchup_cache=None,
                 go_home=None, focus_set_ids=None,
                 focus_team_name=None, on_back_to_team=None, **kwargs):
        super().__init__(master, **kwargs)
        tk.Label(
            self,
            text=("Matchup Graph — placeholder\n"
                  "(real view lands in Task 16 of the rewrite plan)"),
            fg="#e6edf3", bg="#0d1117",
            font=("TkFixedFont", 12, "bold"), justify="center",
        ).pack(expand=True, fill="both")
        if go_home is not None:
            tk.Button(self, text="Home", command=go_home).pack(side="bottom")


MatchupGraphPage = _MatchupGraphPageStub  # old import path
