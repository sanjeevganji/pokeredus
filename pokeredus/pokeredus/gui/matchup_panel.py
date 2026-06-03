"""
matchup_panel — Team analysis panel for the team builder.

Provides a self-contained panel that combines:
  * A miniature 3D graph of the current team + its relations to the meta
  * Quick stat summaries (set scores, coverage, type balance)
  * A dynamic "Open Full Analysis" link that jumps to the main
    MatchupGraphPage with the current team highlighted

The panel is "live": any team change in the parent TeamBuilderPage is
forwarded to ``update_team(team_set_ids)`` and the graph + stats
recompute automatically.
"""

from __future__ import annotations

import math
import tkinter as tk
from tkinter import ttk
from typing import Callable, Iterable

from pokeredus.gui.theme import (
    BG_DARK, BG_PANEL, BG_CARD, BG_INPUT, BG_HOVER,
    FG_PRIMARY, FG_SECONDARY, FG_DIM,
    TYPE_COLORS, MATCHUP_WIN, MATCHUP_LOSE, MATCHUP_NEUTRAL,
    NEON_CYAN, NEON_GREEN, NEON_YELLOW, NEON_PINK, NEON_ORANGE, NEON_RED,
    FONT_SMALL, FONT_BODY, FONT_BODY_BOLD, FONT_HEADING, FONT_BUTTON,
)
# TODO(matchup-graph-3d): rewire in Task 15/16 — the new view widget
# exposes MatchupGraphView with set_set(pokemon_id, set_id).  The mini
# graph in this panel will become a small MatchupGraph2D instance.
from pokeredus.gui.matchup_graph_view import MiniGraph3DCanvas  # noqa: F401


# ═══════════════════════════════════════════════════════════════════════
# SCORE BAR — small horizontal bar showing a 0..1 score
# ═══════════════════════════════════════════════════════════════════════

class ScoreBar(tk.Canvas):
    """A tiny stat bar that fills left-to-right with a colored bar."""

    def __init__(self, parent, width=140, height=10, **kwargs):
        super().__init__(
            parent, width=width, height=height,
            bg=BG_PANEL, highlightthickness=0, bd=0, **kwargs,
        )
        self._w = width
        self._h = height
        self._value = 0.0
        self._color = NEON_CYAN
        self.bind("<Configure>", lambda e: self._draw())

    def set(self, value: float, color: str = NEON_CYAN) -> None:
        self._value = max(0.0, min(1.0, float(value)))
        self._color = color
        self._draw()

    def _draw(self) -> None:
        self.delete("all")
        w = self.winfo_width() or self._w
        h = self.winfo_height() or self._h
        # Track
        self.create_rectangle(0, 0, w, h, fill=BG_INPUT, outline="")
        # Fill
        fw = int(w * self._value)
        if fw > 0:
            # Slight gradient effect via two layers
            self.create_rectangle(0, 0, fw, h, fill=self._color, outline="")
            self.create_rectangle(0, 0, fw, h // 2, fill=shade_color(self._color, 1.3), outline="")


def shade_color(hex_color: str, factor: float) -> str:
    """Lighten (factor>1) or darken (factor<1) a hex color toward white/black."""
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
# TEAM ANALYSIS PANEL
# ═══════════════════════════════════════════════════════════════════════

class TeamAnalysisPanel(tk.Frame):
    """Compact analysis panel for the team builder.

    Layout:
      ┌──────────────────────────────────┐
      │ Team Analysis      [Open full →] │
      │ ┌──────────────────────────────┐ │
      │ │  mini 3D graph (300×180)     │ │
      │ └──────────────────────────────┘ │
      │ Team score      ████░░░░  0.62   │
      │ Coverage        ██████░░  0.78   │
      │ Synergy         ██████░░  0.81   │
      │ Type balance: 12 types, no ice   │
      └──────────────────────────────────┘
    """

    def __init__(
        self,
        parent,
        kg,
        matchup_cache=None,
        on_open_full: Callable[[list[str]], None] | None = None,
    ):
        super().__init__(parent, bg=BG_PANEL)
        self.kg = kg
        self.matchup_cache = matchup_cache
        self._on_open_full = on_open_full  # called with team set ids

        # Current team state
        self._team_set_ids: list[str] = []
        self._pokemon_data: list[dict] = []  # [{name, types, score, coverage}, ...]

        self._build_ui()

    # ── UI ──────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        # Header
        header = tk.Frame(self, bg=BG_PANEL)
        header.pack(fill="x", padx=10, pady=(10, 4))

        tk.Label(
            header, text="Team Analysis", font=FONT_HEADING,
            fg=NEON_CYAN, bg=BG_PANEL,
        ).pack(side="left")

        self._open_link = tk.Label(
            header, text="Open full graph  →",
            font=FONT_BODY_BOLD, fg=NEON_PINK, bg=BG_PANEL,
            cursor="hand2",
        )
        self._open_link.pack(side="right")
        self._open_link.bind("<Button-1>", lambda e: self._trigger_open_full())
        self._open_link.bind("<Enter>",
            lambda e: self._open_link.config(fg=NEON_YELLOW))
        self._open_link.bind("<Leave>",
            lambda e: self._open_link.config(fg=NEON_PINK))

        # Mini graph container
        graph_frame = tk.Frame(self, bg=BG_PANEL)
        graph_frame.pack(fill="x", padx=10, pady=4)

        self._mini_graph = MiniGraph3DCanvas(
            graph_frame, self.kg, self.matchup_cache,
            width=320, height=200,
        )
        self._mini_graph.pack(fill="x")

        # "Click graph to open full" hint label
        self._hint = tk.Label(
            self, text="",
            font=FONT_SMALL, fg=FG_DIM, bg=BG_PANEL,
        )
        self._hint.pack(anchor="w", padx=10, pady=(0, 2))

        # Separator
        tk.Frame(self, bg=BG_CARD, height=1).pack(fill="x", padx=10, pady=6)

        # Stat bars
        stats = tk.Frame(self, bg=BG_PANEL)
        stats.pack(fill="x", padx=10)

        self._team_score_bar = self._make_stat_row(
            stats, "Team score", NEON_CYAN,
        )
        self._coverage_bar = self._make_stat_row(
            stats, "Coverage", NEON_GREEN,
        )
        self._synergy_bar = self._make_stat_row(
            stats, "Synergy", NEON_PINK,
        )
        self._threat_score_bar = self._make_stat_row(
            stats, "vs Meta", NEON_ORANGE,
        )

        # Type balance text
        self._type_text = tk.Label(
            self, text="", font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_PANEL,
            justify="left", anchor="w",
        )
        self._type_text.pack(fill="x", padx=10, pady=(8, 6))

        # Set list (mini)
        self._sets_label = tk.Label(
            self, text="", font=FONT_SMALL, fg=FG_DIM, bg=BG_PANEL,
            justify="left", anchor="w",
        )
        self._sets_label.pack(fill="x", padx=10, pady=(0, 10))

    def _make_stat_row(self, parent, label_text: str, color: str) -> ScoreBar:
        row = tk.Frame(parent, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text=label_text, font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL,
                 width=10, anchor="w").pack(side="left")
        bar = ScoreBar(row, width=170, height=8)
        bar.pack(side="left", padx=(6, 6))
        val_label = tk.Label(row, text="—", font=FONT_SMALL,
                             fg=color, bg=BG_PANEL, width=6, anchor="e")
        val_label.pack(side="left")
        bar._val_label = val_label  # type: ignore[attr-defined]
        bar._color_default = color  # type: ignore[attr-defined]
        return bar

    # ── data update ─────────────────────────────────────────────────

    def update_team(self, team_set_ids: list[str]) -> None:
        """Recompute everything when the team changes."""
        self._team_set_ids = [s for s in team_set_ids if s]
        # Compute per-set data
        from pokeredus.graph.analytics import rank_sets
        rankings = rank_sets(self.kg)
        score_by_set = {r.set_id: r.composite_score for r in rankings}
        # Coverage
        all_set_ids = {s.id for s in self.kg.get_all_sets()}
        total_others = max(len(all_set_ids) - 1, 1)

        self._pokemon_data = []
        for sid in self._team_set_ids:
            s = self.kg.get_set(sid)
            if s is None:
                continue
            p = self.kg.get_pokemon(s.pokemon_id)
            if p is None:
                continue
            matchups = self.kg.get_matchups(sid, min_confidence=0.0)
            cov = len(matchups) / total_others
            self._pokemon_data.append({
                "set_id": sid,
                "name": p.name,
                "types": list(p.types),
                "score": score_by_set.get(sid, 0.0),
                "coverage": cov,
            })

        # Refresh graph
        if self._team_set_ids:
            self._mini_graph.set_data(
                set_ids=None,  # show whole meta
                team_anchor_ids=self._team_set_ids,
                run_simulation=True,
            )
            self._hint.config(text="Mini graph · drag to rotate · click 'Open full graph' for analysis")
        else:
            self._mini_graph.set_data(set_ids=[], run_simulation=False)
            self._hint.config(text="Add Pokémon to see team analysis")

        # Update stat bars
        self._update_stat_bars()
        self._update_type_text()
        self._update_set_text()

    def _update_stat_bars(self) -> None:
        if not self._pokemon_data:
            for bar in (self._team_score_bar, self._coverage_bar,
                        self._synergy_bar, self._threat_score_bar):
                bar.set(0.0)
                bar._val_label.config(text="—")
            return

        # Team score: average composite of team members
        team_score = sum(d["score"] for d in self._pokemon_data) / len(self._pokemon_data)
        self._team_score_bar.set(team_score, NEON_CYAN)
        self._team_score_bar._val_label.config(text=f"{team_score:.2f}")

        # Coverage: average matchup coverage across team
        cov = sum(d["coverage"] for d in self._pokemon_data) / len(self._pokemon_data)
        self._coverage_bar.set(cov, NEON_GREEN)
        self._coverage_bar._val_label.config(text=f"{cov * 100:.0f}%")

        # Synergy: distinct types / max desirable (6)
        all_types = set()
        for d in self._pokemon_data:
            all_types.update(d["types"])
        synergy = min(1.0, len(all_types) / 6.0)
        self._synergy_bar.set(synergy, NEON_PINK)
        self._synergy_bar._val_label.config(text=f"{synergy:.2f}")

        # vs Meta: average of "how does the team beat the rest of the OU"
        # = average (inbound favorable / inbound total) across team
        threat_scores = []
        for d in self._pokemon_data:
            inbound = self.kg.get_matchups_against(d["set_id"], min_confidence=0.0)
            if not inbound:
                continue
            favorable = sum(1 for m in inbound if m.score > 0)
            threat_scores.append(favorable / len(inbound))
        vs_meta = sum(threat_scores) / len(threat_scores) if threat_scores else 0.0
        self._threat_score_bar.set(vs_meta, NEON_ORANGE)
        self._threat_score_bar._val_label.config(text=f"{vs_meta * 100:.0f}%")

    def _update_type_text(self) -> None:
        if not self._pokemon_data:
            self._type_text.config(text="No Pokémon in team")
            return
        all_types: set[str] = set()
        for d in self._pokemon_data:
            all_types.update(d["types"])
        # Identify weaknesses (types that all opposing pokemon could exploit)
        all_18 = {
            "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
            "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
            "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
        }
        weak = all_18 - all_types
        if not weak:
            type_text = f"Types: {len(all_types)} (perfect coverage)"
        else:
            sample = sorted(weak)[:4]
            type_text = (
                f"Types: {len(all_types)}   ·   "
                f"Missing: {', '.join(sample)}"
            )
        self._type_text.config(text=type_text)

    def _update_set_text(self) -> None:
        if not self._pokemon_data:
            self._sets_label.config(text="")
            return
        lines = []
        for d in self._pokemon_data:
            t = "/".join(d["types"]) if d["types"] else "???"
            lines.append(f"  {d['name']:<14}  {t:<12}  score {d['score']:.2f}")
        self._sets_label.config(text="\n".join(lines))

    # ── open-full callback ──────────────────────────────────────────

    def _trigger_open_full(self) -> None:
        if self._on_open_full is not None:
            self._on_open_full(list(self._team_set_ids))
