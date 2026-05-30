"""
Team Builder — 6-slot team construction panel with save/load/export.

Layout:
  - Top bar: back button, team name, save/load/export controls
  - Left half (~50%): 2x3 grid of team slot cards
  - Right half (~50%): placeholder for future team analysis

Each slot card shows: sprite, name, set, type badges, role, key info.
Empty slots show a "+" button that opens the Pokemon/Set selector dialog.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk, messagebox
from typing import TYPE_CHECKING

from pokeredus.gui.theme import *
from pokeredus.graph.analytics import compute_set_stats
from pokeredus.config import STAT_NAMES
from pokeredus.gui.sprites import get_sprite_manager, SpriteManager
from pokeredus.gui.team_store import TeamStore, TeamRecord
from PIL import ImageTk

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.classes import PokemonClass, SetClass


# ═══════════════════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════════════════

TEAM_SIZE = 6
SLOT_ROWS = 3
SLOT_COLS = 2


# ═══════════════════════════════════════════════════════════════════════
# POKEMON/SET SELECTOR DIALOG
# ═══════════════════════════════════════════════════════════════════════

class PokemonSetSelectorDialog(tk.Toplevel):
    """Modal dialog for selecting a Pokemon + set combo for a team slot."""

    def __init__(self, parent, kg: KnowledgeGraph, slot_index: int,
                 existing_set_id: str | None = None):
        super().__init__(parent)
        self.kg = kg
        self.slot_index = slot_index
        self.result: str | None = None  # selected set_id
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []

        title = f"Select Pokemon for Slot {slot_index + 1}"
        self.title(title)
        self.configure(bg=BG_DARK)
        self.geometry("700x600")
        self.transient(parent)
        self.grab_set()

        self._build_ui(existing_set_id)

    def _build_ui(self, existing_set_id: str | None):
        # ── Search bar ──────────────────────────────────────────────
        search_frame = tk.Frame(self, bg=BG_PANEL, height=48)
        search_frame.pack(fill="x")
        search_frame.pack_propagate(False)

        tk.Label(search_frame, text="Search:", font=FONT_BODY,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left", padx=(12, 4), pady=10)

        self._search_var = tk.StringVar()
        self._search_var.trace_add("write", lambda *_: self._filter_list())
        entry = tk.Entry(search_frame, textvariable=self._search_var,
                         font=FONT_BODY, bg=BG_INPUT, fg=FG_PRIMARY,
                         insertbackground=FG_PRIMARY, relief="flat", width=30)
        entry.pack(side="left", padx=4, pady=10, ipady=4)

        # Type filter
        tk.Label(search_frame, text="Type:", font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left", padx=(12, 4))
        self._type_var = tk.StringVar(value="All")
        ttk.Combobox(search_frame, textvariable=self._type_var,
                     values=["All"] + list(TYPE_COLORS.keys()),
                     state="readonly", width=10,
                     font=FONT_SMALL).pack(side="left", padx=4)
        self._type_var.trace_add("write", lambda *_: self._filter_list())

        # ── Split: Pokemon list (left) | Set list (right) ───────────
        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True, padx=8, pady=8)

        # Pokemon list (left)
        left = tk.Frame(body, bg=BG_PANEL, width=300)
        left.pack(side="left", fill="both", padx=(0, 4))
        left.pack_propagate(False)

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

        # Set list (right)
        right = tk.Frame(body, bg=BG_PANEL, width=340)
        right.pack(side="right", fill="both", padx=(4, 0))
        right.pack_propagate(False)

        self._set_header = tk.Label(right, text="Select a Pokemon",
                                     font=FONT_HEADING, fg=FG_DIM,
                                     bg=BG_PANEL)
        self._set_header.pack(anchor="w", padx=10, pady=(8, 4))

        self._set_frame = tk.Frame(right, bg=BG_PANEL)
        self._set_frame.pack(fill="both", expand=True, padx=10, pady=(0, 8))

        # Confirm button
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

        # State
        self._pokemon_widgets: dict[str, tk.Frame] = {}
        self._selected_pokemon_id: str | None = None
        self._selected_set_id: str | None = existing_set_id

        self._load_pokemon_list()

    def _load_pokemon_list(self):
        pokemon = sorted(self.kg.get_all_pokemon(), key=lambda p: p.name)
        for p in pokemon:
            self._add_pokemon_row(p)

    def _add_pokemon_row(self, pokemon: PokemonClass):
        frame = tk.Frame(self._list_inner, bg=BG_CARD, cursor="hand2", height=44)
        frame.pack(fill="x", padx=2, pady=1)
        frame.pack_propagate(False)

        # Sprite
        api = pokemon.api_name or pokemon.id
        sprite = self._sprite_mgr.get_sprite(api, (36, 36))
        if sprite:
            sp = tk.Label(frame, image=sprite, bg=BG_CARD)
            sp.image = sprite
            sp.pack(side="left", padx=(6, 4), pady=4)
            self._photo_refs.append(sprite)
        else:
            tk.Label(frame, text="?", font=FONT_SMALL, fg=FG_DIM,
                     bg=BG_CARD, width=3).pack(side="left", padx=(6, 4))

        # Info
        info = tk.Frame(frame, bg=BG_CARD)
        info.pack(side="left", fill="both", expand=True, padx=4)

        tk.Label(info, text=pokemon.name, font=("Consolas", 11, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(anchor="w")

        type_row = tk.Frame(info, bg=BG_CARD)
        type_row.pack(anchor="w")
        for t in pokemon.types:
            tc = TYPE_COLORS.get(t, FG_DIM)
            tk.Label(type_row, text=f" {t} ", font=("Consolas", 7, "bold"),
                     fg=BG_DARK, bg=tc, padx=3, pady=0).pack(side="left", padx=(0, 2))

        # Set count badge
        sets_count = len(self.kg.get_sets(pokemon.id))
        tk.Label(frame, text=str(sets_count), font=("Consolas", 8, "bold"),
                 fg=BG_DARK, bg=NEON_CYAN, padx=3, pady=0).pack(
            side="right", padx=6)

        self._pokemon_widgets[pokemon.id] = frame

        # Click
        all_w = [frame, info, sp if sprite else None, type_row] + type_row.winfo_children()
        all_w = [w for w in all_w if w is not None]
        for w in all_w:
            w.bind("<Button-1>", lambda e, pid=pokemon.id: self._select_pokemon(pid))
            w.bind("<Enter>", lambda e, f=frame: self._hover(f, BG_HOVER))
            w.bind("<Leave>", lambda e, f=frame: self._hover(f, BG_CARD))

    def _hover(self, frame, color):
        try:
            frame.config(bg=color)
            for c in frame.winfo_children():
                try:
                    c.config(bg=color)
                except tk.TclError:
                    pass
        except tk.TclError:
            pass

    def _select_pokemon(self, pokemon_id: str):
        self._selected_pokemon_id = pokemon_id
        pokemon = self.kg.get_pokemon(pokemon_id)
        if not pokemon:
            return

        # Highlight selected
        for pid, frame in self._pokemon_widgets.items():
            frame.config(bg=BG_SELECTED if pid == pokemon_id else BG_CARD)

        # Populate set list
        for w in self._set_frame.winfo_children():
            w.destroy()

        self._set_header.config(text=pokemon.name)

        sets = self.kg.get_sets(pokemon_id)
        if not sets:
            tk.Label(self._set_frame, text="No sets available",
                     font=FONT_BODY, fg=FG_DIM, bg=BG_PANEL).pack(pady=20)
            return

        self._set_widgets: dict[str, tk.Frame] = {}
        for s in sets:
            self._add_set_row(pokemon, s)

    def _add_set_row(self, pokemon: PokemonClass, set_obj):
        frame = tk.Frame(self._set_frame, bg=BG_CARD, cursor="hand2", padx=8, pady=6)
        frame.pack(fill="x", padx=2, pady=2)

        # Set name + role
        top = tk.Frame(frame, bg=BG_CARD)
        top.pack(fill="x")

        tk.Label(top, text=set_obj.set_name, font=("Consolas", 11, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(side="left")

        rc = ROLE_COLORS.get(set_obj.role, FG_DIM)
        tk.Label(top, text=f" {set_obj.role} ", font=("Consolas", 8),
                 fg=BG_DARK, bg=rc, padx=4, pady=1).pack(side="left", padx=(6, 0))

        # Key info
        item = self.kg.get_item(set_obj.item)
        ability = self.kg.get_ability(set_obj.ability)
        info_text = (f"{item.name if item else set_obj.item}  ·  "
                     f"{ability.name if ability else set_obj.ability}  ·  "
                     f"{set_obj.nature.name}")
        tk.Label(frame, text=info_text, font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_CARD).pack(anchor="w", pady=(2, 0))

        # Moves
        mf = tk.Frame(frame, bg=BG_CARD)
        mf.pack(anchor="w", pady=(2, 0))
        for mid in set_obj.moves:
            move = self.kg.get_move(mid)
            name = move.name if move else mid
            bp = f" ({move.base_power})" if move and move.base_power > 0 else ""
            mc = NEON_CYAN if move and move.is_status else FG_PRIMARY
            tk.Label(mf, text=f"{name}{bp}", font=("Consolas", 8),
                     fg=mc, bg=BG_INPUT, padx=4, pady=1).pack(side="left", padx=(0, 3))

        self._set_widgets[set_obj.id] = frame

        # Click bindings
        all_w = [frame, top, mf] + top.winfo_children() + mf.winfo_children()
        for w in all_w:
            w.bind("<Button-1>", lambda e, sid=set_obj.id: self._select_set(sid))
            w.bind("<Enter>", lambda e, f=frame: f.config(bg=BG_HOVER))
            w.bind("<Leave>", lambda e, f=frame, sid=set_obj.id: f.config(
                bg=BG_SELECTED if sid == self._selected_set_id else BG_CARD))

    def _select_set(self, set_id: str):
        self._selected_set_id = set_id
        for sid, frame in self._set_widgets.items():
            frame.config(bg=BG_SELECTED if sid == set_id else BG_CARD)
        self._confirm_btn.config(state="normal")

    def _filter_list(self):
        query = self._search_var.get().strip().lower()
        type_filter = self._type_var.get()

        for pid, frame in self._pokemon_widgets.items():
            p = self.kg.get_pokemon(pid)
            if not p:
                continue
            visible = True
            if query and query not in p.name.lower():
                visible = False
            if type_filter != "All" and type_filter not in p.types:
                visible = False
            if visible:
                frame.pack(fill="x", padx=2, pady=1)
            else:
                frame.pack_forget()

    def _confirm(self):
        if self._selected_set_id:
            self.result = self._selected_set_id
            self.destroy()


# ═══════════════════════════════════════════════════════════════════════
# TEAM SLOT CARD
# ═══════════════════════════════════════════════════════════════════════

class TeamSlotCard(tk.Frame):
    """A single team slot — shows empty placeholder or filled Pokemon detail."""

    def __init__(self, parent, kg: KnowledgeGraph, slot_index: int,
                 on_change_callback, sprite_mgr: SpriteManager):
        super().__init__(parent, bg=BG_CARD, padx=10, pady=8)
        self.kg = kg
        self.slot_index = slot_index
        self._on_change = on_change_callback
        self._sprite_mgr = sprite_mgr
        self._photo_refs: list = []

        # Constrain to grid cell width — prevents content from expanding the column
        self.grid_propagate(False)

        self.set_id: str | None = None
        self._build_empty()

    # ── Empty state ─────────────────────────────────────────────────

    def _build_empty(self):
        for w in self.winfo_children():
            w.destroy()

        self.config(bg=BG_CARD, cursor="hand2")

        center = tk.Frame(self, bg=BG_CARD)
        center.pack(expand=True)

        # Plus icon
        tk.Label(center, text="+", font=("Consolas", 36, "bold"),
                 fg=NEON_GREEN, bg=BG_CARD).pack()
        tk.Label(center, text=f"Slot {self.slot_index + 1}",
                 font=FONT_SMALL, fg=FG_DIM, bg=BG_CARD).pack()

        # Click anywhere to open selector
        self._bind_click_recursive(self, self._open_selector)

    # ── Filled state ────────────────────────────────────────────────

    def _build_filled(self, set_id: str):
        for w in self.winfo_children():
            w.destroy()

        set_obj = self.kg.get_set(set_id)
        pokemon = self.kg.get_pokemon(set_obj.pokemon_id) if set_obj else None
        if not set_obj or not pokemon:
            self._build_empty()
            return

        self.set_id = set_id
        self.config(bg=BG_CARD)

        # ── Header: sprite + name + set ─────────────────────────────
        header = tk.Frame(self, bg=BG_CARD)
        header.pack(fill="x", pady=(0, 4))

        # Sprite
        api = pokemon.api_name or pokemon.id
        sprite = self._sprite_mgr.get_sprite(api, (56, 56))
        if sprite:
            sp = tk.Label(header, image=sprite, bg=BG_CARD)
            sp.image = sprite
            sp.pack(side="left", padx=(0, 8))
            self._photo_refs.append(sprite)
        else:
            tk.Label(header, text="?", font=("Consolas", 20), fg=FG_DIM,
                     bg=BG_CARD, width=3).pack(side="left", padx=(0, 8))

        # Name + set name
        name_col = tk.Frame(header, bg=BG_CARD)
        name_col.pack(side="left", fill="both", expand=True)

        tk.Label(name_col, text=pokemon.name, font=("Consolas", 14, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(anchor="w")
        tk.Label(name_col, text=set_obj.set_name, font=("Consolas", 10),
                 fg=NEON_CYAN, bg=BG_CARD).pack(anchor="w")

        # ── Type + Role badges ──────────────────────────────────────
        badge_row = tk.Frame(self, bg=BG_CARD)
        badge_row.pack(fill="x", pady=(0, 4))

        for t in pokemon.types:
            tc = TYPE_COLORS.get(t, FG_DIM)
            tk.Label(badge_row, text=f" {t} ", font=("Consolas", 9, "bold"),
                     fg=BG_DARK, bg=tc, padx=5, pady=1).pack(side="left", padx=(0, 3))

        rc = ROLE_COLORS.get(set_obj.role, FG_DIM)
        tk.Label(badge_row, text=f" {set_obj.role} ",
                 font=("Consolas", 8), fg=BG_DARK, bg=rc,
                 padx=5, pady=1).pack(side="left", padx=(6, 0))

        # ── Key info line ───────────────────────────────────────────
        item = self.kg.get_item(set_obj.item)
        ability = self.kg.get_ability(set_obj.ability)
        info_text = (f"{item.name if item else set_obj.item}  ·  "
                     f"{ability.name if ability else set_obj.ability}")
        tk.Label(self, text=info_text, font=FONT_SMALL,
                 fg=FG_SECONDARY, bg=BG_CARD).pack(anchor="w")

        # ── Moves (2-column grid — content flexes vertically, not horizontally) ──
        mf = tk.Frame(self, bg=BG_CARD)
        mf.pack(fill="x", pady=(2, 4))
        for i, mid in enumerate(set_obj.moves):
            move = self.kg.get_move(mid)
            name = move.name if move else mid
            bp = f" ({move.base_power})" if move and move.base_power > 0 else ""
            mc = NEON_CYAN if move and move.is_status else FG_PRIMARY
            r, c = divmod(i, 2)
            tk.Label(mf, text=f"{name}{bp}", font=("Consolas", 8),
                     fg=mc, bg=BG_INPUT, padx=4, pady=1,
                     anchor="w").grid(row=r, column=c, padx=(0, 2), pady=1, sticky="ew")
        mf.columnconfigure(0, weight=1)
        mf.columnconfigure(1, weight=1)

        # ── Speed stat (prominent) ──────────────────────────────────
        stats = compute_set_stats(self.kg, set_obj, 100)
        speed_row = tk.Frame(self, bg=BG_CARD)
        speed_row.pack(fill="x", pady=(0, 4))
        tk.Label(speed_row, text="Spe:", font=("Consolas", 10),
                 fg=STAT_COLORS["spe"], bg=BG_CARD).pack(side="left")
        tk.Label(speed_row, text=str(stats.spe), font=("Consolas", 12, "bold"),
                 fg=STAT_COLORS["spe"], bg=BG_CARD).pack(side="left", padx=(4, 0))

        # ── Action buttons ──────────────────────────────────────────
        btn_row = tk.Frame(self, bg=BG_CARD)
        btn_row.pack(fill="x", pady=(2, 0))

        tk.Button(btn_row, text="Change", font=FONT_SMALL, fg=NEON_CYAN,
                  bg=BG_INPUT, activebackground=BG_HOVER, activeforeground=NEON_CYAN,
                  bd=0, padx=8, cursor="hand2",
                  command=self._open_selector).pack(side="left", padx=(0, 4))

        tk.Button(btn_row, text="Remove", font=FONT_SMALL, fg=NEON_RED,
                  bg=BG_INPUT, activebackground=BG_HOVER, activeforeground=NEON_RED,
                  bd=0, padx=8, cursor="hand2",
                  command=self._remove).pack(side="left")

    # ── Actions ─────────────────────────────────────────────────────

    def _open_selector(self):
        dialog = PokemonSetSelectorDialog(
            self.winfo_toplevel(), self.kg, self.slot_index,
            existing_set_id=self.set_id,
        )
        self.winfo_toplevel().wait_window(dialog)
        if dialog.result:
            self._build_filled(dialog.result)
            self._on_change()

    def _remove(self):
        self.set_id = None
        self._build_empty()
        self._on_change()

    # ── Helper ──────────────────────────────────────────────────────

    def _bind_click_recursive(self, widget, callback):
        widget.bind("<Button-1>", lambda e: callback())
        for child in widget.winfo_children():
            self._bind_click_recursive(child, callback)

    def set_from_id(self, set_id: str | None):
        """Programmatically set the slot content (used by load)."""
        if set_id and self.kg.get_set(set_id):
            self._build_filled(set_id)
        else:
            self.set_id = None
            self._build_empty()


# ═══════════════════════════════════════════════════════════════════════
# TEAM MANAGER PAGE — list / create / delete teams
# ═══════════════════════════════════════════════════════════════════════

class TeamManagerPage(tk.Frame):
    """Landing page for Team Builder: shows saved teams, allows create/delete/open."""

    def __init__(self, parent, kg: KnowledgeGraph, go_home_cb, open_team_cb):
        super().__init__(parent, bg=BG_DARK)
        self.kg = kg
        self._go_home = go_home_cb
        self._open_team_cb = open_team_cb  # called with (TeamRecord | None) for new
        self._store = TeamStore()
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []

        self._build_ui()
        self._refresh_list()

    # ── Layout ──────────────────────────────────────────────────────

    def _build_ui(self):
        # Top bar
        top = tk.Frame(self, bg=BG_PANEL, height=52)
        top.pack(fill="x")
        top.pack_propagate(False)

        tk.Button(top, text="← Back", font=FONT_BUTTON, fg=NEON_CYAN,
                  bg=BG_PANEL, activebackground=BG_HOVER,
                  activeforeground=NEON_CYAN, bd=0, cursor="hand2",
                  command=self._go_home).pack(side="left", padx=12, pady=10)

        tk.Label(top, text="Team Builder", font=FONT_HEADING,
                 fg=FG_PRIMARY, bg=BG_PANEL).pack(side="left", padx=8)

        # New Team button (right side)
        tk.Button(top, text="+ New Team", font=FONT_BUTTON, fg=BG_DARK,
                  bg=NEON_GREEN, activebackground=NEON_GREEN,
                  activeforeground=BG_DARK, bd=0, padx=16, pady=4,
                  cursor="hand2",
                  command=self._create_new_team).pack(side="right", padx=12, pady=10)

        # Team count label
        self._count_label = tk.Label(top, text="", font=FONT_BODY,
                                     fg=FG_SECONDARY, bg=BG_PANEL)
        self._count_label.pack(side="right", padx=8)

        # Scrollable team list
        outer = tk.Frame(self, bg=BG_DARK)
        outer.pack(fill="both", expand=True, padx=24, pady=16)

        self._list_canvas = tk.Canvas(outer, bg=BG_DARK,
                                       highlightthickness=0, bd=0)
        sb = tk.Scrollbar(outer, orient="vertical",
                          command=self._list_canvas.yview,
                          bg="#000000", troughcolor="#000000",
                          activebackground=NEON_CYAN,
                          highlightthickness=0, bd=0, width=10)
        self._list_inner = tk.Frame(self._list_canvas, bg=BG_DARK)
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

        # Empty state label (shown when no teams)
        self._empty_label = tk.Label(
            self._list_inner,
            text="No saved teams yet.\nClick \"+ New Team\" to get started.",
            font=FONT_BODY, fg=FG_DIM, bg=BG_DARK, justify="center",
        )

    # ── Refresh ─────────────────────────────────────────────────────

    def _refresh_list(self):
        """Rebuild the team list from disk."""
        for w in self._list_inner.winfo_children():
            w.destroy()

        teams = self._store.list_teams()
        self._count_label.config(text=f"{len(teams)} team{'s' if len(teams) != 1 else ''}")

        if not teams:
            self._empty_label = tk.Label(
                self._list_inner,
                text="No saved teams yet.\nClick \"+ New Team\" to get started.",
                font=FONT_BODY, fg=FG_DIM, bg=BG_DARK, justify="center",
            )
            self._empty_label.pack(pady=60)
            return

        for team in teams:
            self._add_team_row(team)

    def _add_team_row(self, team: TeamRecord):
        """Add a single team card to the list."""
        card = tk.Frame(self._list_inner, bg=BG_CARD, padx=12, pady=10)
        card.pack(fill="x", padx=4, pady=4)

        # Left: team info
        info = tk.Frame(card, bg=BG_CARD)
        info.pack(side="left", fill="both", expand=True)

        # Name
        tk.Label(info, text=team.team_name, font=("Consolas", 13, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(anchor="w")

        # Pokemon count + type badges
        detail_row = tk.Frame(info, bg=BG_CARD)
        detail_row.pack(anchor="w", pady=(4, 0))

        tk.Label(detail_row, text=f"{team.pokemon_count}/6 Pokémon",
                 font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_CARD).pack(side="left")

        # Show type badges from stored sets
        if team.sets:
            types_seen: set[str] = set()
            for sid in team.sets:
                s = self.kg.get_set(sid)
                if s:
                    p = self.kg.get_pokemon(s.pokemon_id)
                    if p:
                        types_seen.update(p.types)
            for t in sorted(types_seen):
                tc = TYPE_COLORS.get(t, FG_DIM)
                tk.Label(detail_row, text=f" {t} ", font=("Consolas", 7, "bold"),
                         fg=BG_DARK, bg=tc, padx=3, pady=0).pack(side="left", padx=(6, 0))

        # Sprites preview (up to 6, small)
        sprite_row = tk.Frame(info, bg=BG_CARD)
        sprite_row.pack(anchor="w", pady=(4, 0))
        for sid in team.sets[:6]:
            s = self.kg.get_set(sid)
            if s:
                p = self.kg.get_pokemon(s.pokemon_id)
                if p:
                    api = p.api_name or p.id
                    sprite = self._sprite_mgr.get_sprite(api, (28, 28))
                    if sprite:
                        sp = tk.Label(sprite_row, image=sprite, bg=BG_CARD)
                        sp.image = sprite
                        sp.pack(side="left", padx=(0, 2))
                        self._photo_refs.append(sprite)

        # Right: action buttons
        btn_frame = tk.Frame(card, bg=BG_CARD)
        btn_frame.pack(side="right", padx=(8, 0))

        tk.Button(btn_frame, text="Open", font=FONT_BUTTON, fg=NEON_CYAN,
                  bg=BG_INPUT, activebackground=BG_HOVER,
                  activeforeground=NEON_CYAN, bd=0, padx=14, pady=4,
                  cursor="hand2",
                  command=lambda t=team: self._open_team(t)).pack(pady=(0, 4))

        tk.Button(btn_frame, text="Delete", font=FONT_SMALL, fg=NEON_RED,
                  bg=BG_INPUT, activebackground=BG_HOVER,
                  activeforeground=NEON_RED, bd=0, padx=14, pady=2,
                  cursor="hand2",
                  command=lambda t=team: self._delete_team(t)).pack()

    # ── Actions ─────────────────────────────────────────────────────

    def _create_new_team(self):
        """Create a new empty team and open the builder."""
        team = self._store.create_team("Untitled Team")
        self._open_team_cb(team)

    def _open_team(self, team: TeamRecord):
        """Open a team in the builder editor."""
        self._open_team_cb(team)

    def _delete_team(self, team: TeamRecord):
        """Delete a team after confirmation."""
        if messagebox.askyesno("Delete Team",
                               f"Delete \"{team.team_name}\"?\nThis cannot be undone."):
            self._store.delete_team(team.team_id)
            self._refresh_list()


# ═══════════════════════════════════════════════════════════════════════
# MAIN TEAM BUILDER PAGE
# ═══════════════════════════════════════════════════════════════════════

class TeamBuilderPage(tk.Frame):
    """Full-page team builder with 2x3 slot grid + analysis placeholder."""

    def __init__(self, parent, kg: KnowledgeGraph, go_back_cb,
                 team_record: TeamRecord):
        super().__init__(parent, bg=BG_DARK)
        self.kg = kg
        self._go_back = go_back_cb   # back to team manager
        self._team_record = team_record
        self._store = TeamStore()
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []
        self._team_name = team_record.team_name

        self._build_ui()
        self._load_from_record()

    # ── Layout ──────────────────────────────────────────────────────

    def _build_ui(self):
        # ── Top bar ─────────────────────────────────────────────────
        top = tk.Frame(self, bg=BG_PANEL, height=52)
        top.pack(fill="x")
        top.pack_propagate(False)

        tk.Button(top, text="← Back", font=FONT_BUTTON, fg=NEON_CYAN,
                  bg=BG_PANEL, activebackground=BG_HOVER,
                  activeforeground=NEON_CYAN, bd=0, cursor="hand2",
                  command=self._go_back).pack(side="left", padx=12, pady=10)

        tk.Label(top, text="Team Builder", font=FONT_HEADING,
                 fg=FG_PRIMARY, bg=BG_PANEL).pack(side="left", padx=8)

        # Team name (editable)
        self._name_var = tk.StringVar(value=self._team_name)
        name_entry = tk.Entry(top, textvariable=self._name_var,
                              font=("Consolas", 12), bg=BG_INPUT,
                              fg=NEON_YELLOW, insertbackground=NEON_YELLOW,
                              relief="flat", width=20)
        name_entry.pack(side="left", padx=12, pady=10, ipady=4)

        # Auto-save on name change
        name_entry.bind("<FocusOut>", lambda e: self._auto_save())

        # Action buttons (right side)
        btn_frame = tk.Frame(top, bg=BG_PANEL)
        btn_frame.pack(side="right", padx=12, pady=10)

        for text, color, cmd in [
            ("Export", NEON_ORANGE, self._export_showdown),
            ("Save", NEON_GREEN, self._save_team),
        ]:
            tk.Button(btn_frame, text=text, font=FONT_BUTTON, fg=color,
                      bg=BG_CARD, activebackground=BG_HOVER,
                      activeforeground=color, bd=0, padx=12, pady=4,
                      cursor="hand2", command=cmd).pack(side="left", padx=4)

        # ── Main body: slots (left) + analysis placeholder (right) ──
        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True, padx=12, pady=12)
        body.columnconfigure(0, weight=1, uniform="body_cols")
        body.columnconfigure(1, weight=1, uniform="body_cols")
        body.rowconfigure(0, weight=1)

        # Left: slot grid (50%)
        self._slots_frame = tk.Frame(body, bg=BG_DARK)
        self._slots_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 8))

        # Configure 3x2 grid — uniform forces all columns to equal width (1/2 each)
        for r in range(SLOT_ROWS):
            self._slots_frame.rowconfigure(r, weight=1)
        for c in range(SLOT_COLS):
            self._slots_frame.columnconfigure(c, weight=1, uniform="team_slots")

        self._slots: list[TeamSlotCard] = []
        for i in range(TEAM_SIZE):
            r, c = divmod(i, SLOT_COLS)
            card = TeamSlotCard(
                self._slots_frame, self.kg, i,
                on_change_callback=self._on_team_changed,
                sprite_mgr=self._sprite_mgr,
            )
            card.grid(row=r, column=c, padx=4, pady=4, sticky="nsew")
            self._slots.append(card)

        # Right: analysis placeholder (50%)
        self._analysis_frame = tk.Frame(body, bg=BG_PANEL)
        self._analysis_frame.grid(row=0, column=1, sticky="nsew", padx=(8, 0))

        self._build_analysis_placeholder()

    def _build_analysis_placeholder(self):
        """Placeholder panel for future team analysis features."""
        for w in self._analysis_frame.winfo_children():
            w.destroy()

        center = tk.Frame(self._analysis_frame, bg=BG_PANEL)
        center.pack(expand=True)

        tk.Label(center, text="Team Analysis", font=FONT_HEADING,
                 fg=FG_PRIMARY, bg=BG_PANEL).pack(pady=(0, 8))

        tk.Label(center, text="Coming soon:", font=FONT_BODY,
                 fg=FG_SECONDARY, bg=BG_PANEL).pack()

        features = [
            "Type Coverage Matrix",
            "Defensive Profile",
            "Speed Tier Chart",
            "Role Distribution",
            "Matchup Table vs Meta",
            "Gap Analysis & Suggestions",
        ]
        for feat in features:
            tk.Label(center, text=f"  · {feat}", font=FONT_SMALL,
                     fg=FG_DIM, bg=BG_PANEL).pack(anchor="w")

        # Team summary (basic)
        self._summary_label = tk.Label(
            center, text="", font=FONT_BODY, fg=NEON_CYAN, bg=BG_PANEL,
        )
        self._summary_label.pack(pady=(16, 0))

        self._update_summary()

    # ── Team state ──────────────────────────────────────────────────

    def _get_team_set_ids(self) -> list[str]:
        """Return list of non-None set IDs from the slots."""
        return [s.set_id for s in self._slots if s.set_id is not None]

    def _on_team_changed(self):
        """Called whenever a slot changes (add/remove)."""
        self._update_summary()
        self._auto_save()

    def _update_summary(self):
        """Update the basic team summary text."""
        team_ids = self._get_team_set_ids()
        count = len(team_ids)
        if count == 0:
            self._summary_label.config(text="No Pokemon selected")
            return

        # Gather types and roles
        all_types: list[str] = []
        all_roles: list[str] = []
        for sid in team_ids:
            s = self.kg.get_set(sid)
            if s:
                p = self.kg.get_pokemon(s.pokemon_id)
                if p:
                    all_types.extend(p.types)
                if s.role:
                    all_roles.append(s.role)

        type_text = ", ".join(sorted(set(all_types)))
        role_text = ", ".join(sorted(set(all_roles)))

        summary = f"{count}/6 Pokemon\nTypes: {type_text}\nRoles: {role_text}"
        self._summary_label.config(text=summary)

    # ── Save / Load / Export ─────────────────────────────────────────

    def _load_from_record(self):
        """Populate slots from the team record."""
        for i, sid in enumerate(self._team_record.sets[:TEAM_SIZE]):
            self._slots[i].set_from_id(sid)
        self._on_team_changed()

    def _auto_save(self):
        """Silently persist current state to the team store."""
        self._store.update_team(
            self._team_record.team_id,
            team_name=self._name_var.get(),
            set_ids=self._get_team_set_ids(),
        )
        self._team_record.team_name = self._name_var.get()
        self._team_record.sets = self._get_team_set_ids()

    def _save_team(self):
        """Save team to the local team store and show confirmation."""
        self._auto_save()
        messagebox.showinfo("Saved",
                            f"\"{self._name_var.get()}\" saved successfully.")

    def _export_showdown(self):
        """Export team in Pokemon Showdown importable format."""
        team_ids = self._get_team_set_ids()
        if not team_ids:
            messagebox.showinfo("Export", "No Pokemon in team to export.")
            return

        lines: list[str] = []
        for sid in team_ids:
            s = self.kg.get_set(sid)
            if not s:
                continue
            p = self.kg.get_pokemon(s.pokemon_id)
            pname = p.name if p else s.pokemon_id

            # Item
            item = self.kg.get_item(s.item)
            item_name = item.name if item else s.item

            # Ability
            ability = self.kg.get_ability(s.ability)
            ability_name = ability.name if ability else s.ability

            # Header line: Pokemon @ Item
            header = f"{pname} @ {item_name}" if item_name else pname
            lines.append(header)
            lines.append(f"Ability: {ability_name}")

            # EVs
            ev_parts = []
            for stat, label in [("hp", "HP"), ("atk", "Atk"), ("def", "Def"),
                                ("spa", "SpA"), ("spd", "SpD"), ("spe", "Spe")]:
                val = s.evs.get(stat)
                if val > 0:
                    ev_parts.append(f"{val} {label}")
            if ev_parts:
                lines.append(f"EVs: {' / '.join(ev_parts)}")

            # Nature
            lines.append(f"{s.nature.name} Nature")

            # Tera Type
            if s.tera_type:
                lines.append(f"Tera Type: {s.tera_type}")

            # Moves
            for mid in s.moves:
                move = self.kg.get_move(mid)
                mname = move.name if move else mid
                lines.append(f"- {mname}")

            lines.append("")  # blank line between Pokemon

        showdown_text = "\n".join(lines).strip()

        # Copy to clipboard and show in dialog
        self.clipboard_clear()
        self.clipboard_append(showdown_text)

        # Show in a dialog
        dlg = tk.Toplevel(self)
        dlg.title("Showdown Export (copied to clipboard)")
        dlg.configure(bg=BG_DARK)
        dlg.geometry("500x400")
        dlg.transient(self)

        tk.Label(dlg, text="Pokemon Showdown Format (copied to clipboard)",
                 font=FONT_HEADING, fg=NEON_GREEN, bg=BG_DARK).pack(padx=12, pady=(12, 4))

        text_widget = tk.Text(dlg, font=("Consolas", 11), bg=BG_INPUT,
                              fg=FG_PRIMARY, insertbackground=FG_PRIMARY,
                              relief="flat", wrap="word", padx=12, pady=8)
        text_widget.pack(fill="both", expand=True, padx=12, pady=(0, 12))
        text_widget.insert("1.0", showdown_text)
        text_widget.config(state="disabled")
