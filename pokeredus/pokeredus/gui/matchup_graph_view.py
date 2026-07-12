"""matchup_graph_view — Team radial bar chart with neon theme.

Pure-tkinter Canvas implementation with dark neon aesthetic,
smooth animations, hover effects, and stat breakdown displays.

Two visual modes:

* **Single mode** — 8-sectored radial bar chart showing one Pokemon's
  attribute scores on 8 axes at 0°, 45°, 90°, … 315°.

* **Team mode** — each of the 8 sectors shows the team's normalized score
  for that attribute (the sum of individual contributions).  Click any
  sector to expand it into a full-circle breakdown where each team member
  contributes a radial segment whose amplitude is that member's individual
  contribution to the attribute score, and whose angular width is
  proportional to their coverage effectiveness against the opposing set
  (the 360° circle is distributed among members based on coverage).

Data source: ``TeamRadialData`` named tuples that carry per-pokemon
radar values + coverage scores.

The formula constants for team-radial calculations live in the Obsidian
vault at ``Hermes Memory/team_radial_formulas.md`` and are loaded at
runtime via ``load_team_radial_formulas()``.
"""
from __future__ import annotations

import math
import tkinter as tk
from dataclasses import dataclass, field
from typing import Sequence, Callable

from pokeredus.gui.theme import (
    BG_DARK, BG_PANEL, BG_CARD, BG_INPUT, BG_HOVER, BG_SELECTED,
    FG_PRIMARY, FG_SECONDARY, FG_DIM,
    TYPE_COLORS,
    NEON_CYAN, NEON_GREEN, NEON_YELLOW, NEON_PINK, NEON_ORANGE, NEON_RED,
    FONT_SMALL, FONT_BODY, FONT_BUTTON, FONT_HEADING,
)


# ═══════════════════════════════════════════════════════════════════════
# Data types
# ═══════════════════════════════════════════════════════════════════════

ATTRIBUTE_NAMES: list[str] = [
    "attack", "threat", "speed", "punish",
    "utility", "sponge", "defense", "counter",
]

# Neon attribute colours — vibrant, glow-friendly
ATTRIBUTE_COLORS: list[str] = [
    "#ff6b35",  # attack   — neon orange
    "#f6ae2d",  # threat   — amber
    "#00d4ff",  # speed    — neon cyan
    "#3a86ff",  # punish   — bright blue
    "#b24dff",  # utility  — neon purple
    "#39ff14",  # sponge   — neon green
    "#118ab2",  # defense  — deep cyan
    "#ff6ec7",  # counter  — neon pink
]

# Glowier versions for hover/active state
ATTRIBUTE_COLORS_HOVER: list[str] = [
    "#ff8844", "#fcc04e", "#44eeff", "#5599ff",
    "#cc66ff", "#66ff44", "#3399cc", "#ff88dd",
]

# Neon glow color per attribute (lighter for bloom effect)
ATTRIBUTE_GLOW: list[str] = [
    "#ff8844", "#fcc04e", "#44eeff", "#5599ff",
    "#cc66ff", "#66ff44", "#3399cc", "#ff88dd",
]

# Stat breakdown display colors
STAT_BREAKDOWN_COLORS = {
    "base": "#8b949e",
    "item": NEON_YELLOW,
    "ability": "#b24dff",
    "moves": NEON_CYAN,
    "evs": NEON_GREEN,
}


@dataclass
class PokemonRadialScores:
    """Radar scores + coverage for one Pokemon in a team."""
    pokemon_id: str
    name: str
    # 8 attribute scores (0-100)
    scores: list[float]  # length 8
    # Coverage effectiveness against the opposing set [0, 1]
    # Higher = this Pokemon covers more of the opponent's threats
    coverage: float = 0.5
    # Pokemon type(s) for color coding (1 or 2 elements)
    types: list[str] = field(default_factory=list)


@dataclass
class TeamRadialData:
    """Complete data for a radial team view."""
    # Per-Pokemon scores
    members: list[PokemonRadialScores] = field(default_factory=list)
    # The opposing set IDs being analyzed against (optional)
    opposing_set_ids: list[str] = field(default_factory=list)

    def team_scores(self) -> list[float]:
        """Return the team's aggregate score per attribute (sum of members)."""
        if not self.members:
            return [0.0] * 8
        result = [0.0] * 8
        for m in self.members:
            for i, v in enumerate(m.scores):
                result[i] += v
        return result

    def team_norm_scores(self) -> list[float]:
        """Return team scores normalised so the max is 100."""
        raw = self.team_scores()
        mx = max(raw) if max(raw) > 0 else 1.0
        return [v / mx * 100.0 for v in raw]

    def contribution_amplitudes(self, attr_index: int) -> list[float]:
        """For a given attribute, how much each member contributes (0-100).

        The team's total score for this attribute is the sum.
        Each member's contribution is their score divided by the max
        member score (so the tallest bar fills the full radius).
        """
        raw = [m.scores[attr_index] for m in self.members]
        mx = max(raw) if max(raw) > 0 else 1.0
        return [v / mx * 100.0 for v in raw]

    def coverage_weights(self) -> list[float]:
        """Coverage scores normalised to sum to 1.0 (for angular distribution)."""
        raw = [m.coverage for m in self.members]
        total = sum(raw)
        if total <= 0:
            return [1.0 / len(self.members)] * len(self.members)
        return [v / total for v in raw]

    def type_contributions_for_attr(self, attr_index: int) -> dict[str, float]:
        """Return {type: total_weight} for attribute i based on member contributions.

        Weight per member = contribution amplitude / max_contribution (0-1).
        A dual-typed Pokemon splits weight between both types (60/40).
        """
        if not self.members:
            return {}
        amps = self.contribution_amplitudes(attr_index)
        total = sum(amps)
        if total <= 0:
            return {}
        result: dict[str, float] = {}
        for m, amp in zip(self.members, amps):
            weight = amp / total
            if len(m.types) >= 2:
                result[m.types[0]] = result.get(m.types[0], 0) + weight * 0.6
                result[m.types[1]] = result.get(m.types[1], 0) + weight * 0.4
            elif m.types:
                result[m.types[0]] = result.get(m.types[0], 0) + weight
        return result

    def member_type_color(self, member_idx: int) -> str:
        """Return the primary type color for a member."""
        if self.members is None or member_idx >= len(self.members):
            return "#8b949e"
        m = self.members[member_idx]
        if not m.types:
            return "#8b949e"
        return TYPE_COLORS.get(m.types[0], "#8b949e")

    def member_type_gradient_color(self, member_idx: int) -> str | None:
        """Return the secondary gradient color for a dual-typed member."""
        m = self.members[member_idx]
        if not m.types or len(m.types) < 2:
            return None
        secondary = TYPE_COLORS.get(m.types[1], None)
        if secondary is None:
            return None
        primary = TYPE_COLORS.get(m.types[0], "#8b949e")
        return lerp_color(primary, secondary, 0.35)


# ═══════════════════════════════════════════════════════════════════════
# Geometry helpers

def attribute_angle(index: int, rotation: float = 0.0) -> float:
    """Angle (radians) of attribute #index on the 8-axis radial layout."""
    return index * math.pi / 4 + rotation


def sector_points(center_x: float, center_y: float,
                  radius: float, angle: float,
                  half_width: float = 0.0) -> list[float]:
    """Return polygon points for a radial sector at *angle* (radians).

    If *half_width* > 0, draws a wedge instead of a thin spoke.
    Returns a flat list of [x1, y1, x2, y2, x3, y3, x4, y4] for a
    quadrilateral sector.
    """
    if half_width > 0:
        ang0 = angle - half_width
        ang1 = angle + half_width
        x1 = center_x + radius * math.cos(ang0)
        y1 = center_y - radius * math.sin(ang0)
        x2 = center_x + radius * math.cos(ang1)
        y2 = center_y - radius * math.sin(ang1)
        # Point at origin for filled wedge
        return [center_x, center_y, x1, y1, x2, y2]
    else:
        x = center_x + radius * math.cos(angle)
        y = center_y - radius * math.sin(angle)
        return [center_x, center_y, x, y]


def _wedge_points(cx: float, cy: float,
                  radius: float, mid_angle: float,
                  half_width: float) -> list[float]:
    """Return flat polygon coords for a wedge centred at *mid_angle*."""
    if half_width <= 0 or radius <= 0:
        return [cx, cy, cx, cy]
    ang0 = mid_angle - half_width
    ang1 = mid_angle + half_width
    x1 = cx + radius * math.cos(ang0)
    y1 = cy - radius * math.sin(ang0)
    x2 = cx + radius * math.cos(ang1)
    y2 = cy - radius * math.sin(ang1)
    return [cx, cy, x1, y1, x2, y2]


def lerp_color(c1: str, c2: str, t: float) -> str:
    """Linear interpolate between two hex colors."""
    h1 = c1.lstrip("#")
    h2 = c2.lstrip("#")
    r1, g1, b1 = int(h1[0:2], 16), int(h1[2:4], 16), int(h1[4:6], 16)
    r2, g2, b2 = int(h2[0:2], 16), int(h2[2:4], 16), int(h2[4:6], 16)
    r = int(r1 + (r2 - r1) * t)
    g = int(g1 + (g2 - g1) * t)
    b = int(b1 + (b2 - b1) * t)
    return f"#{r:02x}{g:02x}{b:02x}"


def _alpha_blend(col1: str, col2: str, t: float) -> str:
    """Blend col1→col2 at strength t, return hex color (no alpha channel)."""
    h1 = col1.lstrip("#")
    h2 = col2.lstrip("#")
    r1, g1, b1 = int(h1[0:2], 16), int(h1[2:4], 16), int(h1[4:6], 16)
    r2, g2, b2 = int(h2[0:2], 16), int(h2[2:4], 16), int(h2[4:6], 16)
    r = int(r1 + (r2 - r1) * t)
    g = int(g1 + (g2 - g1) * t)
    b = int(b1 + (b2 - b1) * t)
    return f"#{max(0,min(255,r)):02x}{max(0,min(255,g)):02x}{max(0,min(255,b)):02x}"


def shade_color(hex_color: str, factor: float) -> str:
    """Lighten (factor>1) or darken (factor<1) a hex color."""
    h = hex_color.lstrip("#")
    if len(h) < 6:
        return hex_color
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    if factor >= 1.0:
        t = min(1.0, (factor - 1.0) * 1.4)
        r = int(r + (255 - r) * t)
        g = int(g + (255 - g) * t)
        b = int(b + (255 - b) * t)
    else:
        t = min(1.0, (1.0 - factor) * 1.4)
        r = int(r * (1.0 - t))
        g = int(g * (1.0 - t))
        b = int(b * (1.0 - t))
    return f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"


# ═══════════════════════════════════════════════════════════════════════
# Stat Breakdown Widget — mini card showing score breakdowns
# ═══════════════════════════════════════════════════════════════════════

class StatBreakdownWidget(tk.Frame):
    """Compact stat breakdown card for a single attribute.

    Shows the attribute name, its score, and a breakdown of contributing
    factors (base stat, item, ability, moves, EV investment).
    """

    def __init__(self, parent, attr_name: str, score: float,
                 color: str, breakdown: dict[str, float] | None = None,
                 **kwargs):
        super().__init__(parent, bg=BG_CARD, padx=8, pady=6, **kwargs)
        self._attr_name = attr_name
        self._score = score
        self._color = color
        self._breakdown = breakdown or {}

        # Header row: name + score
        header = tk.Frame(self, bg=BG_CARD)
        header.pack(fill="x")

        tk.Label(header, text=attr_name.upper(), font=("Consolas", 8, "bold"),
                 fg=color, bg=BG_CARD).pack(side="left")

        self._score_label = tk.Label(header, text=f"{score:.0f}",
                                      font=("Consolas", 10, "bold"),
                                      fg=color, bg=BG_CARD)
        self._score_label.pack(side="right")

        # Mini bar
        bar_frame = tk.Frame(self, bg=BG_PANEL, height=4)
        bar_frame.pack(fill="x", pady=(2, 0))
        bar_frame.pack_propagate(False)

        self._bar = tk.Frame(bar_frame, bg=color, width=0)
        self._bar.pack(side="left", fill="y")

        self._bar_frame = bar_frame

    def update_score(self, score: float, breakdown: dict[str, float] | None = None):
        """Update the score and breakdown."""
        self._score = score
        self._score_label.config(text=f"{score:.0f}")
        if breakdown:
            self._breakdown = breakdown
        # Update bar width
        bar_w = max(2, int(self._bar_frame.winfo_width() * min(1.0, score / 100.0)))
        self._bar.config(width=bar_w)


# ═══════════════════════════════════════════════════════════════════════
# Radial bar chart widget — the main graph
# ═══════════════════════════════════════════════════════════════════════

class TeamRadialGraph(tk.Frame):
    """Radial bar chart for single Pokemon or team breakdown.

    **Single mode**: 8 sectors, each showing a 0-100 attribute value.

    **Team mode** (via ``set_team(data)``):
      - The 8 sectors show the **team's normalised aggregate**.
      - Click a sector → it expands to fill the whole circle, showing
        each member's contribution as a radial segment.  Amplitude =
        member contribution (0-100), angular width ∝ coverage weight.
      - Click again (or double-click) to collapse back.

    The expanded-sector animation uses smooth easing interpolation
    driven by ``tk.after``.
    """

    SECTOR_HALF_ANGLE: float = math.pi * 0.85 / 8  # ~19° per sector
    ANIM_FRAMES: int = 16
    ANIM_MS: int = 16  # ~60 fps

    def __init__(self, master, on_sector_hover: Callable | None = None,
                 on_sector_click: Callable | None = None, **kw):
        super().__init__(master, **kw)
        # Data
        self._single_scores: list[float] | None = None  # 8 values for single mode
        self._team_data: TeamRadialData | None = None
        self._expanded_attr: int | None = None   # which sector is expanded (None = collapsed)
        self._anim_progress: float = 0.0          # 0..1 for animation
        self._anim_attr: int | None = None        # which sector being animated
        self._anim_dir: int = 0                   # +1 expanding, -1 collapsing
        self._anim_source_angles: list[float] = []
        self._anim_target_angles: list[float] = []

        # Hover state
        self._hovered_sector: int | None = None
        self._hover_anim_progress: float = 0.0
        self._hover_anim_dir: int = 0

        # Callbacks
        self._on_sector_hover = on_sector_hover
        self._on_sector_click = on_sector_click

        # Rotation animation for idle pulse
        self._idle_rotation: float = 0.0
        self._idle_pulse_phase: float = 0.0

        # Sprite label refs for cleanup
        self._label_refs: list[int] = []

        # Breathing animation state
        self._breath_phase: float = 0.0       # 0..1 sinusoidal phase
        self._breath_dir: int = 1             # +1 or -1
        self._smoke_images: dict[int, tk.PhotoImage] = {}  # cached smoke per sector
        self._smoke_dirty: bool = True        # recompute smoke on next draw
        self._breath_after_id: str | None = None  # after() job id
        self._last_breath_redraw: int = 0     # frame counter for economic redraws
        self._anim_smoke_t: float = 0.0       # 0..1 smoke transition progress during expansion

        self._build()
        self._bind_inputs()

    def _build(self):
        self.config(bg=BG_DARK)
        self.canvas = tk.Canvas(self, bg=BG_DARK, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", lambda _e: self._redraw())

        # Info bar at bottom with neon styling
        info_frame = tk.Frame(self, bg=BG_PANEL, height=24)
        info_frame.pack(side="bottom", fill="x")
        info_frame.pack_propagate(False)

        self.info = tk.Label(
            info_frame, anchor="w", bg=BG_PANEL, fg=FG_SECONDARY,
            font=("Consolas", 8), justify="left", padx=8,
        )
        self.info.pack(side="left", fill="x")

        # Badge for current mode
        self._mode_badge = tk.Label(
            info_frame, text="OVERVIEW", font=("Consolas", 7, "bold"),
            fg=BG_DARK, bg=NEON_CYAN, padx=4, pady=1,
        )
        self._mode_badge.pack(side="right", padx=8)

    def _bind_inputs(self):
        c = self.canvas
        c.bind("<Button-1>", self._on_click)
        c.bind("<Double-Button-1>", self._on_double_click)
        c.bind("<Button-3>", self._on_right_click)
        c.bind("<Key-r>", lambda _e: self._reset_view())
        c.bind("<Key-R>", lambda _e: self._reset_view())
        c.bind("<Motion>", self._on_motion)
        c.bind("<Leave>", self._on_leave)

    # ── public API ───────────────────────────────────────────────

    def set_single(self, scores: list[float] | None,
                   pokemon_name: str = "") -> None:
        """Switch to single-Pokemon mode with 8 attribute scores (0-100)."""
        self._stop_breathing()
        self._single_scores = scores
        self._team_data = None
        self._expanded_attr = None
        self._anim_attr = None
        self._anim_progress = 0.0
        self._hovered_sector = None
        self.info.config(text=f"  {pokemon_name}" if pokemon_name else "  Single Pokémon")
        self._mode_badge.config(text="SINGLE", bg=NEON_ORANGE)
        self._redraw()

    def set_team(self, data: TeamRadialData | None) -> None:
        """Switch to team mode with per-member scores + coverage."""
        self._stop_breathing()
        self._team_data = data
        self._single_scores = None
        self._expanded_attr = None
        self._anim_attr = None
        self._anim_progress = 0.0
        self._hovered_sector = None
        n = len(data.members) if data else 0
        self.info.config(text=f"  Team Analysis · {n} Pokémon  (hover sectors for details · right-click to collapse)")
        self._mode_badge.config(text=f"TEAM ({n})", bg=NEON_GREEN)
        if data is not None:
            self._start_breathing()
        self._redraw()

    def _reset_view(self) -> None:
        self._expanded_attr = None
        self._anim_attr = None
        self._anim_progress = 0.0
        self._hovered_sector = None
        self.info.config(text="  Team Overview  (click sector to expand · right-click to reset)")
        self._redraw()

    # ── motion / hover ───────────────────────────────────────────

    def _on_motion(self, e):
        """Detect which sector the mouse is over and highlight it."""
        if self._team_data is None or not self._team_data.members:
            if self._single_scores is None:
                return
        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        if w < 50 or h < 50:
            return
        cx, cy = w / 2, h / 2
        dx = e.x - cx
        dy = e.y - cy
        dist = math.hypot(dx, dy)
        radius = min(w, h) * 0.40

        inner = radius * 0.08
        if dist < inner or dist > radius:
            if self._hovered_sector is not None:
                self._hovered_sector = None
                self._redraw()
            return

        angle = math.atan2(-dy, dx)
        if angle < 0:
            angle += 2 * math.pi

        sector_span = 2 * math.pi / 8
        idx = int(round(angle / sector_span)) % 8

        if self._hovered_sector != idx:
            self._hovered_sector = idx
            # Update info bar with attribute details
            if self._team_data and idx < len(ATTRIBUTE_NAMES):
                scores = self._team_data.team_norm_scores()
                attr_name = ATTRIBUTE_NAMES[idx].upper()
                attr_score = scores[idx] if idx < len(scores) else 0
                self.info.config(
                    text=f"  {attr_name}: {attr_score:.0f}/100  "
                         f"(click to expand → member breakdown)"
                )
            elif self._single_scores and idx < len(self._single_scores):
                attr_name = ATTRIBUTE_NAMES[idx].upper()
                self.info.config(
                    text=f"  {attr_name}: {self._single_scores[idx]:.0f}/100"
                )
            # Fire callback
            if self._on_sector_hover:
                score = 0
                if self._team_data:
                    scores = self._team_data.team_norm_scores()
                    score = scores[idx] if idx < len(scores) else 0
                elif self._single_scores:
                    score = self._single_scores[idx] if idx < len(self._single_scores) else 0
                self._on_sector_hover(idx, ATTRIBUTE_NAMES[idx], score)
            self._redraw()

    def _on_leave(self, _e):
        if self._hovered_sector is not None:
            self._hovered_sector = None
            if self._team_data:
                self.info.config(text="  Team Analysis · hover sectors for details")
            elif self._single_scores:
                self.info.config(text="  Single Pokémon")
            self._redraw()

    # ── click handling ───────────────────────────────────────────

    def _on_click(self, e):
        """Detect which sector was clicked and toggle expansion."""
        if self._team_data is None or not self._team_data.members:
            # Fire single-mode click
            if self._single_scores is not None:
                w = self.canvas.winfo_width()
                h = self.canvas.winfo_height()
                if w < 50 or h < 50:
                    return
                cx, cy = w / 2, h / 2
                dx = e.x - cx
                dy = e.y - cy
                dist = math.hypot(dx, dy)
                radius = min(w, h) * 0.40
                inner = radius * 0.08
                if dist < inner or dist > radius:
                    return
                angle = math.atan2(-dy, dx)
                if angle < 0:
                    angle += 2 * math.pi
                sector_span = 2 * math.pi / 8
                idx = int(round(angle / sector_span)) % 8
                if self._on_sector_click:
                    self._on_sector_click(idx, ATTRIBUTE_NAMES[idx],
                                          self._single_scores[idx] if idx < len(self._single_scores) else 0)
                self.info.config(text=f"  {ATTRIBUTE_NAMES[idx].upper()}: {self._single_scores[idx]:.0f}/100")
                self._redraw()
            return

        w = self.canvas.winfo_width()
        h = self.canvas.winfo_height()
        if w < 50 or h < 50:
            return
        cx, cy = w / 2, h / 2
        dx = e.x - cx
        dy = e.y - cy
        dist = math.hypot(dx, dy)
        radius = min(w, h) * 0.40

        inner = radius * 0.08
        if dist < inner or dist > radius:
            return

        angle = math.atan2(-dy, dx)
        if angle < 0:
            angle += 2 * math.pi

        sector_span = 2 * math.pi / 8
        idx = int(round(angle / sector_span)) % 8

        # Fire click callback
        if self._on_sector_click and self._team_data:
            scores = self._team_data.team_norm_scores()
            self._on_sector_click(idx, ATTRIBUTE_NAMES[idx],
                                  scores[idx] if idx < len(scores) else 0)

        if self._expanded_attr == idx:
            self._start_animation(self._expanded_attr, -1)
        else:
            self._start_animation(idx, +1)

    def _on_double_click(self, _e):
        """Double-click resets to collapsed view."""
        self._reset_view()

    def _on_right_click(self, _e):
        """Right-click collapses expanded sector or navigates back."""
        if self._anim_attr is not None:
            # Mid-animation: snap to final state immediately
            snapping_expanding = (self._anim_dir > 0)
            self._anim_progress = 1.0
            self._anim_smoke_t = 1.0
            self._anim_attr = None
            # If we were collapsing, snap back to team overview and restart breathing
            if not snapping_expanding:
                self._expanded_attr = None
                self._start_breathing()
                self.info.config(text="  Team Overview · click sector to expand · right-click to collapse")
            self._redraw()
            return
        if self._expanded_attr is not None:
            self._start_animation(self._expanded_attr, -1)
        elif self._team_data is not None:
            # In team overview: nothing to collapse, could navigate back
            pass

    # ── animation engine ─────────────────────────────────────────

    def _start_animation(self, attr_idx: int, direction: int) -> None:
        """Start expanding (+1) or collapsing (-1) sector *attr_idx*."""
        n = len(self._team_data.members) if self._team_data else 1
        if direction > 0:
            self._anim_attr = attr_idx
            self._anim_dir = +1
            self._anim_progress = 0.0
            self._expanded_attr = attr_idx
            # Source: team-mode 8-sector angles
            self._anim_source_angles = self._team_sector_angles(n)
            # Target: expanded full circle, one arc per member
            self._anim_target_angles = self._member_arc_angles(attr_idx)
            self.info.config(
                text=f"  ↕ {ATTRIBUTE_NAMES[attr_idx].upper()} — expanding..."
            )
        else:
            self._anim_dir = -1
            self._anim_progress = 1.0
            self._anim_attr = attr_idx
            # Source: current expanded angles
            self._anim_source_angles = self._member_arc_angles(attr_idx)
            # Target: back to team 8-sector
            self._anim_target_angles = self._team_sector_angles(n)
            self.info.config(text="  Collapsing...")

        if direction > 0:
            self._stop_breathing()
        self._tick_animation()

    def _tick_animation(self) -> None:
        """One frame of the sector-expansion animation."""
        self._anim_progress += 1.0 / self.ANIM_FRAMES
        self._anim_smoke_t = min(1.0, self._anim_progress * 1.4)  # smoke leads slightly
        if self._anim_progress >= 1.0:
            self._anim_progress = 1.0
            self._anim_smoke_t = 1.0
            self._anim_attr = None
            if self._anim_dir < 0:
                self._expanded_attr = None
                self.info.config(text="  Team Overview · click sector to expand · right-click to collapse")
                self._start_breathing()
            else:
                self._stop_breathing()
                n = len(self._team_data.members) if self._team_data else 0
                attr = ATTRIBUTE_NAMES[self._expanded_attr].upper() if self._expanded_attr is not None else ""
                self.info.config(
                    text=f"  {attr} breakdown · {n} members  (right-click to collapse)"
                )
            self._redraw()
            return
        self._redraw()
        self.after(self.ANIM_MS, self._tick_animation)

    # ── breathing animation ─────────────────────────────────────────

    def _start_breathing(self) -> None:
        """Begin continuous breathing animation (team mode only)."""
        if self._breath_after_id is not None:
            return
        self._breath_dir = 1
        self._breath_phase = 0.0
        self._tick_breath()

    def _stop_breathing(self) -> None:
        """Halt breathing animation."""
        if self._breath_after_id is not None:
            self.after_cancel(self._breath_after_id)
            self._breath_after_id = None

    def _tick_breath(self) -> None:
        """One frame of the slow breathing oscillation (~0.3 Hz)."""
        if self._breath_after_id is None:
            return
        # Sinusoidal phase, full cycle ~3 seconds at 50ms interval
        self._breath_phase += 0.016
        if self._breath_phase >= 1.0:
            self._breath_phase = 0.0

        # Economic redraw: only every 3rd frame when not hovering
        self._last_breath_redraw += 1
        if self._hovered_sector is None and self._last_breath_redraw >= 3:
            self._last_breath_redraw = 0
            self._redraw()

        # 50ms between frames ≈ 0.3 Hz breathing
        self._breath_after_id = self.after(50, self._tick_breath)

    # ── smoke rendering ─────────────────────────────────────────────

    def _smoke_color_for_sector(self, attr_idx: int) -> str:
        """Blend of constituent Pokemon type colors for a sector, weighted by coverage."""
        if self._team_data is None or not self._team_data.members:
            return ATTRIBUTE_COLORS[attr_idx]
        amps = self._team_data.contribution_amplitudes(attr_idx)
        weights = self._team_data.coverage_weights()
        total = sum(w * a for w, a in zip(weights, amps))
        if total <= 0:
            return ATTRIBUTE_COLORS[attr_idx]

        r_total, g_total, b_total = 0, 0, 0
        for m, amp, wt in zip(self._team_data.members, amps, weights):
            if not m.types:
                continue
            frac = (wt * amp) / total
            col = TYPE_COLORS.get(m.types[0], "#8b949e")
            h = col.lstrip("#")
            r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
            r_total += r * frac
            g_total += g * frac
            b_total += b * frac

        return f"#{int(r_total):02x}{int(g_total):02x}{int(b_total):02x}"

    def _type_color_for_member(self, member_idx: int) -> tuple[str, str | None]:
        """Return (primary_color, gradient_color_or_None) for a team member."""
        if self._team_data is None:
            return "#8b949e", None
        return (
            self._team_data.member_type_color(member_idx),
            self._team_data.member_type_gradient_color(member_idx),
        )

    def _draw_smoke_sector(self, c: tk.Canvas,
                           cx: float, cy: float,
                           radius: float,
                           attr_idx: int,
                           half_angle: float,
                           breath_phase: float) -> None:
        """Draw a wispy smoke overlay for one team-sector wedge.

        Uses layered semi-transparent polygons in constituent type colors
        with a stipple-like banding pattern for the smoke texture.
        """
        if self._team_data is None or not self._team_data.members:
            return

        amps = self._team_data.contribution_amplitudes(attr_idx)
        weights = self._team_data.coverage_weights()
        ang = attribute_angle(attr_idx)

        # Breathing modulates opacity and radius slightly
        breath = 0.88 + 0.12 * math.sin(breath_phase * 2 * math.pi)

        # Build weighted color list with densities
        member_colors: list[tuple[str, float]] = []
        total = sum(w * a for w, a in zip(weights, amps))
        if total <= 0:
            return

        for m, amp, wt in zip(self._team_data.members, amps, weights):
            if not m.types:
                continue
            density = (wt * amp) / total  # relative fill density
            col = TYPE_COLORS.get(m.types[0], "#8b949e")
            member_colors.append((col, density))

        # Draw smoke as multiple offset layers
        for layer in range(3):
            layer_frac = 0.55 + layer * 0.12
            layer_offset = layer * 2
            opacity = (0.18 - layer * 0.04) * breath

            # Draw each color band as a partial wedge
            cumulative = 0.0
            for col, density in member_colors:
                # Band angular width proportional to density
                band_hw = half_angle * density * 0.9
                smoke_r = radius * layer_frac * breath
                if smoke_r < 2:
                    continue

                # Slight angular offset per layer for smoke wisping
                band_mid = ang - half_angle + cumulative + band_hw + layer_offset * 0.02

                # Darken color to create depth
                dark_col = shade_color(col, 0.65)

                # Create wedge with stipple pattern
                pts = _wedge_points(cx, cy, smoke_r, band_mid, band_hw)
                # Use stipple="gray25" for semi-transparent noise-like texture
                c.create_polygon(
                    *pts,
                    fill=dark_col,
                    outline="",
                    stipple="gray25" if layer == 0 else None,
                )
                cumulative += band_hw * 2

    def _draw_smoke_transition(self, c: tk.Canvas,
                                cx: float, cy: float,
                                radius: float,
                                attr_idx: int,
                                anim_progress: float) -> None:
        """During expansion: smoke flows from sector into constituent colors.

        As anim_progress goes 0→1, the sector's smoke blob expands outward
        then coalesces into the individual member color streams.
        """
        if self._team_data is None or not self._team_data.members:
            return

        t = anim_progress
        # Phase 1 (t 0→0.5): smoke expands and lifts off sector
        # Phase 2 (t 0.5→1): smoke separates into member streams
        expand_t = min(1.0, t * 2.0)
        coalesce_t = max(0.0, (t - 0.5) * 2.0)

        amps = self._team_data.contribution_amplitudes(attr_idx)
        weights = self._team_data.coverage_weights()
        start_angle = attribute_angle(attr_idx) - math.pi
        half_angles = [w * math.pi for w in weights]
        ang = attribute_angle(attr_idx)

        # Smoke center drifts outward during transition
        drift = expand_t * radius * 0.3
        smoke_cx = cx + drift * math.cos(ang) * 0.3
        smoke_cy = cy - drift * math.sin(ang) * 0.3

        # Opacity fades as smoke "leaves" the sector
        smoke_alpha = (1.0 - expand_t) * 0.5
        if smoke_alpha < 0.01:
            return

        # Build color mix
        member_color_list: list[tuple[str, float]] = []
        total = sum(w * a for w, a in zip(weights, amps))
        if total <= 0:
            return
        for m, amp, wt in zip(self._team_data.members, amps, weights):
            if not m.types:
                continue
            density = (wt * amp) / total
            col = TYPE_COLORS.get(m.types[0], "#8b949e")
            member_color_list.append((col, density))

        # Draw expanding smoke blob
        for i, (col, density) in enumerate(member_color_list):
            # Angular band for this member's contribution
            band_hw = self.SECTOR_HALF_ANGLE * density * (1.0 - coalesce_t * 0.5)
            smoke_r = radius * (0.5 + expand_t * 0.4) * density

            ang_mid = start_angle + sum(half_angles[:i]) + half_angles[i]
            pts = _wedge_points(smoke_cx, smoke_cy, smoke_r, ang_mid, band_hw)
            dark_col = shade_color(col, 0.6)
            c.create_polygon(
                *pts, fill=dark_col, outline="",
                stipple="gray12",
            )

    def _team_sector_angles(self, n_members: int) -> list[float]:
        """Return 8 sector angles for the team overview.

        Each sector occupies a fixed angular slot on the 8-axis layout.
        Returns 8 numbers, each representing the half-angle of the sector.
        """
        span = 2 * math.pi * 0.85 / 8
        return [span / 2] * 8

    def _member_arc_angles(self, attr_idx: int) -> list[float]:
        """Return N half-angles for the expanded view of *attr_idx*.

        Each member gets a radial wedge whose angular width is
        proportional to their coverage weight.  The circle is 360°.
        Returns N numbers, each being half the angular width of that
        member's arc.
        """
        if self._team_data is None:
            return [math.pi]  # full circle if no data
        weights = self._team_data.coverage_weights()
        # Total angular budget: full circle (2π) divided among members
        return [w * math.pi for w in weights]  # half-angles for draw

    def _interpolated_angles(self) -> list[float]:
        """Return interpolated half-angles for the current animation frame."""
        if self._anim_attr is None:
            return []
        src = self._anim_source_angles
        tgt = self._anim_target_angles
        t = self._anim_progress
        # Ease-out cubic
        t_eased = 1 - (1 - t) ** 3
        return [s + (tgt_i - s) * t_eased for s, tgt_i in zip(src, tgt)]

    # ── redraw ───────────────────────────────────────────────────

    def _redraw(self) -> None:
        c = self.canvas
        c.delete("all")
        self._label_refs.clear()
        w = c.winfo_width()
        h = c.winfo_height()
        if w < 50 or h < 50:
            return

        # Defensive: stop breathing if in single or expanded mode
        # (should already be stopped but guards against animation edge cases)
        is_expanded = self._expanded_attr is not None
        is_single = self._single_scores is not None
        if (is_expanded or is_single) and self._breath_after_id is not None:
            self._stop_breathing()

        cx, cy = w / 2, h / 2
        radius = min(w, h) * 0.40

        # ── Glow background ───────────────────────────────────────
        glow_r = radius * 1.05
        for i in range(5, 0, -1):
            alpha = 0.02 * i
            c.create_oval(
                cx - glow_r * (1 + 0.02 * i), cy - glow_r * (1 + 0.02 * i),
                cx + glow_r * (1 + 0.02 * i), cy + glow_r * (1 + 0.02 * i),
                outline="", fill="",
            )

        # ── Draw concentric guide rings ────────────────────────
        for pct, dash_style in [(20, (1, 6)), (40, (2, 5)), (60, (2, 4)), (80, (3, 4)), (100, (4, 3))]:
            r = radius * pct / 100
            color = "#1e2330" if pct < 100 else "#2a3040"
            c.create_oval(cx - r, cy - r, cx + r, cy + r,
                          outline=color, width=1, dash=dash_style)

        # ── Draw axis labels for the 8 attribute axes ──────────
        if not is_expanded:
            label_r = radius + 18
            for i in range(8):
                ang = attribute_angle(i)
                lx = cx + label_r * math.cos(ang)
                ly = cy - label_r * math.sin(ang)
                color = ATTRIBUTE_COLORS[i]
                name = ATTRIBUTE_NAMES[i]
                c.create_text(lx, ly, text=name,
                              fill=color, anchor="center",
                              font=("Consolas", 7, "bold"))

        if is_single and not is_expanded:
            self._draw_single(c, cx, cy, radius)
            return

        if is_expanded and self._team_data is not None:
            self._draw_expanded(c, cx, cy, radius)
        elif self._team_data is not None:
            self._draw_team_sectors(c, cx, cy, radius)
        else:
            # No data — show stylish empty state
            c.create_text(cx, cy - 8, text="No data",
                          fill="#484f58", font=("Consolas", 12))
            c.create_text(cx, cy + 14, text="Add Pokémon to see analysis",
                          fill="#484f58", font=("Consolas", 8))

    def _draw_single(self, c: tk.Canvas,
                     cx: float, cy: float, radius: float) -> None:
        """Draw 8 neon spokes for a single Pokemon."""
        scores = self._single_scores
        if scores is None:
            return
        scale = radius / 100.0

        for i, (val, name) in enumerate(zip(scores, ATTRIBUTE_NAMES)):
            ang = attribute_angle(i)
            r = max(val, 0) * scale
            color = ATTRIBUTE_COLORS[i]
            glow_color = ATTRIBUTE_GLOW[i]
            is_hovered = self._hovered_sector == i

            if is_hovered:
                color = ATTRIBUTE_COLORS_HOVER[i]
                r = max(val, 0) * scale * 1.08

            x = cx + r * math.cos(ang)
            y = cy - r * math.sin(ang)

            # Glow line (thicker, behind)
            c.create_line(cx, cy, x, y, fill=glow_color, width=8, capstyle="round")

            # Main spoke line
            c.create_line(cx, cy, x, y, fill=color, width=3 if not is_hovered else 4,
                          capstyle="round")

            # Tip glow dot
            dot_r = 5 if not is_hovered else 7
            c.create_oval(x - dot_r, y - dot_r, x + dot_r, y + dot_r,
                          fill=color, outline=shade_color(color, 1.5), width=1)

            # Label
            if is_hovered:
                label_r = max(r, 14) + 18
                lx = cx + label_r * math.cos(ang)
                ly = cy - label_r * math.sin(ang)
                c.create_text(lx, ly, text=f"{name}\n{val:.0f}",
                              fill=ATTRIBUTE_COLORS_HOVER[i], anchor="center",
                              font=("Consolas", 8, "bold"))
            else:
                label_r = max(r, 14) + 14
                lx = cx + label_r * math.cos(ang)
                ly = cy - label_r * math.sin(ang)
                c.create_text(lx, ly, text=f"{name}\n{val:.0f}",
                              fill=color, anchor="center",
                              font=("Consolas", 7))

    def _draw_team_sectors(self, c: tk.Canvas,
                           cx: float, cy: float, radius: float) -> None:
        """Draw 8 filled wedges, one per attribute, for the team overview.

        Each wedge is colored with a smoke fill derived from the constituent
        Pokemon type colors, with a gentle breathing animation overlay.
        """
        if self._team_data is None:
            return
        scores = self._team_norm_scores()
        breath = self._breath_phase  # 0..1 for breathing modulation

        for i, (val, name) in enumerate(zip(scores, ATTRIBUTE_NAMES)):
            ang = attribute_angle(i)
            r = max(val, 0) * radius / 100.0
            # Base color on attribute, but tinted by constituent Pokemon types
            attr_color = ATTRIBUTE_COLORS[i]
            smoke_col = self._smoke_color_for_sector(i)
            color = smoke_col  # type-colored sector
            is_hovered = self._hovered_sector == i

            if is_hovered:
                color = ATTRIBUTE_COLORS_HOVER[i]
                r = max(val, 0) * radius / 100.0 * 1.08

            half_a = self.SECTOR_HALF_ANGLE

            # ── Smoke fill (type-colored wispy base) ─────
            # Draw first so it sits behind the crisp wedge
            self._draw_smoke_sector(c, cx, cy, r * 1.05, i, half_a * 1.05, breath)

            # ── Glow layer (behind wedge) ──────────────────
            glow_r = r * 1.1
            glow_pts = _wedge_points(cx, cy, glow_r, ang, half_a * 1.1)
            glow_color = shade_color(smoke_col, 1.4)  # tinted by smoke color
            c.create_polygon(*glow_pts, fill=glow_color, outline="")

            # ── Wedge fill ────────────────────────────────
            pts = _wedge_points(cx, cy, r, ang, half_a)
            # Use type-smoke color for fill with breathing opacity
            if is_hovered:
                c.create_polygon(*pts, fill=shade_color(color, 0.85),
                                 outline=color, width=2)
            else:
                # Breathing: subtle radius pulse + smoke-blend fill
                r_breath = r * (1.0 + 0.04 * math.sin(breath * 2 * math.pi))
                pts = _wedge_points(cx, cy, r_breath, ang, half_a)
                fill_col = _alpha_blend(smoke_col, attr_color, 0.35)
                c.create_polygon(*pts, fill=shade_color(fill_col, 0.70),
                                 outline=shade_color(smoke_col, 1.25),
                                 width=1)

            # ── Inner highlight for depth ────────────────
            inner_r = r * 0.82
            inner_pts = _wedge_points(cx, cy, inner_r, ang, half_a * 0.82)
            c.create_polygon(*inner_pts, fill=shade_color(smoke_col, 1.25),
                             outline="", stipple="gray50")

            # ── Sparkle highlight on hover ──────────────
            if is_hovered:
                sparkle_r = r * 0.5
                sx = cx + sparkle_r * math.cos(ang)
                sy = cy - sparkle_r * math.sin(ang)
                c.create_oval(sx - 3, sy - 3, sx + 3, sy + 3,
                              fill="#ffffff", outline="")
                # Extra brightness line
                c.create_line(cx, cy,
                              cx + r * 1.1 * math.cos(ang),
                              cy - r * 1.1 * math.sin(ang),
                              fill="#ffffff", width=2, dash=(2, 3))

            # ── Value label at tip ────────────────────────
            label_r = r + 16
            lx = cx + label_r * math.cos(ang)
            ly = cy - label_r * math.sin(ang)
            c.create_text(lx, ly, text=f"{val:.0f}",
                          fill=color, anchor="center",
                          font=("Consolas", 9, "bold") if is_hovered else ("Consolas", 8))

        # ── Center hub glow ──────────────────────────────────────
        c.create_oval(cx - 6, cy - 6, cx + 6, cy + 6,
                      fill="#161b22", outline=NEON_CYAN, width=1)

        # ── Click hint ──────────────────────────────────────────
        c.create_text(cx, cy - radius - 20, text="Click sector → member breakdown",
                      fill="#484f58", font=("Consolas", 7), anchor="s")

    def _draw_expanded(self, c: tk.Canvas,
                       cx: float, cy: float, radius: float) -> None:
        """Draw the expanded breakdown for one attribute.

        Full circle of radial segments, one per team member.
        Each member is colored by their primary Pokemon type with a
        gradient overlay for dual-typed Pokemon.  During expansion,
        smoke flows from the sector and combines into these color wedges.
        """
        if self._team_data is None or self._expanded_attr is None:
            return

        attr_idx = self._expanded_attr
        amplitudes = self._team_data.contribution_amplitudes(attr_idx)
        names = [m.name for m in self._team_data.members]
        scores_raw = [m.scores[attr_idx] for m in self._team_data.members]

        # Determine half-angles
        anim_t = 0.0
        if self._anim_attr == attr_idx and self._anim_progress < 1.0:
            half_angles = self._interpolated_angles()
            anim_t = self._anim_progress
        else:
            half_angles = [w * math.pi for w in self._team_data.coverage_weights()]

        # Starting angle (rotate so the 8-sector position is aligned)
        start_angle = attribute_angle(attr_idx) - math.pi
        cumulative = start_angle

        scale = radius / 100.0
        breath = self._breath_phase

        # During expansion: draw smoke transition first
        if anim_t > 0 and anim_t < 1.0:
            self._draw_smoke_transition(c, cx, cy, radius, attr_idx, anim_t)

        for i, (amp, hw, name, raw_score) in enumerate(
                zip(amplitudes, half_angles, names, scores_raw)):
            r = max(amp, 0) * scale
            ang_mid = cumulative + hw
            # Type-based color: primary type of the Pokemon
            base_color, grad_color = self._type_color_for_member(i)
            is_hovered = self._hovered_sector == i

            # Breathing modulation
            breath_r = r * (1.0 + 0.03 * math.sin(breath * 2 * math.pi))
            if is_hovered:
                breath_r = max(amp, 0) * scale * 1.05
                base_color = ATTRIBUTE_COLORS_HOVER[attr_idx]  # use bright version

            # ── Gradient overlay for dual-type ──────────────
            if grad_color is not None:
                # Draw primary wedge
                pts = _wedge_points(cx, cy, breath_r, ang_mid, hw)
                c.create_polygon(*pts, fill=shade_color(base_color, 0.80),
                                 outline="#0d1117" if not is_hovered else base_color,
                                 width=1 if not is_hovered else 2)
                # Gradient overlay: second wedge at slightly different angle, semi-transparent
                grad_hw = hw * 0.75
                grad_offset = hw * 0.3  # offset slightly
                grad_mid = ang_mid + grad_offset
                grad_r = breath_r * 0.92
                grad_pts = _wedge_points(cx, cy, grad_r, grad_mid, grad_hw)
                c.create_polygon(*grad_pts, fill=shade_color(grad_color, 0.75),
                                 outline="", stipple="gray50")
            else:
                # Single type: simple solid fill
                pts = _wedge_points(cx, cy, breath_r, ang_mid, hw)
                c.create_polygon(*pts, fill=shade_color(base_color, 0.82),
                                 outline="#0d1117" if not is_hovered else base_color,
                                 width=1 if not is_hovered else 2)

            # ── Glow behind ────────────────────────────────
            glow_r = breath_r * 1.1
            glow_pts = _wedge_points(cx, cy, glow_r, ang_mid, hw * 1.08)
            glow_c = shade_color(base_color, 1.5) if grad_color is None else shade_color(grad_color, 1.3)
            c.create_polygon(*glow_pts, fill=glow_c, outline="")

            # ── Label at midpoint ─────────────────────────
            label_r = max(breath_r, 12) + 16
            lx = cx + label_r * math.cos(ang_mid)
            ly = cy - label_r * math.sin(ang_mid)
            pct = f"{amp:.0f}"
            c.create_text(lx, ly, text=f"{name}\n{pct}",
                          fill=base_color, anchor="center",
                          font=("Consolas", 8, "bold") if is_hovered else ("Consolas", 7))

            cumulative += 2 * hw

        # ── Attribute name at centre with glow ────────────────
        attr_name = ATTRIBUTE_NAMES[attr_idx].upper()
        c.create_text(cx, cy - 6, text=attr_name,
                      fill=ATTRIBUTE_COLORS[attr_idx],
                      font=("Consolas", 10, "bold"))
        c.create_text(cx, cy + 8, text="right-click to collapse",
                      fill="#484f58", font=("Consolas", 7))

        # ── Center hub ────────────────────────────────────────
        c.create_oval(cx - 5, cy - 5, cx + 5, cy + 5,
                      fill="#0d1117", outline=ATTRIBUTE_COLORS[attr_idx], width=2)

    def _team_norm_scores(self) -> list[float]:
        """Return the team's aggregate scores normalised to 0-100."""
        if self._team_data is None:
            return [0.0] * 8
        return self._team_data.team_norm_scores()


# ═══════════════════════════════════════════════════════════════════════
# Formula loader (reads from Obsidian)
# ═══════════════════════════════════════════════════════════════════════

_TEAM_RADIAL_FORMULAS: dict | None = None


def load_team_radial_formulas() -> dict:
    """Load team-radial formula constants from the Obsidian vault.

    Looks for ``Hermes Memory/team_radial_formulas.md``.  Returns a
    dict of formula specs (same structure as attribute_formulas.md).
    Falls back to built-in defaults if the file cannot be read.
    """
    global _TEAM_RADIAL_FORMULAS
    if _TEAM_RADIAL_FORMULAS is not None:
        return _TEAM_RADIAL_FORMULAS

    default = {
        "coverage_exponent": 1.5,
        "coverage_magnitude": 0.8,
        "score_aggregation": "sum",
        "min_contribution_pct": 5.0,
    }

    import pathlib
    vault_path = pathlib.Path("/d/PokeRedus/Hermes Memory/team_radial_formulas.md")
    try:
        text = vault_path.read_text(encoding="utf-8")
        formulas: dict = {}
        for line in text.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" in line:
                key, _, val = line.partition(":")
                key = key.strip().strip('"').strip("'")
                val = val.strip().strip('"').strip("'")
                try:
                    formulas[key] = float(val)
                except ValueError:
                    formulas[key] = val
        if formulas:
            _TEAM_RADIAL_FORMULAS = formulas
            return formulas
    except (FileNotFoundError, IOError, OSError):
        pass

    _TEAM_RADIAL_FORMULAS = dict(default)
    return _TEAM_RADIAL_FORMULAS


# ═══════════════════════════════════════════════════════════════════════
# Stat Breakdown Display Widget — shows detailed attribute breakdowns
# ═══════════════════════════════════════════════════════════════════════

class StatsBreakdownPanel(tk.Frame):
    """Panel showing detailed stat breakdowns for each attribute.

    Layout:
      ┌──────────────────────────────────────┐
      │  ATTRIBUTE BREAKDOWN                  │
      │  ┌─────────┐  ┌─────────┐            │
      │  │ attack  │  │ threat  │            │
      │  │ ████ 72 │  │ ████ 84 │            │
      │  └─────────┘  └─────────┘            │
      │  ┌─────────┐  ┌─────────┐            │
      │  │ speed   │  │ punish  │            │
      │  │ ████ 88 │  │ ████ 65 │            │
      │  └─────────┘  └─────────┘            │
      │  ...                                  │
      └──────────────────────────────────────┘
    """

    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=BG_PANEL, padx=10, pady=8, **kwargs)

        # Header
        header = tk.Frame(self, bg=BG_PANEL)
        header.pack(fill="x", pady=(0, 6))

        tk.Label(header, text="ATTRIBUTE BREAKDOWN",
                 font=("Consolas", 9, "bold"), fg=NEON_CYAN,
                 bg=BG_PANEL).pack(side="left")

        # Build 2x4 grid of stat cards
        self._cards: list[StatBreakdownCard] = []
        grid = tk.Frame(self, bg=BG_PANEL)
        grid.pack(fill="both", expand=True)

        for i, (name, color) in enumerate(zip(ATTRIBUTE_NAMES, ATTRIBUTE_COLORS)):
            r, c = i // 2, i % 2
            card = StatBreakdownCard(grid, name, color)
            card.grid(row=r, column=c, padx=2, pady=2, sticky="nsew")
            self._cards.append(card)

        for r in range(4):
            grid.rowconfigure(r, weight=1)
        grid.columnconfigure(0, weight=1)
        grid.columnconfigure(1, weight=1)

    def update_scores(self, scores: list[float], team_data: TeamRadialData | None = None):
        """Update all stat cards with new scores."""
        for i, card in enumerate(self._cards):
            val = scores[i] if i < len(scores) else 0
            card.update(val, team_data, i)

    def highlight(self, attr_index: int):
        """Highlight a specific attribute card."""
        for i, card in enumerate(self._cards):
            card.set_highlighted(i == attr_index)


class StatBreakdownCard(tk.Frame):
    """A single stat breakdown card showing attribute value + mini bar."""

    def __init__(self, parent, name: str, color: str):
        super().__init__(parent, bg=BG_CARD, padx=6, pady=4)
        self._name = name
        self._color = color
        self._highlighted = False

        # Name + value row
        top = tk.Frame(self, bg=BG_CARD)
        top.pack(fill="x")

        tk.Label(top, text=name.upper(), font=("Consolas", 7, "bold"),
                 fg=color, bg=BG_CARD).pack(side="left")

        self._val_label = tk.Label(top, text="--", font=("Consolas", 9, "bold"),
                                    fg=color, bg=BG_CARD)
        self._val_label.pack(side="right")

        # Mini bar
        self._bar_bg = tk.Frame(self, bg=BG_PANEL, height=4)
        self._bar_bg.pack(fill="x", pady=(2, 0))
        self._bar_bg.pack_propagate(False)

        self._bar = tk.Frame(self._bar_bg, bg=color, width=0)
        self._bar.pack(side="left", fill="y")

        # Contribution info
        self._contrib_label = tk.Label(
            self, text="", font=("Consolas", 6), fg=FG_DIM, bg=BG_CARD,
        )
        self._contrib_label.pack(anchor="w")

    def update(self, value: float, team_data: TeamRadialData | None, attr_idx: int):
        """Update the card value and bar width."""
        self._val_label.config(text=f"{value:.0f}")
        bar_w = max(2, int(self._bar_bg.winfo_width() * min(1.0, value / 100.0))) if self._bar_bg.winfo_width() > 10 else int(value * 1.5)
        self._bar.config(width=bar_w)

        # Show contributions if team data available
        if team_data and team_data.members:
            amps = team_data.contribution_amplitudes(attr_idx)
            parts = []
            for m, a in zip(team_data.members, amps):
                if a > 5:
                    parts.append(f"{m.name}={a:.0f}")
            self._contrib_label.config(text=", ".join(parts[:3]))
        else:
            self._contrib_label.config(text="")

    def set_highlighted(self, highlighted: bool):
        self._highlighted = highlighted
        if highlighted:
            self.config(bg=BG_SELECTED)
            for w in self.winfo_children():
                try:
                    w.config(bg=BG_SELECTED)
                except tk.TclError:
                    pass
        else:
            self.config(bg=BG_CARD)
            for w in self.winfo_children():
                try:
                    w.config(bg=BG_CARD)
                except tk.TclError:
                    pass


# ═══════════════════════════════════════════════════════════════════════
# Page-level widget
# ═══════════════════════════════════════════════════════════════════════

class MatchupGraphPage(tk.Frame):
    """Full-page radial graph view.

    Layout:
      ┌─────────────────────────────────────────────┐
      │   Title / Back / Home / Team Overview       │
      ├────────┬────────────────────────────────────┤
      │        │                                    │
      │  List  │  Graph (TeamRadialGraph)           │
      │        │                                    │
      │        ├────────────────────────────────────┤
      │        │  Stat Breakdown Panel              │
      ├────────┴────────────────────────────────────┤
      │  Info bar / Status                          │
      └─────────────────────────────────────────────┘

    The list shows one row per Pokémon; clicking a Pokémon shows
    its 8-sector single view.  The 'Team Overview' button at the
    top switches to team-aggregate mode.
    """

    def __init__(self, master, kg=None, matchup_cache=None,
                 go_home=None, focus_set_ids=None,
                 focus_team_name=None, on_back_to_team=None, **kwargs):
        super().__init__(master, bg=BG_DARK, **kwargs)
        self.kg = kg
        self._go_home = go_home
        self._on_back = on_back_to_team
        self._focus_set_ids = list(focus_set_ids) if focus_set_ids else []
        self._focus_team_name = focus_team_name

        self._current_pokemon_id: str | None = None
        self._team_data: TeamRadialData | None = None

        self._build_toolbar()
        self._build_body()

    def _build_toolbar(self):
        bar = tk.Frame(self, bg=BG_PANEL, height=44)
        bar.pack(side="top", fill="x")
        bar.pack_propagate(False)

        # Back button
        if self._on_back is not None:
            btn = tk.Button(bar, text="← Back", font=FONT_BUTTON,
                            fg=NEON_CYAN, bg=BG_PANEL,
                            activebackground=BG_HOVER,
                            activeforeground=NEON_CYAN,
                            bd=0, cursor="hand2",
                            command=self._on_back)
            btn.pack(side="left", padx=8, pady=6)
        elif self._go_home is not None:
            btn = tk.Button(bar, text="← Home", font=FONT_BUTTON,
                            fg=NEON_CYAN, bg=BG_PANEL,
                            activebackground=BG_HOVER,
                            activeforeground=NEON_CYAN,
                            bd=0, cursor="hand2",
                            command=self._go_home)
            btn.pack(side="left", padx=8, pady=6)

        # Title
        title = self._focus_team_name or (
            f"Matchup Graph  ·  {len(self._focus_set_ids)} sets"
            if self._focus_set_ids else "Matchup Graph"
        )
        tk.Label(bar, text=title, font=FONT_HEADING,
                 fg=NEON_PINK, bg=BG_PANEL
                 ).pack(side="left", padx=8)

        # Right side buttons
        btn_frame = tk.Frame(bar, bg=BG_PANEL)
        btn_frame.pack(side="right", padx=8, pady=6)

        self._team_btn = tk.Button(
            btn_frame, text="Team Overview", font=FONT_BUTTON,
            fg=BG_DARK, bg=NEON_GREEN,
            activebackground=NEON_GREEN,
            activeforeground=BG_DARK,
            bd=0, padx=10, pady=2, cursor="hand2",
            command=self._show_team_view,
        )
        self._team_btn.pack(side="left", padx=2)

        if self._go_home is not None:
            tk.Button(btn_frame, text="Home", font=FONT_BUTTON,
                      fg=NEON_CYAN, bg=BG_CARD,
                      activebackground=BG_HOVER,
                      activeforeground=NEON_CYAN,
                      bd=0, padx=10, pady=2, cursor="hand2",
                      command=self._go_home
                      ).pack(side="left", padx=2)

    def _build_body(self):
        # Main content area: list (left) + graph+stats (right)
        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True)

        body.columnconfigure(0, weight=0, minsize=240)
        body.columnconfigure(1, weight=1)
        body.rowconfigure(0, weight=1)

        # ── Left: Pokemon set list with neon styling ─────────────
        left = tk.Frame(body, bg=BG_PANEL, width=240)
        left.grid(row=0, column=0, sticky="nsew", padx=(0, 1))
        left.grid_propagate(False)

        # Header
        list_header = tk.Frame(left, bg=BG_PANEL, height=32)
        list_header.pack(fill="x")
        list_header.pack_propagate(False)

        tk.Label(list_header, text="POKÉMON", font=("Consolas", 9, "bold"),
                 fg=NEON_CYAN, bg=BG_PANEL
                 ).pack(side="left", padx=10, pady=6)

        self._list_count = tk.Label(
            list_header, text="", font=("Consolas", 8),
            fg=FG_DIM, bg=BG_PANEL,
        )
        self._list_count.pack(side="right", padx=10, pady=6)

        # Search / filter bar
        filter_bar = tk.Frame(left, bg=BG_PANEL, height=28)
        filter_bar.pack(fill="x")
        filter_bar.pack_propagate(False)

        self._search_var = tk.StringVar()
        self._search_var.trace_add("write", lambda *_: self._filter_list())
        entry = tk.Entry(filter_bar, textvariable=self._search_var,
                         font=("Consolas", 8), bg=BG_INPUT, fg=FG_PRIMARY,
                         insertbackground=FG_PRIMARY, relief="flat")
        entry.pack(fill="x", padx=6, pady=2, ipady=2)
        entry.insert(0, "")
        # Placeholder effect
        entry.bind("<FocusIn>", lambda e: (
            entry.delete(0, "end") if entry.get() == "Filter..." else None
        ))

        # Listbox with custom styling
        list_outer = tk.Frame(left, bg=BG_PANEL)
        list_outer.pack(fill="both", expand=True, padx=4, pady=(0, 4))

        self._listbox = tk.Listbox(
            list_outer, bg=BG_DARK, fg=FG_PRIMARY,
            selectbackground="#1a2744", selectforeground=NEON_CYAN,
            font=("Consolas", 9),
            relief="flat", borderwidth=0,
            highlightthickness=0,
            activestyle="none",
        )
        sb = tk.Scrollbar(list_outer, orient="vertical",
                          command=self._listbox.yview,
                          bg="#000000", troughcolor="#000000",
                          activebackground=NEON_CYAN,
                          highlightthickness=0, bd=0, width=8)
        self._listbox.configure(yscrollcommand=sb.set)

        self._listbox.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self._listbox.bind("<<ListboxSelect>>", self._on_list_select)
        self._listbox.bind("<MouseWheel>",
                           lambda e: self._listbox.yview_scroll(
                               -1 * (e.delta // 120), "units"))

        # ── Right: graph + stat breakdown ────────────────────────
        right = tk.Frame(body, bg=BG_DARK)
        right.grid(row=0, column=1, sticky="nsew")
        right.rowconfigure(0, weight=3)
        right.rowconfigure(1, weight=0, minsize=180)
        right.columnconfigure(0, weight=1)

        # Graph area
        graph_frame = tk.Frame(right, bg=BG_DARK)
        graph_frame.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)

        self._graph = TeamRadialGraph(
            graph_frame,
            on_sector_hover=self._on_sector_hover,
            on_sector_click=self._on_sector_click,
        )
        self._graph.pack(fill="both", expand=True)

        # Stat breakdown panel (bottom)
        self._stats_panel = StatsBreakdownPanel(right)
        self._stats_panel.grid(row=1, column=0, sticky="nsew", padx=4, pady=(0, 4))

        # Populate list from focus set ids
        self._populate_list()

    def _on_sector_hover(self, idx: int, name: str, score: float):
        """Called when user hovers a sector."""
        self._stats_panel.highlight(idx)

    def _on_sector_click(self, idx: int, name: str, score: float):
        """Called when user clicks a sector."""
        # Update stats panel to show detailed view
        self._stats_panel.highlight(idx)

    # ── list population ──────────────────────────────────────────

    def _populate_list(self) -> None:
        """Populate the list box from focus set IDs."""
        self._listbox.delete(0, "end")
        self._pokemon_records: list[tuple[str, str, str]] = []  # (pokemon_id, name, set_id)

        if self.kg is None:
            return

        seen: dict[str, str] = {}  # pokemon_id -> first set_id
        for sid in self._focus_set_ids:
            s = self.kg.get_set(sid)
            if s is None:
                continue
            pid = s.pokemon_id
            if pid not in seen:
                seen[pid] = sid
                p = self.kg.get_pokemon(pid)
                name = p.name if p else pid
                self._pokemon_records.append((pid, name, sid))
                self._listbox.insert("end", name)

        self._list_count.config(text=f"{len(self._pokemon_records)}")

        # Auto-show team overview
        self._show_team_view()

    def _filter_list(self):
        query = self._search_var.get().strip().lower()
        self._listbox.delete(0, "end")
        filtered_records = []
        for pid, name, sid in self._pokemon_records:
            if not query or query in name.lower():
                filtered_records.append((pid, name, sid))
                self._listbox.insert("end", name)
        self._pokemon_records = filtered_records

    # ── callbacks ────────────────────────────────────────────────

    def _on_list_select(self, _e=None):
        sel = self._listbox.curselection()
        if not sel or not self.kg:
            return
        idx = sel[0]
        if idx >= len(self._pokemon_records):
            return
        pid, name, sid = self._pokemon_records[idx]
        self._current_pokemon_id = pid
        self._show_single_pokemon(pid, name)

    def _show_single_pokemon(self, pokemon_id: str, name: str) -> None:
        """Show the 8-sector view for one Pokemon."""
        if self.kg is None:
            return
        p = self.kg.get_pokemon(pokemon_id)
        if p is None:
            return
        # Get primary set
        s = self.kg.get_primary_set(pokemon_id)
        if s is None:
            sets = self.kg.get_sets(pokemon_id)
            if sets:
                s = sets[0]
        if s is None:
            self._graph.set_single(None)
            return

        # Compute 8 radar values
        try:
            from pokeredus.graph.radar_attributes import compute_radar_8
            radar = compute_radar_8(s, p, self.kg)
            scores = [radar[n] for n in ATTRIBUTE_NAMES]
        except Exception:
            scores = None

        self._graph.set_single(scores, pokemon_name=name)

        # Update stats panel with single scores
        if scores:
            self._stats_panel.update_scores(scores)
            self._team_btn.config(text="← Team Overview")

    def _show_team_view(self) -> None:
        """Build TeamRadialData from focus sets and show team overview."""
        if self.kg is None or not self._focus_set_ids:
            return
        members: list[PokemonRadialScores] = []
        try:
            from pokeredus.graph.radar_attributes import compute_radar_8
        except ImportError:
            compute_radar_8 = None

        for sid in self._focus_set_ids:
            s = self.kg.get_set(sid)
            if s is None:
                continue
            p = self.kg.get_pokemon(s.pokemon_id)
            if p is None:
                continue
            scores = [0.0] * 8
            if compute_radar_8 is not None:
                try:
                    radar = compute_radar_8(s, p, self.kg)
                    scores = [radar[n] for n in ATTRIBUTE_NAMES]
                except Exception:
                    pass

            # Coverage: how many matchups this set wins
            formulas = load_team_radial_formulas()
            coverage_exp = formulas.get("coverage_exponent", 1.5)
            coverage_mag = formulas.get("coverage_magnitude", 0.8)

            matchups = self.kg.get_matchups(sid, min_confidence=0.0)
            if matchups:
                n_favorable = sum(
                    1 for m in matchups
                    if getattr(m, "score", 0) > 0
                )
                raw_coverage = n_favorable / max(len(matchups), 1)
            else:
                raw_coverage = 0.0
            # Apply formula from vault
            coverage = min(1.0, (raw_coverage ** coverage_exp) * coverage_mag + 0.1)

            members.append(PokemonRadialScores(
                pokemon_id=s.pokemon_id,
                name=p.name,
                scores=scores,
                coverage=coverage,
            ))

        data = TeamRadialData(members=members, opposing_set_ids=[])
        self._team_data = data
        self._graph.set_team(data)

        # Update stats panel with team scores
        team_scores = data.team_norm_scores()
        self._stats_panel.update_scores(team_scores, data)

        self._team_btn.config(text="Team Overview")
        self._current_pokemon_id = None

        # Update the listbox selection to none
        self._listbox.selection_clear(0, "end")