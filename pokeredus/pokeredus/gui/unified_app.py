"""
PokeRedus Unified App Shell — single dashboard with sidebar nav across 4 pages.

This module wires the four existing pages (Pokemon Stats, Team Builder,
Matchup Graph, Game Simulator) into one persistent shell with a left
sidebar. It also adds:

  * A live "Optimal Action" panel shown on every page — given the
    currently-focused pokemon or team, it asks the unified core for the
    recommended action and explains why.
  * A scene snapshot/export button so any page can dump the current
    training data without leaving the workflow.
  * A "Train Mode" toggle that renders the scene as plain text and lets
    the user label the action — perfect for building a supervised
    dataset by hand.

Why this exists
---------------
The original `pokeredus.gui.app` used a title-screen landing page that
hid navigation behind a button press — fine for a hero screen, awkward
for an analyst who wants to flip between pages constantly. The unified
shell puts nav in the sidebar and keeps every page one click away. The
intelligence layer wraps the same scoring used by the matchup graph
(`pick_best_move`, `find_optimal_switch`) so the "Recommended Action"
panel in the sidebar uses exactly the same ranking the meta graph shows.

Architecture
------------
    class UnifiedAppShell(tk.Frame)            — root container (sidebar + main)
    class SidebarWidget(tk.Frame)              — left navigation ribbon
    class OptimalActionPanel(tk.Frame)         — live AI panel on the sidebar
    class LaunchHelper                         — entry used by scripts/launch.py
    show_optimal_action(scene, kg) → str       — public helper any page can call
    export_scene_action(scene, kg, path)       — write JSONL training sample
"""

from __future__ import annotations

import json
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable, Optional

from pokeredus.gui.theme import (
    BG_DARK, BG_PANEL, BG_CARD, BG_INPUT, BG_HOVER, BG_SELECTED,
    FG_PRIMARY, FG_SECONDARY, FG_DIM,
    NEON_CYAN, NEON_PINK, NEON_GREEN, NEON_ORANGE, NEON_YELLOW, NEON_RED, NEON_PURPLE,
    FONT_HEADING, FONT_BODY, FONT_BODY_BOLD, FONT_SMALL, FONT_BUTTON, FONT_STAT,
    FONT_STAT_HEADING, FONT_TITLE, FONT_SUBTITLE,
    ANIMATION_DELAY,
)

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.graph.matchup_cache import MatchupCache
    from pokeredus.unified import UnifiedState


# ═══════════════════════════════════════════════════════════════════════
# Sidebar
# ═══════════════════════════════════════════════════════════════════════


PAGE_TITLES = {
    "pokemon":    ("Pokémon Stats",     NEON_CYAN),
    "team":       ("Team Builder",      NEON_GREEN),
    "matchup":    ("Matchup Graph",     NEON_PINK),
    "simulator":  ("Game Simulator",    NEON_ORANGE),
}


class SidebarWidget(tk.Frame):
    """Left sidebar with nav buttons + the Optimal Action panel.

    The sidebar lives outside the page stack so it survives page
    rebuilds. Section buttons drive the outer shell's `_show_page`.
    """

    SIDEBAR_WIDTH = 220

    def __init__(
        self,
        parent,
        on_select_page: Callable[[str], None],
        on_train_mode: Callable[[], None],
        current_page_provider: Callable[[], str],
        kg,
        **kwargs,
    ):
        super().__init__(parent, bg=BG_PANEL, width=self.SIDEBAR_WIDTH, **kwargs)
        self._on_select_page = on_select_page
        self._on_train_mode = on_train_mode
        self._current_page_provider = current_page_provider
        self.kg = kg
        self.pack_propagate(False)

        self._nav_buttons: dict[str, tk.Button] = {}
        self._build_ui()
        self._refresh_highlight(current_page_provider())

    # ── UI ────────────────────────────────────────────────────────────
    def _build_ui(self):
        # Header / app name
        tk.Label(
            self, text="PokeRedus", font=FONT_TITLE, fg=NEON_CYAN, bg=BG_PANEL,
        ).pack(pady=(14, 2))

        tk.Label(
            self, text="Unified Shell", font=FONT_SMALL, fg=FG_DIM, bg=BG_PANEL,
        ).pack(pady=(0, 12))

        # ── Navigation buttons ─────────────────────────────────────────
        for page_key, (label, color) in PAGE_TITLES.items():
            btn = tk.Button(
                self,
                text=label,
                font=FONT_BUTTON,
                fg=color,
                bg=BG_PANEL,
                activebackground=BG_HOVER,
                activeforeground=color,
                bd=0,
                highlightthickness=0,
                padx=8, pady=10,
                anchor="w",
                cursor="hand2",
                command=lambda k=page_key: self._on_select_page(k),
            )
            btn.pack(fill="x", padx=8, pady=2)
            self._nav_buttons[page_key] = btn

        # Train-mode button (uses unified core)
        train_btn = tk.Button(
            self,
            text="▶ Train Mode",
            font=FONT_BUTTON,
            fg=NEON_YELLOW,
            bg=BG_PANEL,
            activebackground=BG_HOVER,
            bd=0, highlightthickness=0,
            padx=8, pady=10,
            anchor="w",
            cursor="hand2",
            command=self._on_train_mode,
        )
        train_btn.pack(fill="x", padx=8, pady=(12, 4))

        # ── Optimal Action panel (composes well-known AI queries) ──────
        self._action_panel = OptimalActionPanel(
            self, kg=self.kg, on_export=self._export_sample,
        )
        self._action_panel.pack(fill="both", expand=True, padx=8, pady=(8, 12))

        # Footer status
        self._footer_var = tk.StringVar(value="")
        tk.Label(
            self, textvariable=self._footer_var, font=FONT_SMALL,
            fg=FG_DIM, bg=BG_PANEL, anchor="w", wraplength=self.SIDEBAR_WIDTH - 16,
        ).pack(side="bottom", fill="x", padx=8, pady=8)

    # ── Public surface ───────────────────────────────────────────────
    def update_action_panel(self, scene: "UnifiedState") -> None:
        """Hand a new UnifedState scene to the AI panel."""
        self._action_panel.set_scene(scene)

    def set_footer(self, text: str) -> None:
        self._footer_var.set(text)

    def _refresh_highlight(self, current_page_key: str) -> None:
        for key, btn in self._nav_buttons.items():
            if key == current_page_key:
                btn.config(bg=BG_SELECTED)
            else:
                btn.config(bg=BG_PANEL)

    def on_page_changed(self, key: str) -> None:
        self._refresh_highlight(key)

    def _export_sample(self, scene, actions_path: str) -> None:
        """Prompt save dialog and dump the current scene as JSONL sample."""
        path = filedialog.asksaveasfilename(
            title="Export scene → training JSONL",
            defaultextension=".jsonl",
            filetypes=[("JSON Lines", "*.jsonl"), ("All files", "*")],
            initialfile=f"scene_{datetime.now():%Y%m%d_%H%M%S}.jsonl",
        )
        if not path:
            return
        from pokeredus.unified import export_training_corpus
        try:
            n = export_training_corpus(
                [(scene, actions_path)], self.kg, path, mode="compact",
            )
        except Exception as exc:
            messagebox.showerror("Export failed", str(exc))
            return
        self._footer_var.set(f"Exported {n} sample(s) → {Path(path).name}")
        messagebox.showinfo("Export complete", f"Wrote {n} sample(s) to:\n{path}")


# ═══════════════════════════════════════════════════════════════════════
# Optimal-Action panel — always-available AI sidebar
# ═══════════════════════════════════════════════════════════════════════


class OptimalActionPanel(tk.Frame):
    """Live AI in the sidebar: given a UnifiedState, what should I do?

    The text labels here are intentionally compact:
      [Side A / Side B]
      Recommended: <action label>  (score = +1.43)
      Why:
        - super-effective (x2)... etc

    This is the user-facing twin of `pokeredus.unified.recommend_actions`.
    """

    def __init__(self, parent, kg, on_export: Callable, **kwargs):
        super().__init__(parent, bg=BG_CARD, bd=1, relief="flat", **kwargs)
        self.kg = kg
        self._on_export = on_export
        self._last_actions: list = []
        self._last_scene = None
        self._build_ui()

    def _build_ui(self):
        # Header
        tk.Label(
            self, text="OPTIMAL ACTION",
            font=("Consolas", 10, "bold"),
            fg=NEON_PINK, bg=BG_CARD,
        ).pack(anchor="w", padx=10, pady=(8, 2))

        self._side_var = tk.StringVar(value="side: --")
        tk.Label(
            self, textvariable=self._side_var, font=FONT_SMALL,
            fg=FG_DIM, bg=BG_CARD,
        ).pack(anchor="w", padx=10)

        self._scene_var = tk.StringVar(value="scene: (waiting)")
        tk.Label(
            self, textvariable=self._scene_var, font=FONT_SMALL,
            fg=FG_DIM, bg=BG_CARD, wraplength=180, justify="left",
        ).pack(anchor="w", padx=10, pady=(0, 8))

        # Recommended action card
        self._rec_frame = tk.Frame(self, bg=BG_DARK, bd=1, relief="flat")
        self._rec_frame.pack(fill="x", padx=8, pady=4)
        self._rec_label = tk.Label(
            self._rec_frame, text="(no scene)", font=FONT_BODY_BOLD,
            fg=NEON_CYAN, bg=BG_DARK, anchor="w", wraplength=170, justify="left",
        )
        self._rec_label.pack(fill="x", padx=8, pady=6)
        self._rec_score = tk.Label(
            self._rec_frame, text="", font=FONT_SMALL, fg=FG_DIM, bg=BG_DARK,
            anchor="w",
        )
        self._rec_score.pack(fill="x", padx=8, pady=(0, 6))

        # Reasoning list (scrollable)
        self._reason_text = tk.Text(
            self, height=7, font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_INPUT,
            bd=0, highlightthickness=0, wrap="word",
        )
        self._reason_text.pack(fill="both", expand=True, padx=8, pady=8)

        # Action list (alternates)
        tk.Label(
            self, text="ALTERNATES", font=("Consolas", 9, "bold"),
            fg=NEON_GREEN, bg=BG_CARD,
        ).pack(anchor="w", padx=10, pady=(4, 2))

        self._alts_frame = tk.Frame(self, bg=BG_CARD)
        self._alts_frame.pack(fill="both", expand=True, padx=8, pady=(2, 4))

        # Export button row
        tk.Button(
            self, text="  Export Current  ",
            font=FONT_BUTTON, fg=NEON_YELLOW, bg=BG_DARK,
            activebackground=BG_HOVER, bd=0, cursor="hand2",
            command=self._export_clicked,
        ).pack(fill="x", padx=8, pady=(4, 8))

    # ── Public ────────────────────────────────────────────────────────
    def set_scene(self, scene: "UnifiedState") -> None:
        """Recompute recommendations from the given scene."""
        self._last_scene = scene
        if scene is None or not scene.team_a:
            self._rec_label.config(text="(no scene)")
            self._rec_score.config(text="")
            self._scene_var.set("scene: empty")
            self._reason_text.delete("1.0", "end")
            self._alts_frame.children.clear()   # type: ignore[attr-defined]
            for w in list(self._alts_frame.winfo_children()):
                w.destroy()
            return

        from pokeredus.unified import recommend_actions, render_scene
        try:
            actions = recommend_actions(scene, self.kg)
        except Exception as exc:
            self._rec_label.config(text="(error)")
            self._rec_score.config(text=str(exc)[:80])
            return

        self._last_actions = actions

        # Header summary
        side = scene.side_to_move or "a"
        scene_text = render_scene(scene, self.kg, mode="compact").text
        short = scene_text if len(scene_text) < 100 else scene_text[:97] + "..."
        self._side_var.set(f"side: {side}")
        self._scene_var.set(f"scene: {short}")

        # Recommended action card
        if not actions:
            self._rec_label.config(text="(no actions)")
            self._rec_score.config(text="")
            self._reason_text.delete("1.0", "end")
        else:
            top = actions[0]
            self._rec_label.config(
                text=f"★ {top.label}",
                fg=NEON_CYAN if top.kind == "move" else NEON_PINK,
            )
            self._rec_score.config(text=f"score = {top.score:+.3f}")
            self._reason_text.delete("1.0", "end")
            for r in top.reasoning[:4]:
                self._reason_text.insert("end", f"• {r}\n")
            # Mark which side to move is, so the user knows this is for them

        # Alternates list
        for w in list(self._alts_frame.winfo_children()):
            w.destroy()
        for alt in actions[1:7]:  # top 6 alternates
            color = NEON_CYAN if alt.kind == "move" else NEON_PINK
            row = tk.Frame(self._alts_frame, bg=BG_CARD)
            row.pack(fill="x", pady=1)
            tk.Label(
                row, text=f"{alt.kind:<6}", font=("Consolas", 8),
                fg=color, bg=BG_CARD, width=6, anchor="w",
            ).pack(side="left")
            tk.Label(
                row, text=alt.label[:24], font=FONT_SMALL,
                fg=FG_PRIMARY, bg=BG_CARD,
            ).pack(side="left", padx=(4, 4))
            tk.Label(
                row, text=f"{alt.score:+.2f}", font=FONT_SMALL,
                fg=FG_DIM, bg=BG_CARD,
            ).pack(side="right")

    def _export_clicked(self) -> None:
        if self._last_scene is None or not self._last_actions:
            messagebox.showwarning(
                "No scene", "Visit Pokemon Stats, Team Builder or Simulator first."
            )
            return
        self._on_export(self._last_scene, self._last_actions)


# ═══════════════════════════════════════════════════════════════════════
# Top bar (visible across all pages)
# ═══════════════════════════════════════════════════════════════════════


class TopBar(tk.Frame):
    """The top status bar (shared across all pages)."""

    def __init__(self, parent, kg, **kwargs):
        super().__init__(parent, bg=BG_PANEL, height=44, **kwargs)
        self.pack_propagate(False)
        self.kg = kg
        self._title_var = tk.StringVar(value="PokeRedus")
        self._stats_var = tk.StringVar(value="")
        self._build()

    def _build(self):
        tk.Label(
            self, textvariable=self._title_var, font=FONT_HEADING,
            fg=NEON_CYAN, bg=BG_PANEL, anchor="w",
        ).pack(side="left", padx=14)

        tk.Label(
            self, textvariable=self._stats_var, font=FONT_SMALL,
            fg=FG_DIM, bg=BG_PANEL,
        ).pack(side="right", padx=14)

        cache_str = "(loading…)"
        try:
            from pokeredus.graph.matchup_cache import MatchupCache
            cache_str = MatchupCache.format_cache_file_size()
        except Exception:
            pass

        self._stats_var.set(
            f"{self.kg.pokemon_count} pokes  ·  "
            f"{self.kg.set_count} sets  ·  "
            f"{self.kg.matchup_count:,} matchups  ·  cache {cache_str}"
        )

    def set_title(self, title: str) -> None:
        self._title_var.set(title)


# ═══════════════════════════════════════════════════════════════════════
# Shell — ties it all together
# ═══════════════════════════════════════════════════════════════════════


class UnifiedAppShell(tk.Frame):
    """The persistent shell hosting all 4 pages.

    Layout:
        ┌─ TopBar ─────────────────────────────┐
        │  PokeRedus Unified Shell           ⋯  │
        ├─ Sidebar ┬─ Pages (stacked via grid) ─┤
        │  nav     │                            │
        │  AI      │                            │
        │  panel   │                            │
        └──────────┴────────────────────────────┘

    Public methods:
        show("pokemon" | "team" | "matchup" | "simulator", **kwargs)
        set_optimal_scene(scene)
        get_optimal_scene() → UnifiedState | None
    """

    def __init__(self, parent, kg, matchup_cache, **kwargs):
        super().__init__(parent, bg=BG_DARK, **kwargs)

        self.kg = kg
        self.matchup_cache = matchup_cache

        # ── Grid: rows = TopBar | Body, cols = Sidebar | Pages ────────
        self.grid_rowconfigure(0, weight=0)        # TopBar
        self.grid_rowconfigure(1, weight=1)        # Body
        self.grid_columnconfigure(0, weight=0)     # Sidebar
        self.grid_columnconfigure(1, weight=1)     # Pages

        # ── Top bar ───────────────────────────────────────────────────
        self._topbar = TopBar(self, kg)
        self._topbar.grid(row=0, column=0, columnspan=2, sticky="ew")

        # ── Page container ────────────────────────────────────────────
        self._pages_frame = tk.Frame(self, bg=BG_DARK)
        self._pages_frame.grid(row=1, column=1, sticky="nsew")
        self._pages_frame.grid_rowconfigure(0, weight=1)
        self._pages_frame.grid_columnconfigure(0, weight=1)

        # Pages dict — built lazily (per-page)
        self._pages: dict[str, tk.Frame] = {}
        self._current_page = ""

        # Most-recent scene set by a page (built by the page that wants
        # to influence the sidebar's optimal-action panel).
        self._current_scene: Optional["UnifiedState"] = None

        # ── Sidebar (with Optimal-Action panel) ──────────────────────
        self._sidebar = SidebarWidget(
            self,
            on_select_page=self.show,
            on_train_mode=self._open_train_mode,
            current_page_provider=lambda: self._current_page,
            kg=kg,
        )
        self._sidebar.grid(row=1, column=0, sticky="nsew")

    # ── Page navigation ──────────────────────────────────────────────
    def show(self, name: str, **kwargs):
        if name not in PAGE_TITLES:
            return
        title, color = PAGE_TITLES[name]
        self._topbar.set_title(title)

        page = self._pages.get(name)
        if page is None:
            page = self._build_page(name, **kwargs)
            if page is None:
                return
            page.grid(row=0, column=0, sticky="nsew")
            self._pages[name] = page
        page.tkraise()
        self._current_page = name
        self._sidebar.on_page_changed(name)

    def _build_page(self, name: str, **kwargs):
        # Lazy imports to keep the shell snappy on cold start
        if name == "pokemon":
            from pokeredus.gui.pokemon_panel import PokemonPage
            return PokemonPage(
                self._pages_frame, self.kg,
                go_home_cb=lambda: None,    # shell has its own nav
                matchup_cache=self.matchup_cache,
            )
        if name == "team":
            from pokeredus.gui.team_builder import TeamManagerPage
            return TeamManagerPage(
                self._pages_frame, self.kg,
                go_home_cb=lambda: None,
                open_team_cb=self._open_team_editor_in_shell,
            )
        if name == "matchup":
            from pokeredus.gui.matchup_graph_view import MatchupGraphPage
            return MatchupGraphPage(
                self._pages_frame, self.kg, self.matchup_cache,
                go_home=lambda: None,
            )
        if name == "simulator":
            from pokeredus.gui.simulator_page import SimulatorPage
            bs = self._get_battle_simulator()
            page = SimulatorPage(
                self._pages_frame, self.kg, self.matchup_cache,
                go_home=lambda: None,
                battle_simulator=bs,
                on_scene_change=self.set_optimal_scene,
            )
            return page
        return None

    def _get_battle_simulator(self):
        """Build a battle simulator exactly once for the simulator page."""
        if not hasattr(self, "_battle_simulator") or self._battle_simulator is None:
            from pokeredus.graph.damage_calc import get_calculator
            from pokeredus.graph.battle_simulator import BattleSimulator
            self._battle_simulator = BattleSimulator(
                get_calculator(), self.kg, attribute_manager=None,
            )
        return self._battle_simulator

    def _open_team_editor_in_shell(self, team_record) -> None:
        # Team manager's "open editor" call — push into the team page
        # with that team pre-loaded. We rebuild the page when needed.
        from pokeredus.gui.team_builder import TeamBuilderPage
        if "team_editor" in self._pages:
            try:
                self._pages["team_editor"].destroy()
            except tk.TclError:
                pass
            self._pages.pop("team_editor", None)
        # We piggyback on the same grid cell as the other pages.
        # Rebuild team_manager to push the record, and also build the
        # editor above.
        page = TeamBuilderPage(
            self._pages_frame, self.kg,
            go_back_cb=self.show_team_manager,
            team_record=team_record,
        )
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["team_editor"] = page
        page.tkraise()
        self._current_page = "team_editor"
        self._topbar.set_title(f"Team: {team_record.team_name if team_record else '—'}")

    def show_team_manager(self) -> None:
        self.show("team")

    # ── Optimal-Action panel wiring ──────────────────────────────────
    def set_optimal_scene(self, scene: "UnifiedState") -> None:
        """Called by any page that has a meaningful scene to analyze."""
        self._current_scene = scene
        self._sidebar.update_action_panel(scene)

    def get_optimal_scene(self):
        return self._current_scene

    # ── Train Mode (modal over the shell) ────────────────────────────
    def _open_train_mode(self):
        """Modal: render the current scene as text, let the user label actions."""
        if self._current_scene is None:
            messagebox.showinfo(
                "Train Mode",
                "Visit a page with active pokemon first (the sidebar panel needs a scene).",
            )
            return
        TrainModeDialog(self, self.kg, scene=self._current_scene)


# ═══════════════════════════════════════════════════════════════════════
# Train Mode modal — by-hand training sample labelling
# ═══════════════════════════════════════════════════════════════════════


class TrainModeDialog(tk.Toplevel):
    """Hand-labelling helper: see the scene, click on the action you took,
    save the (scene, action) pair as a training sample.

    This is the priming step before letting an agent learn — get a small
    supervised dataset, then move to RL self-play using the same export
    format. The agent outputs and the hand labels land in the same
    JSONL shape so the trainer treats them uniformly.
    """

    def __init__(self, parent, kg, scene: "UnifiedState"):
        super().__init__(parent)
        self.title("Train Mode — label actions")
        self.configure(bg=BG_DARK)
        self.geometry("780x620")
        self.transient(parent)
        self.grab_set()

        self.kg = kg
        self.scene = scene
        self._samples: list[dict] = []
        self._collected_actions: list = []

        self._build_ui()

    def _build_ui(self):
        # Header
        tk.Label(
            self, text="TRAIN MODE",
            font=FONT_TITLE, fg=NEON_YELLOW, bg=BG_DARK,
        ).pack(pady=10)

        # Scene text (read-only)
        tk.Label(
            self, text="Scene (plain text for the model):",
            font=FONT_BODY_BOLD, fg=FG_DIM, bg=BG_DARK, anchor="w",
        ).pack(fill="x", padx=14)

        from pokeredus.unified import render_scene
        text_widget = tk.Text(
            self, height=8, font=("Consolas", 10), fg=NEON_CYAN, bg=BG_INPUT,
            bd=0, wrap="word",
        )
        text_widget.pack(fill="x", padx=14, pady=4)
        text_widget.insert("1.0", render_scene(self.scene, self.kg, mode="verbose").text)
        text_widget.config(state="disabled")

        # Candidate actions
        from pokeredus.unified import recommend_actions
        try:
            actions = recommend_actions(self.scene, self.kg)
        except Exception as exc:
            actions = []
            tk.Label(
                self, text=f"AI error: {exc}", font=FONT_SMALL,
                fg=NEON_RED, bg=BG_DARK,
            ).pack()

        if not actions:
            tk.Label(
                self, text="No actions available (no opponent or no active).",
                font=FONT_SMALL, fg=NEON_RED, bg=BG_DARK,
            ).pack(pady=10)
            return

        tk.Label(
            self, text="Pick the action you took (or skip):",
            font=FONT_BODY_BOLD, fg=FG_DIM, bg=BG_DARK, anchor="w",
        ).pack(fill="x", padx=14, pady=(12, 4))

        # Action list with virtual clipping (max 10 shown)
        list_frame = tk.Frame(self, bg=BG_DARK)
        list_frame.pack(fill="both", expand=True, padx=14, pady=4)

        for a in actions[:10]:
            row = tk.Frame(list_frame, bg=BG_PANEL, bd=1)
            row.pack(fill="x", pady=2)

            color = NEON_CYAN if a.kind == "move" else NEON_PINK
            tk.Label(
                row, text=f"{a.kind:<6}", font=("Consolas", 9),
                fg=color, bg=BG_PANEL, width=8, anchor="w",
            ).pack(side="left", padx=(8, 4), pady=6)
            tk.Label(
                row, text=a.label, font=FONT_BODY, fg=FG_PRIMARY, bg=BG_PANEL,
                anchor="w",
            ).pack(side="left", fill="x", expand=True, pady=6)
            tk.Label(
                row, text=f"score={a.score:+.3f}", font=FONT_SMALL,
                fg=FG_DIM, bg=BG_PANEL,
            ).pack(side="right", padx=8)

            tk.Button(
                row, text="+ sample", font=FONT_SMALL, fg=NEON_GREEN,
                bg=BG_DARK, bd=0, cursor="hand2",
                command=lambda act=a: self._add_sample(act),
            ).pack(side="right", padx=4)

        # Footer status + save all
        self._status_var = tk.StringVar(value="0 samples collected")
        tk.Label(
            self, textvariable=self._status_var, font=FONT_SMALL,
            fg=FG_DIM, bg=BG_DARK,
        ).pack(anchor="w", padx=14, pady=(8, 0))

        # Save All button
        save_row = tk.Frame(self, bg=BG_DARK)
        save_row.pack(fill="x", padx=14, pady=12)

        tk.Button(
            save_row, text="Save All → JSONL",
            font=FONT_BUTTON, fg=NEON_YELLOW, bg=BG_PANEL,
            bd=0, cursor="hand2",
            command=self._save_all,
        ).pack(side="right", padx=4)

        tk.Button(
            save_row, text="Close", font=FONT_BUTTON, fg=FG_DIM,
            bg=BG_PANEL, bd=0, cursor="hand2",
            command=self.destroy,
        ).pack(side="right", padx=4)

    def _add_sample(self, action) -> None:
        from pokeredus.unified import render_scene
        scene_text = render_scene(self.scene, self.kg, mode="compact").text
        sample = {
            "turn": self.scene.turn,
            "side_to_move": self.scene.side_to_move,
            "mode": "compact",
            "scene_text": scene_text,
            "action_text": action.to_text(compact=True),
            "action_kind": action.kind,
            "action_detail": dict(action.detail),
            "score": action.score,
            "labeled_by": "human",
            "labeled_at": datetime.utcnow().isoformat() + "Z",
        }
        self._samples.append(sample)
        self._collected_actions.append(action)
        self._status_var.set(f"{len(self._samples)} samples collected")

    def _save_all(self) -> None:
        if not self._samples:
            messagebox.showwarning("No samples", "Click '+ sample' on an action first.")
            return
        path = filedialog.asksaveasfilename(
            title="Save hand-labelled samples",
            defaultextension=".jsonl",
            filetypes=[("JSON Lines", "*.jsonl")],
            initialfile=f"hand_labels_{datetime.now():%Y%m%d_%H%M%S}.jsonl",
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as f:
                for s in self._samples:
                    f.write(json.dumps(s, sort_keys=True) + "\n")
        except Exception as exc:
            messagebox.showerror("Save failed", str(exc))
            return
        messagebox.showinfo("Saved", f"Wrote {len(self._samples)} sample(s) to:\n{path}")
        self.destroy()


# ═══════════════════════════════════════════════════════════════════════
# Helper for existing 4 pages to integrate with the shell
# ═══════════════════════════════════════════════════════════════════════


def make_optimal_scene_from_team(
    team_record, kg, side_to_move: str = "a",
) -> "UnifiedState":
    """Convenience for pages that only have a TeamRecord at hand.

    Build a UnifiedState from the saved team — the sidebar panel will
    then ask `recommend_actions` what to do. Used by the team-builder
    page so editors can see an AI suggestion without launching the
    simulator.
    """
    from pokeredus.unified import UnifiedState
    if team_record is None or not team_record.sets:
        return UnifiedState()
    sets = []
    for sid in team_record.sets:
        s = kg.get_set(sid)
        if s is not None:
            sets.append(s)
    return UnifiedState.from_sets(sets, kg)


__all__ = [
    "UnifiedAppShell",
    "SidebarWidget",
    "OptimalActionPanel",
    "TrainModeDialog",
    "PAGE_TITLES",
    "make_optimal_scene_from_team",
]
