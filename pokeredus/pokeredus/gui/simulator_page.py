"""
Battle Simulator Page — PokeRedus

Major UI revamp with 3-column layout:
  TOP BAR: [Back] [Title: BATTLE SIMULATOR] [Turn: N] [Reset] [Step/Execute] [Auto-Play]
  MAIN BODY (3 columns, equal weight):
    LEFT (Team A 35%): Team header, Import/Clear, Active panel, Moves grid, Switch+Bench list
    CENTER (30%): Field Conditions, Side A Conditions, Side B Conditions, Action buttons
    RIGHT (Team B 35%): Mirror of Team A panel
  BOTTOM: Battle Log (70%) | MCTS Panel (30%)
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, messagebox
from typing import TYPE_CHECKING, Optional, Callable  # noqa: F401

from pokeredus.gui.theme import (
    BG_DARK, BG_PANEL, BG_CARD, BG_INPUT, BG_HOVER, BG_SELECTED,
    FG_PRIMARY, FG_SECONDARY, FG_DIM,
    NEON_CYAN, NEON_PINK, NEON_GREEN, NEON_ORANGE, NEON_YELLOW, NEON_RED, NEON_PURPLE,
    TYPE_COLORS,
    FONT_HEADING, FONT_BODY, FONT_BODY_BOLD, FONT_SMALL, FONT_BUTTON, FONT_STAT,
    FONT_STAT_HEADING,
)
from pokeredus.gui.sprites import get_sprite_manager, SpriteManager
from pokeredus.gui.team_store import TeamStore, TeamRecord
from pokeredus.config import STAT_NAMES, STAT_LABELS

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.graph.matchup_cache import MatchupCache
    from pokeredus.graph.battle_simulator import BattleSimulator
    from pokeredus.graph.probabilistic_engine import ProbabilisticEngine, StateEvaluation
    from pokeredus.graph.game_state import GameState, PokemonState, FieldState
    from pokeredus.classes import PokemonClass, SetClass
    from pokeredus.classes.moves import MoveClass

# ── Constants ────────────────────────────────────────────────────────────────

TEAM_SIZE = 6
WEATHER_OPTIONS = ["None", "sun", "rain", "sand", "snow"]
TERRAIN_OPTIONS = ["None", "electric", "grassy", "psychic", "misty"]

STATUS_COLORS = {
    "burn": "#ff3366",
    "poison": "#b24dff",
    "toxic": "#b24dff",
    "sleep": "#00d4ff",
    "paralysis": "#ffe600",
    "freeze": "#98d8d8",
}

CATEGORY_SYMBOLS = {
    "Physical": "⚔",
    "Special": "✨",
    "Status": "💫",
}

HP_GREEN = "#39ff14"
HP_YELLOW = "#ffe600"
HP_RED = "#ff3366"

# ── Utility Helpers ──────────────────────────────────────────────────────────


def hp_bar_color(pct: float) -> str:
    """Return HP bar color based on HP percentage."""
    if pct > 50:
        return HP_GREEN
    elif pct > 20:
        return HP_YELLOW
    return HP_RED


def stat_stage_text(multiplier: float) -> str:
    """Convert stat multiplier to stage display string."""
    if multiplier == 1.0:
        return ""
    stages = int(round((multiplier - 1.0) * 2))
    if stages > 0:
        return f"+{stages // 2}" if stages % 2 == 0 else f"+{stages}/2"
    elif stages < 0:
        abs_s = abs(stages)
        return f"-{abs_s // 2}" if abs_s % 2 == 0 else f"-{abs_s}/2"
    return ""


# ── HP Bar Canvas Widget ─────────────────────────────────────────────────────


class HPBarCanvas(tk.Canvas):
    """A canvas that draws an HP bar with color coding."""

    def __init__(self, parent, current_hp: int, max_hp: int,
                 width: int = 200, height: int = 14, **kwargs):
        super().__init__(parent, width=width, height=height,
                         highlightthickness=0, bd=0, **kwargs)
        self._current = current_hp
        self._max = max_hp
        self._width = width
        self._height = height
        self.bind("<Configure>", self._on_resize)
        self.draw()

    def _on_resize(self, event):
        self._width = event.width
        self._height = event.height
        self.draw()

    def set_hp(self, current: int, max_hp: int):
        self._current = current
        self._max = max_hp
        self.draw()

    def draw(self):
        self.delete("all")
        pct = (self._current / self._max * 100.0) if self._max > 0 else 0.0
        color = hp_bar_color(pct)
        bar_w = int(self._width * min(pct / 100.0, 1.0))
        self.create_rectangle(0, 0, self._width, self._height,
                              fill=BG_INPUT, outline="")
        if bar_w > 0:
            self.create_rectangle(0, 0, bar_w, self._height,
                                  fill=color, outline="")
        self.create_rectangle(0, 0, self._width, self._height,
                              outline=FG_DIM, width=1)


# ── Type Badge ───────────────────────────────────────────────────────────────


def make_type_badge(parent, type_name: str, font_size: int = 8,
                    padx: int = 4, pady: int = 1) -> tk.Label:
    """Create a type-colored badge label."""
    color = TYPE_COLORS.get(type_name, FG_DIM)
    lbl = tk.Label(
        parent, text=f" {type_name} ", font=("Consolas", font_size, "bold"),
        fg=BG_DARK, bg=color, padx=padx, pady=pady,
    )
    return lbl


# ── Status Badge ─────────────────────────────────────────────────────────────


def make_status_badge(parent, status: str) -> tk.Label:
    """Create a small status condition badge."""
    color = STATUS_COLORS.get(status, FG_DIM)
    display = status.upper()[:4]
    return tk.Label(
        parent, text=display, font=("Consolas", 7, "bold"),
        fg=BG_DARK, bg=color, padx=3, pady=1,
    )


# ── Team Picker Dialog ───────────────────────────────────────────────────────


class TeamPickerDialog(tk.Toplevel):
    """Modal dialog for picking a saved team."""

    def __init__(self, parent, teams: list[TeamRecord], side_name: str):
        super().__init__(parent)
        self.title(f"Select Team for {side_name}")
        self.configure(bg=BG_DARK)
        self.geometry("420x500")
        self.transient(parent)
        self.grab_set()
        self.result: Optional[TeamRecord] = None

        self._build_ui(teams, side_name)

    def _build_ui(self, teams: list[TeamRecord], side_name: str):
        header_color = NEON_CYAN if "A" in side_name else NEON_PINK
        tk.Label(
            self, text=f"Choose a team for {side_name}",
            font=FONT_HEADING, fg=header_color, bg=BG_DARK,
        ).pack(pady=12)

        list_frame = tk.Frame(self, bg=BG_DARK)
        list_frame.pack(fill="both", expand=True, padx=16, pady=8)

        canvas = tk.Canvas(list_frame, bg=BG_DARK, highlightthickness=0)
        scrollbar = tk.Scrollbar(list_frame, orient="vertical", command=canvas.yview,
                                 bg="#000000", troughcolor="#000000",
                                 activebackground=NEON_CYAN, width=10)
        inner = tk.Frame(canvas, bg=BG_DARK)

        inner.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        for team in teams:
            row = tk.Frame(inner, bg=BG_CARD, bd=1, relief="ridge",
                           highlightbackground=FG_DIM, highlightthickness=1)
            row.pack(fill="x", pady=3, ipady=6)

            inner_row = tk.Frame(row, bg=BG_CARD)
            inner_row.pack(fill="x", padx=12, pady=4)

            tk.Label(inner_row, text=team.team_name, font=FONT_BODY_BOLD,
                     fg=FG_PRIMARY, bg=BG_CARD, anchor="w").pack(fill="x")
            tk.Label(inner_row, text=f"{team.pokemon_count} Pokemon  ·  {team.modified[:10]}",
                     font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_CARD, anchor="w").pack(fill="x")

            for widget in [row, inner_row]:
                widget.bind("<Button-1>", lambda e, t=team: self._select(t))
                widget.configure(cursor="hand2")

        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        def _on_wheel(event):
            canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"
        canvas.bind("<MouseWheel>", _on_wheel)

        btn_frame = tk.Frame(self, bg=BG_DARK)
        btn_frame.pack(fill="x", padx=16, pady=12)
        tk.Button(btn_frame, text="Cancel", font=FONT_BODY, bg=BG_CARD,
                  fg=FG_SECONDARY, relief="flat", command=self.destroy,
                  activebackground=BG_HOVER, cursor="hand2").pack(side="right", padx=4)

    def _select(self, team: TeamRecord):
        self.result = team
        self.destroy()


# ── SimPokemonSetSelectorDialog ─────────────────────────────────────────────


class SimPokemonSetSelectorDialog(tk.Toplevel):
    """Split-panel dialog: left = Pokemon list, right = set list for selected Pokemon."""

    def __init__(self, parent, kg: "KnowledgeGraph", slot_index: int):
        super().__init__(parent)
        self.kg = kg
        self.slot_index = slot_index
        self.result: Optional[str] = None
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []
        self._selected_pokemon_id: Optional[str] = None
        self._selected_set_id: Optional[str] = None

        self.title(f"Select Pokemon for Slot {slot_index + 1}")
        self.configure(bg=BG_DARK)
        self.geometry("720x520")
        self.transient(parent)
        self.grab_set()

        self._build_ui()

    def _build_ui(self):
        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True, padx=8, pady=8)

        # ── Left: Pokemon list ──────────────────────────────────────────────
        left = tk.Frame(body, bg=BG_PANEL)
        left.pack(side="left", fill="both", padx=(0, 4))

        tk.Label(left, text="Pokemon", font=FONT_HEADING,
                 fg=FG_PRIMARY, bg=BG_PANEL).pack(anchor="w", padx=10, pady=(8, 4))

        list_outer = tk.Frame(left, bg=BG_PANEL)
        list_outer.pack(fill="both", expand=True, padx=10, pady=(0, 8))

        self._list_canvas = tk.Canvas(list_outer, bg=BG_PANEL,
                                       highlightthickness=0, bd=0)
        sb = tk.Scrollbar(list_outer, orient="vertical",
                          command=self._list_canvas.yview,
                          bg="#000000", troughcolor="#000000",
                          activebackground=NEON_CYAN,
                          highlightthickness=0, bd=0, width=10)
        self._list_inner = tk.Frame(self._list_canvas, bg=BG_PANEL)
        self._list_inner.bind("<Configure>",
                              lambda e: self._list_canvas.configure(
                                  scrollregion=self._list_canvas.bbox("all")))
        self._list_canvas.create_window((0, 0), window=self._list_inner,
                                         anchor="nw", tags="inner")
        self._list_canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self._list_canvas.pack(side="left", fill="both", expand=True)
        self._list_canvas.bind("<Configure>",
                               lambda e: self._list_canvas.itemconfig(
                                   "inner", width=e.width - 4))

        def _on_wheel(event):
            self._list_canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"
        self._list_canvas.bind("<MouseWheel>", _on_wheel)
        self._list_inner.bind("<MouseWheel>", _on_wheel)

        # Populate pokemon list
        self._populate_pokemon_list()

        # ── Right: Set list ────────────────────────────────────────────────
        right = tk.Frame(body, bg=BG_PANEL)
        right.pack(side="right", fill="both", padx=(4, 0))

        self._set_header = tk.Label(right, text="Select a Pokemon",
                                    font=FONT_HEADING, fg=FG_DIM,
                                    bg=BG_PANEL)
        self._set_header.pack(anchor="w", padx=10, pady=(8, 4))

        set_outer = tk.Frame(right, bg=BG_PANEL)
        set_outer.pack(fill="both", expand=True, padx=10, pady=(0, 8))

        self._set_canvas = tk.Canvas(set_outer, bg=BG_PANEL,
                                      highlightthickness=0, bd=0)
        sb2 = tk.Scrollbar(set_outer, orient="vertical",
                           command=self._set_canvas.yview,
                           bg="#000000", troughcolor="#000000",
                           activebackground=NEON_CYAN,
                           highlightthickness=0, bd=0, width=10)
        self._set_inner = tk.Frame(self._set_canvas, bg=BG_PANEL)
        self._set_inner.bind("<Configure>",
                             lambda e: self._set_canvas.configure(
                                 scrollregion=self._set_canvas.bbox("all")))
        self._set_canvas.create_window((0, 0), window=self._set_inner,
                                        anchor="nw", tags="inner")
        self._set_canvas.configure(yscrollcommand=sb2.set)
        sb2.pack(side="right", fill="y")
        self._set_canvas.pack(side="left", fill="both", expand=True)
        self._set_canvas.bind("<Configure>",
                              lambda e: self._set_canvas.itemconfig(
                                  "inner", width=e.width - 4))
        self._set_canvas.bind("<MouseWheel>", _on_wheel)
        self._set_inner.bind("<MouseWheel>", _on_wheel)

        # ── Bottom buttons ─────────────────────────────────────────────────
        btn_frame = tk.Frame(self, bg=BG_DARK)
        btn_frame.pack(fill="x", padx=8, pady=(0, 8))

        self._confirm_btn = tk.Button(
            btn_frame, text="Add to Team", font=FONT_BUTTON,
            fg=BG_DARK, bg=NEON_GREEN,
            activebackground=NEON_GREEN, activeforeground=BG_DARK,
            bd=0, padx=20, pady=6, cursor="hand2",
            command=self._confirm, state="disabled",
        )
        self._confirm_btn.pack(side="right", padx=4)

        tk.Button(
            btn_frame, text="Cancel", font=FONT_BUTTON,
            fg=FG_SECONDARY, bg=BG_CARD,
            activebackground=BG_HOVER, activeforeground=FG_PRIMARY,
            bd=0, padx=20, pady=6, cursor="hand2",
            command=self.destroy,
        ).pack(side="right", padx=4)

    def _populate_pokemon_list(self):
        """Fill the left panel with all Pokemon."""
        all_pokemon = self.kg.get_all_pokemon()
        for w in self._list_inner.winfo_children():
            w.destroy()

        for pkmn in sorted(all_pokemon, key=lambda p: p.name):
            p_id = pkmn.id
            types = getattr(pkmn, "types", [])
            api_name = getattr(pkmn, "api_name", None) or p_id
            sets = self.kg.get_sets(p_id)
            set_count = len(sets) if sets else 0

            row = tk.Frame(self._list_inner, bg=BG_CARD, cursor="hand2")
            row.pack(fill="x", pady=1)

            # Sprite
            sprite_lbl = tk.Label(row, bg=BG_CARD, width=32, height=32)
            sprite_lbl.pack(side="left", padx=(4, 4), pady=2)
            sprite = self._sprite_mgr.get_sprite(api_name, (32, 32))
            if sprite:
                sprite_lbl.configure(image=sprite)
                sprite_lbl.image = sprite
                self._photo_refs.append(sprite)

            # Info
            info = tk.Frame(row, bg=BG_CARD)
            info.pack(side="left", fill="both", expand=True, padx=4, pady=2)

            tk.Label(info, text=pkmn.name, font=FONT_BODY_BOLD,
                     fg=FG_PRIMARY, bg=BG_CARD, anchor="w").pack(fill="x")
            tk.Label(info, text=f"{set_count} sets", font=FONT_SMALL,
                     fg=FG_SECONDARY, bg=BG_CARD, anchor="w").pack(fill="x")

            # Type badges
            if types:
                type_row = tk.Frame(info, bg=BG_CARD)
                type_row.pack(fill="x")
                for t in types[:2]:
                    make_type_badge(type_row, t, font_size=7, padx=2, pady=0).pack(side="left", padx=(0, 2))

            row.bind("<Button-1>", lambda e, pid=p_id: self._on_pokemon_select(pid))
            for child in row.winfo_children():
                child.bind("<Button-1>", lambda e, pid=p_id: self._on_pokemon_select(pid))
                child.configure(cursor="hand2")

    def _on_pokemon_select(self, pokemon_id: str):
        """Handle Pokemon row click — populate set list."""
        self._selected_pokemon_id = pokemon_id
        self._selected_set_id = None
        self._confirm_btn.configure(state="disabled")

        pkmn = self.kg.get_pokemon(pokemon_id)
        self._set_header.configure(text=pkmn.name if pkmn else pokemon_id,
                                   fg=FG_PRIMARY)

        # Populate sets
        for w in self._set_inner.winfo_children():
            w.destroy()

        sets = self.kg.get_sets(pokemon_id) or []
        if not sets:
            tk.Label(self._set_inner, text="No sets available",
                     font=FONT_SMALL, fg=FG_DIM, bg=BG_PANEL,
                     anchor="w").pack(padx=8, pady=12)
            return

        for s in sets:
            set_name = getattr(s, "set_name", "") or getattr(s, "name", "") or "Unnamed"
            role = getattr(s, "role", "") or ""
            item = getattr(s, "item", "") or ""
            ability = getattr(s, "ability", "") or ""
            nature = getattr(s, "nature", "") or ""
            moves = list(getattr(s, "moves", []))[:4]
            move_names = [self.kg.get_move(m).name if self.kg.get_move(m) else m
                          for m in moves]
            set_id = s.id

            row = tk.Frame(self._set_inner, bg=BG_CARD, cursor="hand2")
            row.pack(fill="x", pady=1)

            # Set name header
            header = tk.Frame(row, bg=BG_CARD)
            header.pack(fill="x", padx=6, pady=(4, 0))

            tk.Label(header, text=set_name, font=FONT_BODY_BOLD,
                     fg=FG_PRIMARY, bg=BG_CARD, anchor="w").pack(side="left")
            if role:
                tk.Label(header, text=f"  [{role}]", font=FONT_SMALL,
                         fg=NEON_CYAN, bg=BG_CARD, anchor="w").pack(side="left")

            # Details
            details = []
            if item:
                details.append(f"Item: {item}")
            if ability:
                details.append(f"Ability: {ability}")
            if nature:
                details.append(f"Nature: {nature}")
            if move_names:
                details.append(f"Moves: {', '.join(move_names)}")

            detail_text = "  |  ".join(details) if details else "No details"
            tk.Label(row, text=detail_text, font=FONT_SMALL,
                     fg=FG_SECONDARY, bg=BG_CARD, anchor="w",
                     wraplength=320, justify="left").pack(fill="x", padx=6, pady=(0, 4))

            row.bind("<Button-1>", lambda e, sid=set_id: self._on_set_select(sid))
            for child in row.winfo_children():
                child.bind("<Button-1>", lambda e, sid=set_id: self._on_set_select(sid))
                child.configure(cursor="hand2")

    def _on_set_select(self, set_id: str):
        """Handle set row click."""
        self._selected_set_id = set_id
        self._confirm_btn.configure(state="normal", text="Add to Team")

    def _confirm(self):
        """Confirm selection and close."""
        if self._selected_set_id:
            self.result = self._selected_set_id
        self.destroy()


# ── Main Simulator Page ──────────────────────────────────────────────────────


class SimulatorPage(tk.Frame):
    """Full battle simulator page — 3-column layout with Team A | Center | Team B."""

    def __init__(
        self,
        parent: tk.Widget,
        kg: "KnowledgeGraph",
        matchup_cache: "MatchupCache",
        go_home,
        battle_simulator: "BattleSimulator",
        on_scene_change: Optional[Callable] = None,
    ):
        super().__init__(parent, bg=BG_DARK)
        self.kg = kg
        self.matchup_cache = matchup_cache
        self._go_home = go_home
        self._battle_sim = battle_simulator
        self._on_scene_change = on_scene_change

        # Probabilistic engine (lazy)
        self._engine: Optional[ProbabilisticEngine] = None
        self._current_state: Optional[GameState] = None
        self._last_evaluation: Optional[StateEvaluation] = None

        # Team sets: list[str] of set_ids for each side
        self._team_a_sets: list[str] = []
        self._team_b_sets: list[str] = []

        # Phase: "setup" (team selection) or "simulation" (turn execution)
        self._phase: str = "setup"
        # Locked initial teams — cannot be changed once battle starts
        self._initial_team_a_sets: list[str] = []
        self._initial_team_b_sets: list[str] = []

        # Sprite manager
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []

        # Auto-play state
        self._auto_play_on = False
        self._auto_play_job: Optional[str] = None

        # Undo history (GameState snapshots)
        self._history: list = []

        # Queued actions for next turn
        self._queued_action_a: Optional[dict] = None
        self._queued_action_b: Optional[dict] = None

        # Battle log
        self._log_entries: list[str] = []

        self._build_ui()

    # ── UI Construction ──────────────────────────────────────────────────────

    def _build_ui(self):
        self._build_top_bar()
        self._build_main_body()
        self._build_bottom_panel()

    def _build_top_bar(self):
        """Top control bar."""
        top_bar = tk.Frame(self, bg=BG_PANEL, height=52)
        top_bar.pack(fill="x")
        top_bar.pack_propagate(False)

        btn_back = tk.Button(
            top_bar, text="← Back", font=FONT_BODY, bg=BG_CARD, fg=FG_PRIMARY,
            relief="flat", activebackground=BG_HOVER, activeforeground=FG_PRIMARY,
            command=self._go_home, cursor="hand2", padx=12, pady=6,
        )
        btn_back.pack(side="left", padx=10, pady=8)

        tk.Label(
            top_bar, text="BATTLE SIMULATOR", font=FONT_HEADING,
            fg=NEON_ORANGE, bg=BG_PANEL,
        ).pack(side="left", padx=16)

        self._turn_var = tk.StringVar(value="Turn: 0")
        self._turn_lbl = tk.Label(
            top_bar, textvariable=self._turn_var, font=FONT_BODY_BOLD,
            fg=NEON_YELLOW, bg=BG_PANEL,
        )
        self._turn_lbl.pack(side="left", padx=16)

        spacer = tk.Frame(top_bar, bg=BG_PANEL)
        spacer.pack(side="left", expand=True)

        btn_reset = tk.Button(
            top_bar, text="⟳ Reset", font=FONT_BODY, bg=BG_CARD, fg=NEON_RED,
            relief="flat", activebackground=BG_HOVER,
            command=self._on_reset, cursor="hand2", padx=12, pady=6,
        )
        btn_reset.pack(side="right", padx=6, pady=8)

        self._btn_undo = tk.Button(
            top_bar, text="↩ Undo", font=FONT_BODY, bg=BG_CARD, fg=NEON_YELLOW,
            relief="flat", activebackground=BG_HOVER,
            command=self._on_undo, cursor="hand2", padx=12, pady=6,
        )
        self._btn_undo.pack(side="right", padx=6, pady=8)
        self._btn_undo.configure(state="disabled")

        self._btn_step = tk.Button(
            top_bar, text="▶ Execute Turn", font=FONT_BODY, bg=BG_CARD, fg=NEON_GREEN,
            relief="flat", activebackground=BG_HOVER,
            command=self._on_step, cursor="hand2", padx=12, pady=6,
        )
        self._btn_step.pack(side="right", padx=6, pady=8)

        self._btn_autoplay = tk.Button(
            top_bar, text="⏵ Auto-Play", font=FONT_BODY, bg=BG_CARD, fg=NEON_CYAN,
            relief="flat", activebackground=BG_HOVER,
            command=self._on_toggle_autoplay, cursor="hand2", padx=12, pady=6,
        )
        self._btn_autoplay.pack(side="right", padx=6, pady=8)

    def _build_main_body(self):
        """3-column main body in simulation; 2-column + bottom in setup."""
        # Clear any existing body
        for w in getattr(self, "_main_body_children", []):
            w.destroy()

        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True, padx=8, pady=(4, 4))
        self._main_body_children = [body]

        if self._phase == "setup":
            self._build_setup_body(body)
        else:
            self._build_simulation_body(body)

    def _build_setup_body(self, body: tk.Frame):
        """Setup phase: Team A | Team B side-by-side, field + Start below."""
        body.grid_columnconfigure(0, weight=1, minsize=340)
        body.grid_columnconfigure(1, weight=1, minsize=340)
        body.grid_rowconfigure(0, weight=1)

        # Team A column
        col_a = self._build_setup_team_column(body, "a", NEON_CYAN)
        col_a.grid(row=0, column=0, sticky="nsew", padx=(0, 4))

        # Team B column
        col_b = self._build_setup_team_column(body, "b", NEON_PINK)
        col_b.grid(row=0, column=1, sticky="nsew", padx=(4, 0))

        # Bottom: field conditions + Start Battle
        bottom = tk.Frame(body, bg=BG_DARK)
        bottom.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(6, 0))
        bottom.grid_columnconfigure(0, weight=1)

        self._build_setup_field_panel(bottom)
        self._build_start_battle_button(bottom)

    def _build_simulation_body(self, body: tk.Frame):
        """Simulation phase: 3-column layout with Team A | Center | Team B."""
        body.grid_columnconfigure(0, weight=35, minsize=300)
        body.grid_columnconfigure(1, weight=30, minsize=260)
        body.grid_columnconfigure(2, weight=35, minsize=300)
        body.grid_rowconfigure(0, weight=1)

        # Team A panel (left column)
        self._team_a_col = self._build_team_column(body, "a", NEON_CYAN)
        self._team_a_col.grid(row=0, column=0, sticky="nsew", padx=(0, 4))

        # Center panel
        self._center_panel = self._build_center_panel(body)
        self._center_panel.grid(row=0, column=1, sticky="nsew", padx=4)

        # Team B panel (right column)
        self._team_b_col = self._build_team_column(body, "b", NEON_PINK)
        self._team_b_col.grid(row=0, column=2, sticky="nsew", padx=(4, 0))

    def _build_team_column(self, parent, side: str, color: str) -> tk.Frame:
        """Build one team column: header + active panel + moves + switch/bench list."""
        col = tk.Frame(parent, bg=BG_DARK)

        # ── Team header bar ──────────────────────────────────────────────
        header_bar = tk.Frame(col, bg=BG_PANEL, height=40)
        header_bar.pack(fill="x")
        header_bar.pack_propagate(False)

        header_text = "TEAM A" if side == "a" else "TEAM B"
        tk.Label(header_bar, text=header_text, font=FONT_HEADING,
                 fg=color, bg=BG_PANEL).pack(side="left", padx=10, pady=6)

        spacer_h = tk.Frame(header_bar, bg=BG_PANEL)
        spacer_h.pack(side="left", expand=True)

        # Import button
        import_color = NEON_CYAN if side == "a" else NEON_PINK
        btn_import = tk.Button(
            header_bar, text="⚡ Import", font=FONT_SMALL,
            bg=BG_CARD, fg=import_color, relief="flat", cursor="hand2",
            activebackground=BG_HOVER, padx=8, pady=2,
            command=lambda s=side: self._import_team(s),
        )
        btn_import.pack(side="right", padx=(4, 8), pady=6)

        # Clear button
        btn_clear = tk.Button(
            header_bar, text="✕ Clear", font=FONT_SMALL,
            bg=BG_CARD, fg=NEON_RED, relief="flat", cursor="hand2",
            activebackground=BG_HOVER, padx=8, pady=2,
            command=lambda s=side: self._clear_team(s),
        )
        btn_clear.pack(side="right", padx=4, pady=6)

        # ── Active Pokemon panel ─────────────────────────────────────────
        active_frame = tk.Frame(col, bg=BG_PANEL)
        active_frame.pack(fill="x", padx=6, pady=(4, 2))

        self._build_active_panel(active_frame, side, color)

        # ── Moves grid ───────────────────────────────────────────────────
        moves_frame = tk.Frame(col, bg=BG_PANEL)
        moves_frame.pack(fill="x", padx=6, pady=(2, 2))
        self._build_moves_grid(moves_frame, side)

        # ── Switch + Bench list (combined, shows all 6 with HP/status) ───
        bench_frame = tk.Frame(col, bg=BG_PANEL)
        bench_frame.pack(fill="both", expand=True, padx=6, pady=(2, 4))
        self._build_switch_bench_panel(bench_frame, side, color)

        return col

    # ── Setup Phase UI ─────────────────────────────────────────────────────────

    def _build_setup_team_column(self, parent, side: str, color: str) -> tk.Frame:
        """Build a team selection column for setup phase: import + 6 slot grid."""
        col = tk.Frame(parent, bg=BG_DARK)

        # Header
        header_bar = tk.Frame(col, bg=BG_PANEL, height=40)
        header_bar.pack(fill="x")
        header_bar.pack_propagate(False)

        header_text = "TEAM A" if side == "a" else "TEAM B"
        tk.Label(header_bar, text=header_text, font=FONT_HEADING,
                 fg=color, bg=BG_PANEL).pack(side="left", padx=10, pady=6)

        spacer_h = tk.Frame(header_bar, bg=BG_PANEL)
        spacer_h.pack(side="left", expand=True)

        # Import button
        btn_import = tk.Button(
            header_bar, text="⚡ Import Team", font=FONT_BODY,
            bg=BG_CARD, fg=color, relief="flat", cursor="hand2",
            activebackground=BG_HOVER, padx=10, pady=4,
            command=lambda s=side: self._import_team(s),
        )
        btn_import.pack(side="right", padx=(4, 8), pady=6)
        setattr(self, f"_setup_import_btn_{side}", btn_import)

        # Team info label
        lbl = tk.Label(header_bar, text="0 Pokemon", font=FONT_SMALL,
                       fg=FG_SECONDARY, bg=BG_PANEL)
        setattr(self, f"_setup_info_lbl_{side}", lbl)
        lbl.pack(side="right", padx=8)

        # 6-slot grid
        slots_frame = tk.Frame(col, bg=BG_PANEL)
        slots_frame.pack(fill="both", expand=True, padx=6, pady=(4, 4))

        slots_inner = tk.Frame(slots_frame, bg=BG_PANEL)
        slots_inner.pack(fill="both", expand=True, padx=6, pady=4)

        # 2x3 grid of slots
        slots_inner.grid_columnconfigure(0, weight=1)
        slots_inner.grid_columnconfigure(1, weight=1)
        slots_inner.grid_rowconfigure(0, weight=1)
        slots_inner.grid_rowconfigure(1, weight=1)
        slots_inner.grid_rowconfigure(2, weight=1)

        for i in range(6):
            row_i = i // 2
            col_i = i % 2
            slot = self._build_setup_slot(slots_inner, side, i, color)
            slot.grid(row=row_i, column=col_i, sticky="nsew", padx=4, pady=4)

        # Refresh slot display
        self._refresh_setup_slots(side)

        return col

    def _build_setup_slot(self, parent, side: str, index: int, color: str) -> tk.Frame:
        """Build a single team slot card for setup phase."""
        card = tk.Frame(
            parent, bg=BG_CARD,
            highlightbackground=color, highlightthickness=1,
            relief="ridge", bd=1,
        )
        card.grid_propagate(False)

        content = tk.Frame(card, bg=BG_CARD)
        content.pack(fill="both", expand=True, padx=6, pady=4)
        content.grid_columnconfigure(0, weight=0)   # sprite
        content.grid_columnconfigure(1, weight=1)   # info
        content.grid_rowconfigure(0, weight=1)

        # Sprite placeholder
        sprite_lbl = tk.Label(content, bg=BG_CARD, width=48, height=48,
                              text="?", font=FONT_BODY, fg=FG_DIM)
        sprite_lbl.grid(row=0, column=0, rowspan=2, padx=(0, 6), pady=2)
        setattr(self, f"_setup_sprite_{side}_{index}", sprite_lbl)

        # Info section
        info = tk.Frame(content, bg=BG_CARD)
        info.grid(row=0, column=1, sticky="nsew", padx=(0, 0))
        info.grid_rowconfigure(0, weight=0)  # name
        info.grid_rowconfigure(1, weight=0)  # types
        info.grid_rowconfigure(2, weight=1)  # spacer
        info.grid_rowconfigure(3, weight=0)  # moves preview

        name_lbl = tk.Label(info, text=f"Slot {index + 1}", font=FONT_BODY_BOLD,
                            fg=FG_DIM, bg=BG_CARD, anchor="w")
        name_lbl.grid(row=0, column=0, sticky="w", pady=(2, 0))
        setattr(self, f"_setup_name_{side}_{index}", name_lbl)

        types_fr = tk.Frame(info, bg=BG_CARD)
        types_fr.grid(row=1, column=0, sticky="w", pady=2)
        setattr(self, f"_setup_types_{side}_{index}", types_fr)

        moves_lbl = tk.Label(info, text="", font=FONT_SMALL,
                             fg=FG_SECONDARY, bg=BG_CARD, anchor="w")
        moves_lbl.grid(row=3, column=0, sticky="w", pady=(2, 0))
        setattr(self, f"_setup_moves_{side}_{index}", moves_lbl)

        # Edit button (bottom-right of card)
        btn_edit = tk.Button(
            card, text="✎", font=FONT_SMALL,
            bg=BG_CARD, fg=color, relief="flat", cursor="hand2",
            activebackground=BG_HOVER, padx=6,
            command=lambda s=side, idx=index: self._edit_slot(s, idx),
        )
        btn_edit.place(relx=1.0, rely=1.0, x=-4, y=-4, anchor="se")
        setattr(self, f"_setup_edit_btn_{side}_{index}", btn_edit)

        return card

    def _refresh_setup_slots(self, side: str):
        """Refresh all 6 slot displays for a team in setup phase."""
        sets = self._team_a_sets if side == "a" else self._team_b_sets
        color = NEON_CYAN if side == "a" else NEON_PINK
        count = sum(1 for s in sets if s)

        # Update info label
        info_lbl = getattr(self, f"_setup_info_lbl_{side}", None)
        if info_lbl:
            info_lbl.configure(text=f"{count} Pokemon")

        for i in range(6):
            set_id = sets[i] if i < len(sets) else None
            sprite_lbl = getattr(self, f"_setup_sprite_{side}_{i}")
            name_lbl = getattr(self, f"_setup_name_{side}_{i}")
            types_fr = getattr(self, f"_setup_types_{side}_{i}")
            moves_lbl = getattr(self, f"_setup_moves_{side}_{i}")
            edit_btn = getattr(self, f"_setup_edit_btn_{side}_{i}")

            # Clear previous content
            sprite_lbl.configure(image="", text="?", width=48, height=48)
            for w in types_fr.winfo_children():
                w.destroy()

            if set_id:
                set_obj = self.kg.get_set(set_id)
                pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
                if pkmn:
                    api_name = getattr(pkmn, "api_name", None) or pkmn.id
                    sprite = self._sprite_mgr.get_sprite(api_name, (48, 48))
                    if sprite:
                        sprite_lbl.configure(image=sprite, text="", width=48, height=48)
                        sprite_lbl.image = sprite
                        self._photo_refs.append(sprite)
                    name_lbl.configure(text=pkmn.name, fg=FG_PRIMARY)
                    types = getattr(pkmn, "types", [])
                    for t in types[:2]:
                        make_type_badge(types_fr, t, font_size=7, padx=2, pady=0).pack(side="left", padx=(0, 1))
                    # Show moves preview
                    moves = list(set_obj.moves)[:4]
                    move_names = []
                    for m in moves:
                        mv = self.kg.get_move(m)
                        if mv:
                            move_names.append(mv.name)
                    if move_names:
                        moves_lbl.configure(text=", ".join(move_names[:2]) + ("..." if len(move_names) > 2 else ""))
                else:
                    name_lbl.configure(text=set_id, fg=FG_PRIMARY)
                    moves_lbl.configure(text="")
            else:
                name_lbl.configure(text=f"Slot {i + 1} — Empty", fg=FG_DIM)
                moves_lbl.configure(text="")

    def _build_setup_field_panel(self, parent: tk.Frame):
        """Build field conditions section for setup phase (simplified)."""
        fc = tk.Frame(parent, bg=BG_PANEL, bd=1, relief="ridge",
                      highlightbackground=NEON_YELLOW, highlightthickness=1)
        fc.pack(fill="x", padx=4, pady=(0, 6))

        tk.Label(fc, text="FIELD CONDITIONS", font=FONT_STAT_HEADING,
                 fg=NEON_YELLOW, bg=BG_PANEL).pack(pady=(6, 4))

        inner = tk.Frame(fc, bg=BG_PANEL)
        inner.pack(fill="x", padx=10, pady=(0, 8))

        # Weather row
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Weather:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        weather_var = tk.StringVar(value="None")
        setattr(self, "_weather_var", weather_var)
        weather_btns = self._make_cycle_buttons(
            row, WEATHER_OPTIONS,
            command=lambda val, wv=weather_var: wv.set(val)
        )
        self._weather_btns = weather_btns

        # Terrain row
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Terrain:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        terrain_var = tk.StringVar(value="None")
        setattr(self, "_terrain_var", terrain_var)
        terrain_btns = self._make_cycle_buttons(
            row, TERRAIN_OPTIONS,
            command=lambda val, tv=terrain_var: tv.set(val)
        )
        self._terrain_btns = terrain_btns

        # Side conditions (both sides together)
        sides_row = tk.Frame(inner, bg=BG_PANEL)
        sides_row.pack(fill="x", pady=(4, 0))

        for side, color in [("a", NEON_CYAN), ("b", NEON_PINK)]:
            side_fr = tk.Frame(sides_row, bg=BG_PANEL)
            side_fr.pack(side="left", fill="both", expand=True, padx=2)

            tk.Label(side_fr, text=f"Side {'A' if side == 'a' else 'B'}:",
                     font=FONT_SMALL, fg=color, bg=BG_PANEL).pack(anchor="w", padx=4)

            # Stealth Rock toggle
            self._make_toggle_row(side_fr, "Stealth Rock", side, "sr",
                                  self._on_sr_toggle_setup, NEON_RED)

            # Spikes
            spikes_row = tk.Frame(side_fr, bg=BG_PANEL)
            spikes_row.pack(fill="x", pady=1, padx=4)
            tk.Label(spikes_row, text="Spikes:", font=FONT_SMALL,
                     fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
            self._make_cycle_buttons(
                spikes_row, ["0", "1", "2", "3"],
                command=lambda val, s=side: self._on_spikes_change(s, val)
            )

    def _build_start_battle_button(self, parent: tk.Frame):
        """Build the Start Battle button (disabled until both teams have Pokemon)."""
        btn_frame = tk.Frame(parent, bg=BG_DARK)
        btn_frame.pack(fill="x", padx=4, pady=(0, 4))

        self._start_battle_btn = tk.Button(
            btn_frame, text="⚔  START BATTLE", font=FONT_HEADING,
            bg=BG_CARD, fg=FG_DIM, relief="ridge",
            activebackground=BG_HOVER, cursor="hand2",
            padx=20, pady=10, bd=3,
            command=self._on_start_battle,
            state="disabled",
        )
        self._start_battle_btn.pack(fill="x", pady=(0, 4))

        # Status line
        self._start_battle_status = tk.Label(
            btn_frame, text="Add at least 1 Pokemon to each team to start.",
            font=FONT_SMALL, fg=FG_DIM, bg=BG_DARK, anchor="center",
        )
        self._start_battle_status.pack()

        self._update_start_battle_state()

    def _update_start_battle_state(self):
        """Update Start Battle button enabled state based on team counts."""
        count_a = sum(1 for s in self._team_a_sets if s)
        count_b = sum(1 for s in self._team_b_sets if s)
        can_start = count_a > 0 and count_b > 0

        if hasattr(self, "_start_battle_btn"):
            self._start_battle_btn.configure(
                state="normal" if can_start else "disabled",
                fg=NEON_GREEN if can_start else FG_DIM,
                cursor="hand2" if can_start else "",
            )
        if hasattr(self, "_start_battle_status"):
            if can_start:
                self._start_battle_status.configure(
                    text=f"Ready! Team A: {count_a} Pokemon  ·  Team B: {count_b} Pokemon",
                    fg=NEON_GREEN,
                )
            else:
                self._start_battle_status.configure(
                    text=f"Need Pokemon on both teams. Team A: {count_a}/6  ·  Team B: {count_b}/6",
                    fg=FG_DIM,
                )

    def _on_start_battle(self):
        """Transition from setup to simulation phase."""
        if self._phase == "simulation":
            return

        # Lock in the initial teams
        self._initial_team_a_sets = list(self._team_a_sets)
        self._initial_team_b_sets = list(self._team_b_sets)

        self._phase = "simulation"

        # Initialize engine and create state
        self._init_engine()
        if self._engine is None:
            messagebox.showerror("Engine Error", "Could not initialize battle engine.")
            return

        try:
            self._current_state = self._engine.create_state_from_sets(
                self._initial_team_a_sets, self._initial_team_b_sets,
            )
            self._apply_field_conditions_to_state()
            self._turn_var.set("Turn: 0")
            self._add_log("Battle started!")
            self.notify_scene_change()
        except Exception as e:
            messagebox.showerror("State Error", f"Failed to create battle state: {e}")
            return

        # Rebuild UI to simulation layout
        self._rebuild_simulation_ui()
        self._refresh_all()

    def _rebuild_simulation_ui(self):
        """Rebuild main body into simulation layout."""
        self._build_main_body()
        self._update_simulation_lock_state()

    def _update_simulation_lock_state(self):
        """Lock/unlock UI elements based on simulation phase."""
        locked = self._phase == "simulation"

        # Lock setup import buttons
        for side in ("a", "b"):
            btn = getattr(self, f"_setup_import_btn_{side}", None)
            if btn and btn.winfo_exists():
                btn.configure(state="disabled" if locked else "normal",
                              fg=FG_DIM if locked else (NEON_CYAN if side == "a" else NEON_PINK))

            # Lock setup edit buttons
            for i in range(6):
                edit_btn = getattr(self, f"_setup_edit_btn_{side}_{i}", None)
                if edit_btn and edit_btn.winfo_exists():
                    edit_btn.configure(state="disabled" if locked else "normal")

    def _build_active_panel(self, parent, side: str, color: str):
        """Build the active Pokemon detail panel for one side."""
        panel = tk.Frame(parent, bg=BG_PANEL)

        content = tk.Frame(panel, bg=BG_PANEL)
        content.pack(fill="x", padx=6, pady=4)
        content.grid_columnconfigure(0, weight=0)   # sprite
        content.grid_columnconfigure(1, weight=1)   # info

        # Large sprite
        sprite_lbl = tk.Label(content, bg=BG_PANEL, width=96, height=96)
        sprite_lbl.grid(row=0, column=0, rowspan=8, padx=(0, 8), pady=4)
        setattr(self, f"_active_sprite_{side}", sprite_lbl)

        # Name
        name_lbl = tk.Label(content, text="—", font=FONT_BODY_BOLD,
                            fg=FG_PRIMARY, bg=BG_PANEL, anchor="w")
        name_lbl.grid(row=0, column=1, sticky="ew", pady=(4, 0))
        setattr(self, f"_active_name_{side}", name_lbl)

        # Types
        types_frame = tk.Frame(content, bg=BG_PANEL)
        types_frame.grid(row=1, column=1, sticky="w", pady=2)
        setattr(self, f"_active_types_{side}", types_frame)

        # HP bar (large)
        hp_frame = tk.Frame(content, bg=BG_PANEL)
        hp_frame.grid(row=2, column=1, sticky="ew", pady=2)
        hp_canvas = HPBarCanvas(hp_frame, 0, 1, width=160, height=18, bg=BG_PANEL)
        hp_canvas.pack(fill="x")
        setattr(self, f"_active_hp_{side}", hp_canvas)

        # HP text
        hp_lbl = tk.Label(content, text="0 / 0", font=FONT_SMALL,
                          fg=FG_SECONDARY, bg=BG_PANEL, anchor="w")
        hp_lbl.grid(row=3, column=1, sticky="w", pady=(0, 2))
        setattr(self, f"_active_hp_lbl_{side}", hp_lbl)

        # Status + stat modifiers
        status_frame = tk.Frame(content, bg=BG_PANEL)
        status_frame.grid(row=4, column=1, sticky="w", pady=2)
        setattr(self, f"_active_status_{side}", status_frame)

        # Queued switch indicator
        queued_switch_frame = tk.Frame(content, bg=BG_PANEL)
        queued_switch_frame.grid(row=5, column=1, sticky="w", pady=2)
        setattr(self, f"_queued_switch_{side}", tk.Label(
            queued_switch_frame, text="", font=FONT_SMALL,
            fg=NEON_CYAN, bg=BG_PANEL, anchor="w",
        ))
        getattr(self, f"_queued_switch_{side}").pack(side="left")

        # Modifier editor row (status dropdown + stat spinboxes)
        mod_frame = tk.Frame(content, bg=BG_PANEL)
        mod_frame.grid(row=6, column=1, sticky="ew", pady=2)

        # Status dropdown
        tk.Label(mod_frame, text="Status:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left", padx=(0, 4))
        status_var = tk.StringVar(value="none")
        status_combo = ttk.Combobox(mod_frame, textvariable=status_var,
                                    values=["none", "burn", "poison", "toxic", "sleep", "paralysis", "freeze"],
                                    state="readonly", width=10, font=FONT_SMALL)
        status_combo.pack(side="left", padx=4)
        status_combo.bind("<<ComboboxSelected>>", lambda e, s=side, sv=status_var: self._on_status_change(s, sv))
        setattr(self, f"_status_var_{side}", status_var)

        # Stat boost/penalty for each stat (except HP)
        stat_frame_inner = tk.Frame(mod_frame, bg=BG_PANEL)
        stat_frame_inner.pack(side="left", padx=(8, 0))
        for stat in STAT_NAMES:
            st_frame = tk.Frame(stat_frame_inner, bg=BG_PANEL)
            st_frame.pack(side="left", padx=2)
            tk.Label(st_frame, text=STAT_LABELS.get(stat, stat), font=FONT_SMALL,
                     fg=FG_SECONDARY, bg=BG_PANEL).pack()
            stat_val_var = tk.StringVar(value="0")
            stat_spin = ttk.Spinbox(st_frame, from_=-6, to=6, textvariable=stat_val_var,
                                    width=3, font=FONT_SMALL,
                                    command=lambda st=stat, sv=stat_val_var, sd=side: self._on_stat_change(sd, st, sv))
            stat_spin.pack()
            stat_spin.bind("<FocusOut>", lambda e, st=stat, sv=stat_val_var, sd=side: self._on_stat_change(sd, st, sv))
            setattr(self, f"_stat_var_{stat}_{side}", stat_val_var)

        panel.pack(fill="x")
        return panel

    def _build_moves_grid(self, parent, side: str):
        """Build 2x2 move buttons grid for the active Pokemon of this side."""
        grid = tk.Frame(parent, bg=BG_PANEL)
        grid.pack(fill="x", pady=4)

        tk.Label(grid, text="MOVES", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(anchor="w", padx=4, pady=(0, 2))

        moves_inner = tk.Frame(grid, bg=BG_PANEL)
        moves_inner.pack(fill="x", padx=4, pady=(0, 4))

        # 2x2 grid
        moves_inner.grid_columnconfigure(0, weight=1)
        moves_inner.grid_columnconfigure(1, weight=1)

        buttons = []
        for i in range(4):
            btn = tk.Button(
                moves_inner, text="—", font=FONT_SMALL,
                bg=BG_CARD, fg=FG_DIM, relief="ridge",
                activebackground=BG_HOVER, cursor="hand2",
                bd=2, wraplength=130, height=2,
                command=lambda idx=i, s=side: self._on_move_click(idx, s),
            )
            row_i = i // 2
            col_i = i % 2
            btn.grid(row=row_i, column=col_i, sticky="ew", padx=2, pady=2)
            buttons.append(btn)

        setattr(self, f"_move_btns_{side}", buttons)

    def _build_switch_bench_panel(self, parent, side: str, color: str):
        """Build combined switch + bench list showing all 6 Pokemon."""
        panel = tk.Frame(parent, bg=BG_PANEL)

        tk.Label(panel, text="TEAM", font=FONT_SMALL,
                 fg=color, bg=BG_PANEL).pack(anchor="w", padx=6, pady=(4, 2))

        list_outer = tk.Frame(panel, bg=BG_PANEL)
        list_outer.pack(fill="both", expand=True, padx=6, pady=(0, 4))

        canvas = tk.Canvas(list_outer, bg=BG_PANEL, highlightthickness=0, bd=0)
        sb = tk.Scrollbar(list_outer, orient="vertical",
                          command=canvas.yview,
                          bg="#000000", troughcolor="#000000",
                          activebackground=color, width=8)
        inner = tk.Frame(canvas, bg=BG_PANEL)
        inner.bind("<Configure>",
                   lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)
        canvas.bind("<Configure>",
                    lambda e: canvas.itemconfig("inner", width=e.width - 4))

        def _on_wheel(event):
            canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"
        canvas.bind("<MouseWheel>", _on_wheel)
        inner.bind("<MouseWheel>", _on_wheel)

        setattr(self, f"_team_list_canvas_{side}", canvas)
        setattr(self, f"_team_list_inner_{side}", inner)
        setattr(self, f"_team_list_scrollbar_{side}", sb)

        panel.pack(fill="both", expand=True)
        return panel

    def _build_center_panel(self, parent) -> tk.Frame:
        """Build the center column with field/side conditions and action buttons."""
        center = tk.Frame(parent, bg=BG_DARK)

        # Scrollable canvas for center content
        center_canvas = tk.Canvas(center, bg=BG_DARK, highlightthickness=0, bd=0)
        center_sb = tk.Scrollbar(center, orient="vertical",
                                  command=center_canvas.yview,
                                  bg="#000000", troughcolor="#000000",
                                  activebackground=NEON_YELLOW, width=8)
        center_inner = tk.Frame(center_canvas, bg=BG_DARK)
        center_inner.bind("<Configure>",
                          lambda e: center_canvas.configure(
                              scrollregion=center_canvas.bbox("all")))
        center_canvas.create_window((0, 0), window=center_inner, anchor="nw")
        center_canvas.configure(yscrollcommand=center_sb.set)
        center_sb.pack(side="right", fill="y")
        center_canvas.pack(side="left", fill="both", expand=True)

        def _on_wheel(event):
            center_canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"
        center_canvas.bind("<MouseWheel>", _on_wheel)
        center_inner.bind("<MouseWheel>", _on_wheel)

        # Field conditions
        self._build_field_conditions(center_inner)

        # Side A conditions
        self._build_side_conditions(center_inner, "a", NEON_CYAN)

        # Side B conditions
        self._build_side_conditions(center_inner, "b", NEON_PINK)

        # Action buttons at bottom
        self._build_center_action_buttons(center_inner)

        return center

    def _build_field_conditions(self, parent: tk.Frame):
        """Build field conditions section (weather, terrain, trick room)."""
        fc = tk.Frame(parent, bg=BG_PANEL, bd=1, relief="ridge",
                      highlightbackground=NEON_YELLOW, highlightthickness=1)
        fc.pack(fill="x", padx=4, pady=(0, 6))

        tk.Label(fc, text="FIELD CONDITIONS", font=FONT_STAT_HEADING,
                 fg=NEON_YELLOW, bg=BG_PANEL).pack(pady=(6, 4))

        inner = tk.Frame(fc, bg=BG_PANEL)
        inner.pack(fill="x", padx=10, pady=(0, 8))

        # Weather row
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Weather:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        weather_btns = self._make_cycle_buttons(
            row, WEATHER_OPTIONS,
            command=lambda val: self._on_weather_change(val)
        )
        self._weather_btns = weather_btns

        # Terrain row
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Terrain:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        terrain_btns = self._make_cycle_buttons(
            row, TERRAIN_OPTIONS,
            command=lambda val: self._on_terrain_change(val)
        )
        self._terrain_btns = terrain_btns

        # Trick Room row
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=(2, 4))
        tk.Label(row, text="Trick Room:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        self._trick_room_var = tk.BooleanVar(value=False)
        tr_btn = tk.Button(
            row, text="OFF", font=FONT_SMALL,
            bg=BG_CARD, fg=FG_DIM, relief="ridge",
            activebackground=BG_HOVER, cursor="hand2", padx=8,
            command=self._on_trick_room_toggle,
        )
        tr_btn.pack(side="right")
        self._trick_room_btn = tr_btn

    def _make_cycle_buttons(self, parent, options: list,
                            command=None) -> list[tk.Button]:
        """Create a row of buttons that cycle through options (single click)."""
        btns = []
        active_idx = [0]  # mutable container

        def make_click(idx_ref, option):
            def click():
                idx_ref[0] = idx_ref[0]  # mark used
                for b in btns:
                    b.configure(bg=BG_CARD, fg=FG_DIM)
                btn.configure(bg=NEON_GREEN, fg=BG_DARK)
                if command:
                    command(option)
            return click

        for i, opt in enumerate(options):
            is_first = (i == 0)
            btn = tk.Button(
                parent, text=opt, font=FONT_SMALL,
                bg=NEON_GREEN if is_first else BG_CARD,
                fg=BG_DARK if is_first else FG_DIM,
                relief="ridge", activebackground=BG_HOVER,
                cursor="hand2", padx=6,
                command=make_click(active_idx, opt),
            )
            btn.pack(side="right", padx=2)
            btns.append(btn)

        return btns

    def _build_side_conditions(self, parent: tk.Frame, side: str, color: str):
        """Build side conditions panel for one side."""
        frame = tk.Frame(parent, bg=BG_PANEL, bd=1, relief="ridge",
                         highlightbackground=color, highlightthickness=1)
        frame.pack(fill="x", padx=4, pady=(0, 6))

        header_text = f"SIDE {'A' if side == 'a' else 'B'} CONDITIONS"
        tk.Label(frame, text=header_text, font=FONT_STAT_HEADING,
                 fg=color, bg=BG_PANEL).pack(pady=(6, 4))

        inner = tk.Frame(frame, bg=BG_PANEL)
        inner.pack(fill="x", padx=10, pady=(0, 8))

        # Spikes (0-1-2-3 cycle)
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Spikes:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        spike_btns = self._make_cycle_buttons(
            row, ["0", "1", "2", "3"],
            command=lambda val: self._on_spikes_change(side, val)
        )
        setattr(self, f"_spike_btns_{side}", spike_btns)

        # Toxic Spikes (0-1-2 cycle)
        row = tk.Frame(inner, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text="Toxic Spikes:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        tp_btns = self._make_cycle_buttons(
            row, ["0", "1", "2"],
            command=lambda val: self._on_toxic_spikes_change(side, val)
        )
        setattr(self, f"_toxic_spike_btns_{side}", tp_btns)

        # Stealth Rock toggle
        self._make_toggle_row(inner, "Stealth Rock", side, "sr",
                              self._on_sr_toggle, NEON_RED)

        # Sticky Web toggle
        self._make_toggle_row(inner, "Sticky Web", side, "web",
                              self._on_web_toggle, NEON_PURPLE)

        # Reflect toggle
        self._make_toggle_row(inner, "Reflect", side, "reflect",
                              self._on_screen_toggle, NEON_CYAN)

        # Light Screen toggle
        self._make_toggle_row(inner, "Light Screen", side, "ls",
                              self._on_screen_toggle, NEON_CYAN)

        # Aurora Veil toggle
        self._make_toggle_row(inner, "Aurora Veil", side, "veil",
                              self._on_screen_toggle, NEON_CYAN)

    def _make_toggle_row(self, parent, label: str, side: str,
                         key: str, command, active_color: str):
        """Create a toggle button row for a boolean condition."""
        row = tk.Frame(parent, bg=BG_PANEL)
        row.pack(fill="x", pady=2)
        tk.Label(row, text=f"{label}:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")

        var = tk.BooleanVar(value=False)
        setattr(self, f"_{key}_{side}_var", var)

        btn = tk.Button(
            row, text="OFF", font=FONT_SMALL,
            bg=BG_CARD, fg=FG_DIM, relief="ridge",
            activebackground=BG_HOVER, cursor="hand2", padx=8,
            command=lambda: self._on_bool_toggle(side, key, var, btn, command),
        )
        btn.pack(side="right")
        setattr(self, f"_{key}_{side}_btn", btn)

    def _on_bool_toggle(self, side: str, key: str, var: tk.BooleanVar,
                        btn: tk.Button, command):
        """Toggle a boolean condition and update button appearance."""
        var.set(not var.get())
        if var.get():
            btn.configure(text="ON", bg=NEON_GREEN, fg=BG_DARK)
        else:
            btn.configure(text="OFF", bg=BG_CARD, fg=FG_DIM)
        if command:
            command(side, key)

    def _build_center_action_buttons(self, parent: tk.Frame):
        """Build action buttons at bottom of center panel."""
        btn_frame = tk.Frame(parent, bg=BG_DARK)
        btn_frame.pack(fill="x", padx=4, pady=(4, 8))

        # Next Turn button (disabled until both sides queue an action)
        self._center_step_btn = tk.Button(
            btn_frame, text="▶ Next Turn", font=FONT_BUTTON,
            bg=BG_CARD, fg=FG_DIM, relief="ridge",
            activebackground=BG_HOVER, cursor="",
            padx=12, pady=8,
            command=self._on_step,
            state="disabled",
        )
        self._center_step_btn.pack(fill="x", pady=(0, 4))

        # Auto-Play button
        auto_btn = tk.Button(
            btn_frame, text="⏵ Auto-Play", font=FONT_BUTTON,
            bg=BG_CARD, fg=NEON_CYAN, relief="ridge",
            activebackground=BG_HOVER, cursor="hand2",
            padx=12, pady=8,
            command=self._on_toggle_autoplay,
        )
        auto_btn.pack(fill="x")
        self._center_autoplay_btn = auto_btn

        # Queued action display (both sides)
        queue_frame = tk.Frame(parent, bg=BG_PANEL)
        queue_frame.pack(fill="x", padx=4, pady=(0, 4))
        tk.Label(queue_frame, text="QUEUED ACTIONS (A | B):", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(anchor="w", padx=4, pady=(4, 0))
        self._queued_lbl = tk.Label(queue_frame, text="A: Waiting... | B: Waiting...",
                                    font=FONT_SMALL, fg=NEON_YELLOW,
                                    bg=BG_PANEL, anchor="w")
        self._queued_lbl.pack(fill="x", padx=4, pady=(0, 4))

    def _build_bottom_panel(self):
        """Build bottom row: battle log (70%) + MCTS results (30%)."""
        bottom = tk.Frame(self, bg=BG_DARK, height=200)
        bottom.pack(fill="x", side="bottom", padx=8, pady=(4, 6))
        bottom.pack_propagate(False)
        bottom.grid_columnconfigure(0, weight=7, minsize=400)
        bottom.grid_columnconfigure(1, weight=3, minsize=200)
        bottom.grid_rowconfigure(0, weight=1)

        # Battle Log
        log_frame = tk.Frame(bottom, bg=BG_PANEL, bd=1, relief="ridge",
                             highlightbackground=FG_DIM, highlightthickness=1)
        log_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 4))

        tk.Label(log_frame, text="BATTLE LOG", font=FONT_HEADING,
                 fg=NEON_GREEN, bg=BG_PANEL).pack(pady=(6, 4))

        log_canvas = tk.Canvas(log_frame, bg=BG_DARK, highlightthickness=0)
        log_scrollbar = tk.Scrollbar(log_frame, orient="vertical",
                                     command=log_canvas.yview,
                                     bg="#000000", troughcolor="#000000",
                                     activebackground=NEON_CYAN, width=10)
        self._log_inner = tk.Frame(log_canvas, bg=BG_DARK)
        self._log_inner.bind(
            "<Configure>",
            lambda e: log_canvas.configure(scrollregion=log_canvas.bbox("all"))
        )
        log_canvas.create_window((0, 0), window=self._log_inner, anchor="nw")
        log_canvas.configure(yscrollcommand=log_scrollbar.set)

        def _on_wheel(event):
            log_canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"
        log_canvas.bind("<MouseWheel>", _on_wheel)
        self._log_inner.bind("<MouseWheel>", _on_wheel)

        log_canvas.pack(side="left", fill="both", expand=True, padx=(8, 0), pady=(0, 8))
        log_scrollbar.pack(side="right", fill="y", pady=(24, 8))

        self._log_canvas = log_canvas

        # MCTS Results
        mcts_frame = tk.Frame(bottom, bg=BG_PANEL, bd=1, relief="ridge",
                              highlightbackground=FG_DIM, highlightthickness=1)
        mcts_frame.grid(row=0, column=1, sticky="nsew", padx=(4, 0))

        tk.Label(mcts_frame, text="MCTS TOP ACTIONS", font=FONT_HEADING,
                 fg=NEON_PURPLE, bg=BG_PANEL).pack(pady=(6, 4))

        self._mcts_inner = tk.Frame(mcts_frame, bg=BG_PANEL)
        self._mcts_inner.pack(fill="both", expand=True, padx=10, pady=(0, 8))

        self._mcts_labels: list[tuple[tk.Label, tk.Label, tk.Label]] = []
        for i in range(8):
            row = tk.Frame(self._mcts_inner, bg=BG_PANEL)
            row.pack(fill="x", pady=1)

            rank = tk.Label(row, text=f"{i+1}.", font=FONT_SMALL,
                            fg=FG_DIM, bg=BG_PANEL, width=3, anchor="e")
            rank.pack(side="left")

            act_lbl = tk.Label(row, text="—", font=FONT_SMALL,
                               fg=FG_SECONDARY, bg=BG_PANEL, anchor="w")
            act_lbl.pack(side="left", padx=4, fill="x", expand=True)

            pct_lbl = tk.Label(row, text="", font=FONT_SMALL,
                               fg=NEON_CYAN, bg=BG_PANEL, anchor="e")
            pct_lbl.pack(side="right")

            self._mcts_labels.append((rank, act_lbl, pct_lbl))

    # ── Team Management ───────────────────────────────────────────────────────

    def _import_team(self, side: str):
        """Open team picker dialog and import selected team."""
        try:
            store = TeamStore()
            teams = store.list_teams()
            if not teams:
                messagebox.showinfo("No Teams",
                                    "Save some teams first using the Team Builder.")
                return

            label = "Team A" if side == "a" else "Team B"
            dialog = TeamPickerDialog(self, teams, label)
            self.wait_window(dialog)
            if dialog.result:
                sets = list(dialog.result.sets)
                # Pad to 6 slots with empty strings
                while len(sets) < 6:
                    sets.append("")
                if side == "a":
                    self._team_a_sets = sets
                else:
                    self._team_b_sets = sets

                # In setup phase: refresh setup slots and update Start Battle state
                if self._phase == "setup":
                    self._refresh_setup_slots(side)
                    self._update_start_battle_state()
                    self._add_log(f"{label} imported: {dialog.result.team_name} "
                                  f"({len([s for s in dialog.result.sets if s])} Pokemon)")
                else:
                    # Simulation phase: refresh the team list and active panel
                    self._refresh_team_list(side)
                    self._add_log(f"{label} imported: {dialog.result.team_name} "
                                  f"({len([s for s in dialog.result.sets if s])} Pokemon)")
        except Exception as e:
            messagebox.showerror("Error", f"Failed to import team: {e}")

    def _clear_team(self, side: str):
        """Clear all sets for one team (setup phase only)."""
        if self._phase != "setup":
            return
        if side == "a":
            self._team_a_sets = []
        else:
            self._team_b_sets = []
        self._refresh_setup_slots(side)
        self._update_start_battle_state()
        self._add_log(f"Team {'A' if side == 'a' else 'B'} cleared")

    def _edit_slot(self, side: str, slot_index: int):
        """Open set selector dialog for a specific team slot."""
        # In simulation phase, editing is disabled (teams are locked)
        if self._phase == "simulation":
            return
        dialog = SimPokemonSetSelectorDialog(self, self.kg, slot_index)
        self.wait_window(dialog)
        if dialog.result:
            if side == "a":
                while len(self._team_a_sets) <= slot_index:
                    self._team_a_sets.append("")
                self._team_a_sets[slot_index] = dialog.result
            else:
                while len(self._team_b_sets) <= slot_index:
                    self._team_b_sets.append("")
                self._team_b_sets[slot_index] = dialog.result

            # Setup phase: refresh setup slots and update Start Battle state
            if self._phase == "setup":
                self._refresh_setup_slots(side)
                self._update_start_battle_state()
            else:
                self._refresh_team_list(side)
            self._add_log(f"Slot {slot_index + 1} set to {dialog.result}")

    # ── Display Refresh ───────────────────────────────────────────────────────

    def _refresh_team_list(self, side: str):
        """Redraw the combined switch+bench list for a team."""
        inner: tk.Frame = getattr(self, f"_team_list_inner_{side}")
        if not inner:
            return

        for w in inner.winfo_children():
            w.destroy()

        sets = self._team_a_sets if side == "a" else self._team_b_sets
        color = NEON_CYAN if side == "a" else NEON_PINK

        # Get Pokemon states if battle is active
        pstates = []
        if self._current_state:
            team = (self._current_state.team_a if side == "a"
                    else self._current_state.team_b)
            pstates = list(team)

        for i in range(TEAM_SIZE):
            set_id = sets[i] if i < len(sets) else None

            # Determine state
            pstate = pstates[i] if i < len(pstates) else None

            # Determine display HP
            if pstate:
                current_hp = pstate.current_hp
                max_hp = pstate.max_hp
                is_fainted = pstate.is_fainted
                is_active = pstate.is_active
            elif set_id:
                # Use set max HP as fallback
                set_obj = self.kg.get_set(set_id)
                if set_obj:
                    max_hp = getattr(set_obj, "max_hp", 100)
                    current_hp = max_hp
                else:
                    current_hp, max_hp = 0, 1
                is_fainted = False
                is_active = False
            else:
                current_hp, max_hp = 0, 1
                is_fainted = False
                is_active = False

            # Card background
            if is_active:
                bg = BG_CARD
                highlight = color
            elif is_fainted:
                bg = BG_INPUT
                highlight = FG_DIM
            else:
                bg = BG_PANEL
                highlight = FG_DIM

            row = tk.Frame(inner, bg=bg, cursor="hand2",
                           highlightbackground=highlight, highlightthickness=1)
            row.pack(fill="x", pady=1)

            # Only allow clicking non-active, non-fainted slots to queue switch
            if not is_active and not is_fainted and set_id:
                row.bind("<Button-1>", lambda e, s=side, idx=i: self._on_bench_click(s, idx))
                for child in row.winfo_children():
                    child.bind("<Button-1>", lambda e, s=side, idx=i: self._on_bench_click(s, idx))
                    child.configure(cursor="hand2")

            # Edit button (pencil icon)
            btn_edit = tk.Button(
                row, text="✎", font=FONT_SMALL,
                bg=bg, fg=FG_DIM, relief="flat", cursor="hand2",
                activebackground=BG_HOVER, padx=4,
                command=lambda s=side, idx=i: self._edit_slot(s, idx),
            )
            btn_edit.pack(side="right", padx=(0, 2), pady=2)

            # Sprite
            sprite_lbl = tk.Label(row, bg=bg, width=32, height=32)
            sprite_lbl.pack(side="left", padx=(4, 4), pady=2)

            if set_id:
                set_obj = self.kg.get_set(set_id)
                pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
                if pkmn:
                    api_name = getattr(pkmn, "api_name", None) or pkmn.id
                    sprite = self._sprite_mgr.get_sprite(api_name, (32, 32))
                    if sprite:
                        sprite_lbl.configure(image=sprite)
                        sprite_lbl.image = sprite
                        self._photo_refs.append(sprite)
                    types = getattr(pkmn, "types", [])
                else:
                    types = []
            else:
                types = []
                sprite_lbl.configure(text="?", font=FONT_BODY, fg=FG_DIM)

            # Info
            info = tk.Frame(row, bg=bg)
            info.pack(side="left", fill="both", expand=True, padx=4, pady=2)

            # Name row
            name_row = tk.Frame(info, bg=bg)
            name_row.pack(fill="x")

            if set_id:
                set_obj = self.kg.get_set(set_id)
                pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
                name = pkmn.name if pkmn else (set_id or "?")
            else:
                name = f"Slot {i + 1} — Empty"

            status_indicator = ""
            if is_active:
                status_indicator = " ACTIVE "
                txt_color = color
            elif is_fainted:
                status_indicator = " FAINTED "
                txt_color = HP_RED
            else:
                txt_color = FG_PRIMARY

            lbl_name = tk.Label(name_row, text=name, font=FONT_BODY_BOLD,
                                fg=txt_color, bg=bg, anchor="w")
            lbl_name.pack(side="left")

            if status_indicator:
                tk.Label(name_row, text=status_indicator,
                         font=("Consolas", 7, "bold"),
                         fg=BG_DARK, bg=color if is_active else HP_RED,
                         padx=2).pack(side="right")

            # Type badges + HP bar row
            detail_row = tk.Frame(info, bg=bg)
            detail_row.pack(fill="x")

            # Type badges
            if types:
                types_fr = tk.Frame(detail_row, bg=bg)
                types_fr.pack(side="left")
                for t in types[:2]:
                    make_type_badge(types_fr, t, font_size=7, padx=2, pady=0).pack(side="left", padx=(0, 1))

            # HP bar
            hp_bar_fr = tk.Frame(detail_row, bg=bg)
            hp_bar_fr.pack(side="left", fill="x", expand=True, padx=(4, 0))
            hp_canvas = HPBarCanvas(hp_bar_fr, current_hp, max_hp,
                                    width=80, height=8, bg=bg)
            hp_canvas.pack(fill="x")

            hp_text = f"{current_hp}/{max_hp}"
            tk.Label(detail_row, text=hp_text, font=FONT_SMALL,
                     fg=FG_SECONDARY, bg=bg, anchor="e").pack(side="right")

            # Status badges
            if pstate and pstate.has_status():
                status_fr = tk.Frame(info, bg=bg)
                status_fr.pack(fill="x")
                for cond in ["burn", "poison", "toxic", "sleep", "paralysis", "freeze"]:
                    if pstate.has_condition(cond):
                        make_status_badge(status_fr, cond).pack(side="left", padx=(0, 1))

    def _refresh_active_panel(self, side: str):
        """Refresh the active Pokemon detail panel for one side."""
        if not self._current_state:
            return

        active = self._current_state.get_active_pokemon(side)
        if not active:
            return

        set_obj = self.kg.get_set(active.set_id)
        pokemon = self.kg.get_pokemon(active.pokemon_id) if set_obj else None
        name = pokemon.name if pokemon else active.pokemon_id
        api_name = getattr(pokemon, "api_name", None) or active.pokemon_id
        types = getattr(pokemon, "types", []) if pokemon else []
        current_hp = active.current_hp
        max_hp = active.max_hp
        hp_pct = active.hp_percent

        # Sprite
        sprite_lbl: tk.Label = getattr(self, f"_active_sprite_{side}")
        sprite = self._sprite_mgr.get_sprite(api_name, (96, 96))
        if sprite:
            sprite_lbl.configure(image=sprite)
            sprite_lbl.image = sprite
            self._photo_refs.append(sprite)
        else:
            sprite_lbl.configure(text="?", image="", width=96, height=96)

        # Name
        name_lbl: tk.Label = getattr(self, f"_active_name_{side}")
        name_lbl.configure(text=name)

        # Types
        types_frame: tk.Frame = getattr(self, f"_active_types_{side}")
        for w in types_frame.winfo_children():
            w.destroy()
        for t in types:
            make_type_badge(types_frame, t, font_size=9, padx=4).pack(side="left", padx=(0, 3))

        # HP bar
        hp_canvas: HPBarCanvas = getattr(self, f"_active_hp_{side}")
        hp_canvas.set_hp(current_hp, max_hp)

        # HP text
        hp_lbl: tk.Label = getattr(self, f"_active_hp_lbl_{side}")
        hp_lbl.configure(text=f"{current_hp} / {max_hp}  ({hp_pct:.0f}%)")

        # Status + stat modifiers
        status_frame: tk.Frame = getattr(self, f"_active_status_{side}")
        for w in status_frame.winfo_children():
            w.destroy()

        for cond in ["burn", "poison", "toxic", "sleep", "paralysis", "freeze"]:
            if active.has_condition(cond):
                make_status_badge(status_frame, cond).pack(side="left", padx=(0, 2))

        for stat in STAT_NAMES:
            mult = active.get_stat_multiplier(stat)
            if mult != 1.0:
                text = stat_stage_text(mult)
                if text:
                    stat_color = NEON_GREEN if mult > 1.0 else NEON_RED
                    tk.Label(status_frame, text=f"{text} {STAT_LABELS.get(stat, stat)}",
                             font=("Consolas", 8, "bold"), fg=stat_color,
                             bg=BG_PANEL).pack(side="left", padx=(4, 0))

        # Sync stat spinbox values from current state
        for stat in STAT_NAMES:
            var = getattr(self, f"_stat_var_{stat}_{side}", None)
            if var and active:
                mult = active.get_stat_multiplier(stat)
                # Convert multiplier to stage
                if mult >= 4.0: stages = 6
                elif mult >= 3.0: stages = 5
                elif mult >= 2.5: stages = 4
                elif mult >= 2.0: stages = 3
                elif mult >= 1.5: stages = 2
                elif mult >= 1.0: stages = 0
                elif mult >= 0.66: stages = -1
                elif mult >= 0.5: stages = -2
                elif mult >= 0.4: stages = -3
                elif mult >= 0.33: stages = -4
                elif mult >= 0.29: stages = -5
                else: stages = -6
                var.set(str(stages))

        # Sync status combobox
        status_var = getattr(self, f"_status_var_{side}", None)
        if status_var and active:
            current_status = "none"
            for c in ["burn", "poison", "toxic", "sleep", "paralysis", "freeze"]:
                if active.has_condition(c):
                    current_status = c
                    break
            status_var.set(current_status)

        # Update queued switch label in active panel
        lbl = getattr(self, f"_queued_switch_{side}", None)
        if lbl:
            if side == "a" and self._queued_action_a and self._queued_action_a["type"] == "switch":
                set_obj = self.kg.get_set(self._queued_action_a["id"])
                pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
                name = pkmn.name if pkmn else self._queued_action_a["id"]
                lbl.configure(text=f"→ Switch to: {name}", fg=NEON_CYAN)
            else:
                lbl.configure(text="")

        # Refresh moves for this side
        self._refresh_moves(side)

    def _refresh_moves(self, side: str):
        """Refresh move buttons for the active Pokemon of a given side.

        Shows move name, type, category symbol, power, and damage range (vs opponent).
        """
        buttons: list = getattr(self, f"_move_btns_{side}", [])
        for btn in buttons:
            btn.configure(text="—", bg=BG_CARD, fg=FG_DIM,
                          highlightbackground=FG_DIM, highlightthickness=1)

        if not self._current_state:
            return

        active = self._current_state.get_active_pokemon(side)
        if not active:
            return

        set_obj = self.kg.get_set(active.set_id)
        if not set_obj:
            return

        # Get opponent info for damage ranges
        opp_side = "b" if side == "a" else "a"
        opponent = self._current_state.get_active_pokemon(opp_side)
        opponent_set = self.kg.get_set(opponent.set_id) if opponent else None

        moves = list(set_obj.moves)[:4]
        for i, btn in enumerate(buttons):
            if i < len(moves):
                move_id = moves[i]
                move = self.kg.get_move(move_id)
                move_name = move.name if move else move_id
                move_type = getattr(move, "type", "Normal") if move else "Normal"
                category = getattr(move, "category", "Physical") if move else "Physical"
                power = getattr(move, "base_power", 0) if move else 0

                type_color = TYPE_COLORS.get(move_type, FG_DIM)
                sym = CATEGORY_SYMBOLS.get(category, "⚔")

                # Compute damage range vs opponent
                dmg_range = ""
                if opponent and opponent_set and move and not move.is_status and power and power > 0:
                    try:
                        calc = getattr(self._battle_sim, "calc", None)
                        if calc:
                            result = calc.calculate_with_state(
                                set_obj, opponent_set, move, self.kg,
                                attacker_state=active,
                                defender_state=opponent,
                                field_state=self._current_state.field,
                                level=100,
                            )
                            if result.is_immune:
                                dmg_range = "IMMUNE"
                            elif result.is_ohko:
                                dmg_range = "OHKO"
                            else:
                                dmg_range = result.damage_range_str
                    except Exception:
                        dmg_range = ""

                # Build button text
                text = f"{sym} {move_name}"
                if power and power > 0:
                    text += f" ({power})"
                if dmg_range:
                    text += f"\n{dmg_range}"
                text += f"\n[{move_type}]"

                btn.configure(
                    text=text,
                    fg=FG_PRIMARY,
                    bg=BG_CARD,
                    highlightbackground=type_color,
                    highlightthickness=2,
                )
            else:
                btn.configure(text="—", bg=BG_CARD, fg=FG_DIM,
                              highlightbackground=FG_DIM, highlightthickness=1)

    def _refresh_all(self):
        """Full refresh of all displays."""
        if not self._current_state:
            return

        for side in ("a", "b"):
            self._refresh_team_list(side)
            self._refresh_active_panel(side)

        # Refresh queued action display
        self._update_queued_display()

    # ── Action Handling ───────────────────────────────────────────────────────

    def _on_move_click(self, move_index: int, side: str):
        """Handle move button click — queue the move for that side."""
        if side != "a":
            return  # Only player controls Team A
        if self._phase != "simulation":
            return
        if not self._current_state:
            return

        active = self._current_state.get_active_pokemon("a")
        if not active:
            return

        set_obj = self.kg.get_set(active.set_id)
        if not set_obj or move_index >= len(set_obj.moves):
            return

        move_id = set_obj.moves[move_index]
        move = self.kg.get_move(move_id)
        move_name = move.name if move else move_id

        self._queued_action_a = {"type": "move", "id": move_id, "index": move_index}
        self._add_log(f"Queued move: {move_name}")

        # Auto-queue AI action for B when player queues
        if self._queued_action_b is None:
            self._queue_ai_action("b")

        self._update_queued_display()
        self._update_next_turn_button()
        self._refresh_active_panel("a")

    def _on_bench_click(self, side: str, bench_index: int):
        """Handle bench slot click — queue switch for Team A."""
        if side != "a":
            return
        if self._phase != "simulation":
            return
        if not self._current_state:
            return

        team = self._current_state.team_a
        if bench_index >= len(team):
            return

        target = team[bench_index]
        if target.is_fainted or target.is_active:
            return

        set_obj = self.kg.get_set(target.set_id)
        pokemon = self.kg.get_pokemon(target.pokemon_id) if set_obj else None
        name = pokemon.name if pokemon else target.pokemon_id

        self._queued_action_a = {"type": "switch", "id": target.set_id, "index": bench_index}
        self._add_log(f"Queued switch: {name}")

        # Auto-queue AI action for B when player queues
        if self._queued_action_b is None:
            self._queue_ai_action("b")

        self._update_queued_display()
        self._update_next_turn_button()
        self._refresh_active_panel("a")

    def _update_queued_display(self):
        """Update the queued action label in center panel (shows both sides)."""
        if not self._queued_lbl:
            return

        # Format action for one side
        def format_action(action, side_color):
            if not action:
                return "Waiting..."
            if action["type"] == "move":
                move = self.kg.get_move(action["id"])
                move_name = move.name if move else action["id"]
                move_type = getattr(move, "type", "") if move else ""
                category = getattr(move, "category", "") if move else ""
                type_color = TYPE_COLORS.get(move_type, FG_DIM)
                return f"⚔ {move_name} [{move_type}]"
            else:
                set_obj = self.kg.get_set(action["id"])
                pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
                return f"↔ {pkmn.name if pkmn else action['id']}"

        a_text = format_action(self._queued_action_a, NEON_CYAN)
        b_text = format_action(self._queued_action_b, NEON_PINK)

        # Color based on whether both are ready
        both_ready = self._queued_action_a is not None and self._queued_action_b is not None
        color = NEON_GREEN if both_ready else NEON_YELLOW

        self._queued_lbl.configure(
            text=f"A: {a_text}  |  B: {b_text}",
            fg=color,
        )

    # ── Condition Change Handlers ─────────────────────────────────────────────

    def _on_weather_change(self, value: str):
        self._weather_var = tk.StringVar(value=value)
        if self._current_state:
            self._add_log(f"Weather set to: {value}")

    def _on_terrain_change(self, value: str):
        self._terrain_var = tk.StringVar(value=value)
        if self._current_state:
            self._add_log(f"Terrain set to: {value}")

    def _on_trick_room_toggle(self):
        current = self._trick_room_var.get()
        self._trick_room_var.set(not current)
        if self._trick_room_btn:
            if not current:
                self._trick_room_btn.configure(text="ON", bg=NEON_GREEN, fg=BG_DARK)
            else:
                self._trick_room_btn.configure(text="OFF", bg=BG_CARD, fg=FG_DIM)
        if self._current_state:
            self._add_log(f"Trick Room: {'ON' if not current else 'OFF'}")

    def _on_spikes_change(self, side: str, value: str):
        var = getattr(self, f"_spikes_{side}_var", None)
        if var is None:
            var = tk.StringVar(value=value)
            setattr(self, f"_spikes_{side}_var", var)
        else:
            var.set(value)
        if self._current_state:
            self._add_log(f"Side {'A' if side == 'a' else 'B'} Spikes: {value}")

    def _on_toxic_spikes_change(self, side: str, value: str):
        var = getattr(self, f"_toxic_spikes_{side}_var", None)
        if var is None:
            var = tk.StringVar(value=value)
            setattr(self, f"_toxic_spikes_{side}_var", var)
        else:
            var.set(value)
        if self._current_state:
            self._add_log(f"Side {'A' if side == 'a' else 'B'} Toxic Spikes: {value}")

    def _on_sr_toggle_setup(self, side: str, key: str):
        """Handle Stealth Rock toggle in setup phase (no battle state needed)."""
        var = getattr(self, f"_sr_{side}_var", None)
        if var is None:
            var = tk.BooleanVar(value=False)
            setattr(self, f"_sr_{side}_var", var)
        else:
            var.set(not var.get())

    def _on_sr_toggle(self, side: str, key: str):
        if self._current_state:
            var = getattr(self, f"_sr_{side}_var", None)
            self._add_log(f"Stealth Rock {'ON' if var and var.get() else 'OFF'}")

    def _on_web_toggle(self, side: str, key: str):
        if self._current_state:
            var = getattr(self, f"_web_{side}_var", None)
            self._add_log(f"Sticky Web {'ON' if var and var.get() else 'OFF'}")

    def _on_screen_toggle(self, side: str, key: str):
        if self._current_state:
            var = getattr(self, f"_{key}_{side}_var", None)
            self._add_log(f"{key} {'ON' if var and var.get() else 'OFF'}")

    def _on_status_change(self, side: str, var: tk.StringVar):
        """Handle status condition dropdown change."""
        if not self._current_state:
            return
        active = self._current_state.get_active_pokemon(side)
        if not active:
            return
        val = var.get()
        if val == "none":
            active.clear_status()
        else:
            active.apply_status(val)
        self._refresh_active_panel(side)
        self._refresh_team_list(side)

    def _on_stat_change(self, side: str, stat: str, var: tk.StringVar):
        """Handle stat stage spinbox change."""
        if not self._current_state:
            return
        active = self._current_state.get_active_pokemon(side)
        if not active:
            return
        try:
            stages = int(var.get())
            stages = max(-6, min(6, stages))
            # Remove existing stat mod for this stat
            to_remove = [a for a in active.attributes
                         if getattr(a, "name", "").startswith(stat + "_")]
            for a in to_remove:
                active.attributes.remove(a)
            if stages != 0:
                from pokeredus.classes.attributes import Attribute
                attr = Attribute(
                    attribute_type="stat_mod",
                    name=f"{stat}_{stages:+d}",
                    source="manual",
                    params={"stat": stat, "stages": stages},
                    tags=["stat_mod", stat],
                )
                active.attributes.add(attr)
        except ValueError:
            pass
        self._refresh_active_panel(side)

    # ── Battle Controls ────────────────────────────────────────────────────────

    def _on_reset(self):
        """Reset battle to setup phase (keeps team sets for re-battling)."""
        self._stop_autoplay()
        self._current_state = None
        self._engine = None
        self._history.clear()
        self._queued_action_a = None
        self._queued_action_b = None
        self._turn_var.set("Turn: 0")
        self._log_entries.clear()

        # Transition back to setup phase
        self._phase = "setup"

        # Rebuild UI as setup layout
        self._build_main_body()
        # Refresh setup slots with current teams
        for side in ("a", "b"):
            if hasattr(self, f"_refresh_setup_slots"):
                self._refresh_setup_slots(side)
        self._update_start_battle_state()

        # Clear log display
        if hasattr(self, "_log_inner"):
            for w in self._log_inner.winfo_children():
                w.destroy()
        self._add_log("Battle reset — back to setup.")

    def _on_undo(self):
        """Restore previous battle state."""
        if not self._history:
            self._add_log("Nothing to undo.")
            return

        self._current_state = self._history.pop()
        turn = self._current_state.turn
        self._turn_var.set(f"Turn: {turn}")
        self._queued_action_a = None
        self._queued_action_b = None
        self._update_queued_display()
        self._update_next_turn_button()
        self._refresh_all()
        self._add_log(f"Undid to turn {turn}.")

        # Disable undo button if history is now empty
        if not self._history:
            self._btn_undo.configure(state="disabled")

    def _queue_ai_action(self, side: str):
        """Pick and queue an AI action for the given side (does not execute)."""
        if not self._current_state:
            return

        team = (self._current_state.team_a if side == "a"
                else self._current_state.team_b)
        active = self._current_state.get_active_pokemon(side)
        if not active:
            return

        set_obj = self.kg.get_set(active.set_id)
        if not set_obj:
            return

        moves = list(set_obj.moves)[:4]
        # Check for fainted bench (can switch)
        fainted_bench = [i for i, p in enumerate(team)
                         if p.is_fainted and not p.is_active]
        can_switch = bool(fainted_bench)

        import random
        if moves and (not can_switch or random.random() > 0.2):
            # Use a random move
            move_id = random.choice(moves)
            move = self.kg.get_move(move_id)
            move_name = move.name if move else move_id
            self._add_log(f"AI queued: {move_name}")
            if side == "a":
                self._queued_action_a = {"type": "move", "id": move_id}
            else:
                self._queued_action_b = {"type": "move", "id": move_id}
        elif can_switch:
            # Switch to random non-fainted bench
            healthy_bench = [i for i, p in enumerate(team)
                             if not p.is_fainted and not p.is_active]
            if healthy_bench:
                idx = random.choice(healthy_bench)
                target = team[idx]
                set_o = self.kg.get_set(target.set_id)
                pkmn = self.kg.get_pokemon(set_o.pokemon_id) if set_o else None
                name = pkmn.name if pkmn else target.set_id
                self._add_log(f"AI queued switch: {name}")
                if side == "a":
                    self._queued_action_a = {"type": "switch", "id": target.set_id, "index": idx}
                else:
                    self._queued_action_b = {"type": "switch", "id": target.set_id, "index": idx}

    def _update_next_turn_button(self):
        """Enable/disable Next Turn button based on whether both actions are queued."""
        both_ready = (
            self._queued_action_a is not None and
            self._queued_action_b is not None
        )
        for btn_attr in ("_btn_step", "_center_step_btn"):
            btn = getattr(self, btn_attr, None)
            if btn:
                btn.configure(
                    state="normal" if both_ready else "disabled",
                    fg=NEON_GREEN if both_ready else FG_DIM,
                )

    def _on_step(self):
        """Execute one battle turn (requires both actions to be queued)."""
        if self._phase != "simulation" or not self._current_state:
            return

        # Require both actions to be queued
        if self._queued_action_a is None or self._queued_action_b is None:
            messagebox.showinfo("Actions Required",
                                "Select an action for your Pokemon before proceeding.\n"
                                "Click a move or a bench Pokemon to switch.")
            return

        # Save state for undo BEFORE executing turn
        self._history.append(self._current_state.clone())
        self._btn_undo.configure(state="normal")

        # Increment turn
        turn = self._current_state.turn + 1
        self._add_log(f"=== Turn {turn} ===")

        # Execute both queued actions
        self._execute_action("a", self._queued_action_a)
        self._execute_action("b", self._queued_action_b)

        # Apply end-of-turn: entry hazards, tick state
        self._apply_entry_hazards()
        expired = self._current_state.tick()

        for pkmn_id in expired:
            self._add_log(f"  {pkmn_id} was damaged by status!")

        # Check faints
        for side in ("a", "b"):
            team = (self._current_state.team_a if side == "a"
                    else self._current_state.team_b)
            for p in team:
                if p.is_fainted and not getattr(p, "_logged_faint", False):
                    setattr(p, "_logged_faint", True)
                    pkmn = self.kg.get_pokemon(p.pokemon_id) if p.pokemon_id else None
                    self._add_log(f"  {pkmn.name if pkmn else p.pokemon_id} fainted!")

        # Update turn counter
        self._current_state.turn = turn
        self._turn_var.set(f"Turn: {turn}")

        # Clear BOTH queued actions
        self._queued_action_a = None
        self._queued_action_b = None
        self._update_queued_display()
        self._update_next_turn_button()

        # Refresh all displays
        self._refresh_all()

        # Check battle end
        self._check_battle_end()

    def _execute_action(self, side: str, action: dict):
        """Execute a queued or AI action."""
        if action["type"] == "move":
            move_id = action["id"]
            move = self.kg.get_move(move_id)
            move_name = move.name if move else move_id
            active = self._current_state.get_active_pokemon(side)
            opponent_side = "b" if side == "a" else "a"
            opponent = self._current_state.get_active_pokemon(opponent_side)

            if active and opponent:
                damage = 0
                if hasattr(self._battle_sim, "calc"):
                    damage = self._battle_sim.calc.calculate_simple_damage(
                        move_id, active, opponent, self.kg,
                    )

                actual = opponent.take_damage(damage)
                self._add_log(
                    f"  {active.pokemon_id} used {move_name} → "
                    f"{opponent.pokemon_id} took {actual} damage"
                )

                if opponent.is_fainted:
                    self._add_log(f"  {opponent.pokemon_id} fainted!")

        elif action["type"] == "switch":
            idx = action["index"]
            set_obj = self.kg.get_set(action["id"])
            pkmn = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
            name = pkmn.name if pkmn else action["id"]
            success = self._current_state.switch_pokemon(side, idx)
            if success:
                self._add_log(f"  Team {'A' if side == 'a' else 'B'} switched to {name}")
                # Apply entry hazards on switch-in
                self._apply_entry_hazards_to_side(side)

    def _do_ai_action(self, side: str):
        """Pick a random legal action for the AI (side B)."""
        if not self._current_state:
            return

        team = (self._current_state.team_a if side == "a"
                else self._current_state.team_b)
        active = self._current_state.get_active_pokemon(side)
        if not active:
            return

        set_obj = self.kg.get_set(active.set_id)
        if not set_obj:
            return

        moves = list(set_obj.moves)[:4]
        # Check for fainted bench
        fainted_bench = [i for i, p in enumerate(team)
                         if p.is_fainted and not p.is_active]
        can_switch = bool(fainted_bench)

        import random
        if moves and (not can_switch or random.random() > 0.2):
            # Use a random move
            move_id = random.choice(moves)
            move = self.kg.get_move(move_id)
            self._execute_action(side, {"type": "move", "id": move_id})
        elif can_switch:
            # Switch to random non-fainted bench
            healthy_bench = [i for i, p in enumerate(team)
                             if not p.is_fainted and not p.is_active]
            if healthy_bench:
                idx = random.choice(healthy_bench)
                target = team[idx]
                self._execute_action(side, {"type": "switch",
                                            "id": target.set_id, "index": idx})

    def _apply_entry_hazards(self):
        """Apply entry hazards for both sides on switch-in."""
        for side in ("a", "b"):
            self._apply_entry_hazards_to_side(side)

    def _apply_entry_hazards_to_side(self, side: str):
        """Apply entry hazards when a Pokemon switches in on a side."""
        if not self._current_state:
            return

        active = self._current_state.get_active_pokemon(side)
        if not active:
            return

        opponent_side = "b" if side == "a" else "a"
        side_attrs = self._current_state.field.get_side_attributes(opponent_side)

        # Check for spikes
        spikes_count = sum(
            1 for attr in side_attrs
            if getattr(attr, "field", "") == "spikes"
        )
        if spikes_count > 0:
            # 12.5% * layers, max 50%
            hazard_damage = int(active.max_hp * min(0.125 * spikes_count, 0.5))
            if hazard_damage > 0:
                actual = active.take_damage(hazard_damage)
                pkmn = self.kg.get_pokemon(active.pokemon_id) if active.pokemon_id else None
                self._add_log(f"  {pkmn.name if pkmn else active.pokemon_id} hit by Spikes: -{actual} HP")

        # Check for stealth rock
        has_sr = any(
            getattr(attr, "field", "") == "stealth_rock"
            for attr in side_attrs
        )
        if has_sr:
            # Stealth Rock: 12.5% max HP
            sr_damage = int(active.max_hp * 0.125)
            if sr_damage > 0:
                actual = active.take_damage(sr_damage)
                pkmn = self.kg.get_pokemon(active.pokemon_id) if active.pokemon_id else None
                self._add_log(f"  {pkmn.name if pkmn else active.pokemon_id} hit by Stealth Rock: -{actual} HP")

        # Check for toxic spikes (poison types immune)
        toxic_count = sum(
            1 for attr in side_attrs
            if getattr(attr, "field", "") == "toxic_spikes"
        )
        if toxic_count > 0 and not active.has_condition("poison") and not active.has_condition("toxic"):
            pkmn = self.kg.get_pokemon(active.pokemon_id) if active.pokemon_id else None
            types = getattr(pkmn, "types", []) if pkmn else []
            if "Poison" not in types and "Steel" not in types:
                if toxic_count >= 2:
                    # Badly poisoned
                    if not active.has_condition("toxic"):
                        self._add_log(f"  {pkmn.name if pkmn else active.pokemon_id} badly poisoned by Toxic Spikes!")
                elif toxic_count >= 1:
                    if not active.has_condition("poison"):
                        self._add_log(f"  {pkmn.name if pkmn else active.pokemon_id} poisoned by Toxic Spikes!")

        # Check for sticky web (lowers speed)
        # (Speed drop applied via stat modifier — simplified here)

    def _on_toggle_autoplay(self):
        """Toggle auto-play mode."""
        if self._auto_play_on:
            self._stop_autoplay()
        else:
            self._start_autoplay()

    def _start_autoplay(self):
        """Start auto-play mode."""
        self._auto_play_on = True
        if hasattr(self, "_center_autoplay_btn"):
            self._center_autoplay_btn.configure(text="⏸ Stop Auto-Play", fg=NEON_RED)
        if hasattr(self, "_btn_autoplay"):
            self._btn_autoplay.configure(text="⏸ Stop Auto-Play", fg=NEON_RED)
        self._auto_play_loop()

    def _stop_autoplay(self):
        """Stop auto-play mode."""
        self._auto_play_on = False
        if self._auto_play_job:
            try:
                self.after_cancel(self._auto_play_job)
            except Exception:
                pass
            self._auto_play_job = None
        if hasattr(self, "_center_autoplay_btn"):
            self._center_autoplay_btn.configure(text="⏵ Auto-Play", fg=NEON_CYAN)
        if hasattr(self, "_btn_autoplay"):
            self._btn_autoplay.configure(text="⏵ Auto-Play", fg=NEON_CYAN)

    def _auto_play_loop(self):
        """Auto-play loop: step the battle and reschedule."""
        if not self._auto_play_on:
            return
        self._on_step()
        if self._auto_play_on:
            self._auto_play_job = self.after(800, self._auto_play_loop)

    # ── Engine Helpers ────────────────────────────────────────────────────────

    def _init_engine(self):
        """Lazily initialize the probabilistic engine."""
        try:
            from pokeredus.graph.probabilistic_engine import ProbabilisticEngine
            from pokeredus.graph.matchup_cache_provider import CachedMatchupProvider

            self._engine = ProbabilisticEngine(
                self.kg, self._battle_sim, num_rollouts=30,
            )

            if self.matchup_cache and self.matchup_cache.size > 0:
                provider = CachedMatchupProvider(self.matchup_cache)
                self._engine.set_cache_provider(provider)
        except Exception as e:
            messagebox.showerror("Engine Error",
                                 f"Could not initialize simulation engine: {e}")
            self._engine = None

    def _create_battle_state(self):
        """Create initial GameState from imported teams."""
        if self._engine is None:
            self._init_engine()
        if self._engine is None:
            return

        try:
            self._current_state = self._engine.create_state_from_sets(
                self._team_a_sets, self._team_b_sets,
            )
            self._apply_field_conditions_to_state()
            self._turn_var.set("Turn: 0")

            # Initial display refresh
            for side in ("a", "b"):
                self._refresh_team_list(side)
                self._refresh_active_panel(side)
            self.notify_scene_change()
        except Exception as e:
            messagebox.showerror("State Error", f"Failed to create battle state: {e}")

    def _apply_field_conditions_to_state(self):
        """Apply current UI field conditions to the game state."""
        if not self._current_state:
            return

        trick_room_var = getattr(self, "_trick_room_var", None)
        if trick_room_var:
            self._current_state.trick_room = trick_room_var.get()

        weather = getattr(self, "_weather_var", None)
        terrain = getattr(self, "_terrain_var", None)

        if weather and weather.get() and weather.get() != "None":
            try:
                from pokeredus.classes.attributes import FieldAttribute
                attr = FieldAttribute(field=weather.get(), attribute_type="field")
                self._current_state.field.global_attributes.add(attr)
            except Exception:
                pass

        if terrain and terrain.get() and terrain.get() != "None":
            try:
                from pokeredus.classes.attributes import FieldAttribute
                attr = FieldAttribute(field=terrain.get(), attribute_type="field")
                self._current_state.field.global_attributes.add(attr)
            except Exception:
                pass

        # Side conditions
        for side in ("a", "b"):
            spikes_var = getattr(self, f"_spikes_{side}_var", None)
            if spikes_var:
                layers = int(spikes_var.get())
                for _ in range(layers):
                    try:
                        from pokeredus.classes.attributes import FieldAttribute
                        attr = FieldAttribute(field="spikes", attribute_type="field")
                        self._current_state.field.get_side_attributes(side).add(attr)
                    except Exception:
                        pass

            sr_var = getattr(self, f"_sr_{side}_var", None)
            if sr_var and sr_var.get():
                try:
                    from pokeredus.classes.attributes import FieldAttribute
                    attr = FieldAttribute(field="stealth_rock", attribute_type="field")
                    self._current_state.field.get_side_attributes(side).add(attr)
                except Exception:
                    pass

            tp_var = getattr(self, f"_toxic_spikes_{side}_var", None)
            if tp_var:
                layers = int(tp_var.get())
                for _ in range(layers):
                    try:
                        from pokeredus.classes.attributes import FieldAttribute
                        attr = FieldAttribute(field="toxic_spikes", attribute_type="field")
                        self._current_state.field.get_side_attributes(side).add(attr)
                    except Exception:
                        pass

            web_var = getattr(self, f"_web_{side}_var", None)
            if web_var and web_var.get():
                try:
                    from pokeredus.classes.attributes import FieldAttribute
                    attr = FieldAttribute(field="sticky_web", attribute_type="field")
                    self._current_state.field.get_side_attributes(side).add(attr)
                except Exception:
                    pass

            for screen_key in ("reflect", "ls", "veil"):
                var = getattr(self, f"_{screen_key}_{side}_var", None)
                if var and var.get():
                    field_name = {"reflect": "reflect", "ls": "light_screen", "veil": "aurora_veil"}[screen_key]
                    try:
                        from pokeredus.classes.attributes import FieldAttribute
                        attr = FieldAttribute(field=field_name, attribute_type="field")
                        self._current_state.field.get_side_attributes(side).add(attr)
                    except Exception:
                        pass

    def _check_battle_end(self):
        """Check if battle has ended and log the result."""
        if not self._current_state:
            return

        alive_a = sum(1 for p in self._current_state.team_a if not p.is_fainted)
        alive_b = sum(1 for p in self._current_state.team_b if not p.is_fainted)

        if alive_a == 0:
            self._add_log("Battle over! Team B wins!")
            self._stop_autoplay()
        elif alive_b == 0:
            self._add_log("Battle over! Team A wins!")
            self._stop_autoplay()

    # ── Battle Log ───────────────────────────────────────────────────────────

    def _add_log(self, message: str):
        """Add an entry to the battle log."""
        self._log_entries.append(message)

        turn_prefix = ""
        if self._current_state:
            turn_prefix = f"[T{self._current_state.turn}] "

        entry = tk.Label(
            self._log_inner, text=f"{turn_prefix}{message}",
            font=FONT_SMALL, fg=FG_PRIMARY, bg=BG_DARK,
            anchor="w", justify="left",
        )
        entry.pack(fill="x", padx=4, pady=1)

        self._log_inner.update_idletasks()
        self._log_canvas.yview_moveto(1.0)

    # ── Unified-shell hook ────────────────────────────────────────────────
    # Notify the surrounding shell (UnifiedAppShell) whenever the live
    # game state changes so the sidebar Optimal-Action panel can refresh.
    def notify_scene_change(self) -> None:
        if not self._on_scene_change or self._current_state is None:
            return
        try:
            from pokeredus.unified import UnifiedState
            unified = UnifiedState.from_game_state(self._current_state)
            self._on_scene_change(unified)
        except Exception:
            # Best-effort: never break the simulator over a sidebar update.
            pass