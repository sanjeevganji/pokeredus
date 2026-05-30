"""
Pokemon browser page — list panel, detail panel, sets, matchup rankings.

Major UI overhaul:
- Type badges instead of gradient backgrounds
- Side-by-side best/worst matchups with lazy loading
- Bigger fonts, wider listings, better space usage
- Stat bars with yellow->green gradient mapping
- Matchup detail dropdown with icons, moves, TTK
- Sprite in species card heading
- BST in stats bar section
"""

from __future__ import annotations

import math
import re
import tkinter as tk
from tkinter import ttk
from typing import TYPE_CHECKING

from pokeredus.gui.theme import *
from pokeredus.graph.matchup_engine import compute_matchup
from pokeredus.graph.analytics import (
    compute_set_stats, aggregate_matchups_by_species, SetStats,
)
from pokeredus.config import STAT_NAMES
from pokeredus.gui.sprites import get_sprite_manager, SpriteManager
from PIL import ImageTk
from pokeredus.graph.matchup_cache import MatchupCache, CachedMatchup

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.classes import PokemonClass


# ═══════════════════════════════════════════════════════════════════════
# FILTER SYSTEM
# ═══════════════════════════════════════════════════════════════════════

class PokemonFilter:
    name: str = "base"
    def matches(self, pokemon, kg) -> bool:
        return True

class RegexSearchFilter(PokemonFilter):
    name = "search"
    def __init__(self):
        self._pattern: re.Pattern | None = None
    def set_pattern(self, text: str) -> None:
        text = text.strip()
        if not text:
            self._pattern = None
            return
        try:
            self._pattern = re.compile(text, re.IGNORECASE)
        except re.error:
            self._pattern = re.compile(re.escape(text), re.IGNORECASE)
    def matches(self, pokemon, kg) -> bool:
        if self._pattern is None:
            return True
        return bool(self._pattern.search(pokemon.name))

class TypeFilter(PokemonFilter):
    name = "type"
    def __init__(self):
        self._type = "All"
    def set_type(self, t: str) -> None:
        self._type = t
    def matches(self, pokemon, kg) -> bool:
        return self._type == "All" or self._type in pokemon.types

class ClassificationFilter(PokemonFilter):
    name = "classification"
    def __init__(self):
        self._mega = self._paradox = self._legendary = self._pseudo = True
    def set_toggles(self, mega=True, paradox=True, legendary=True, pseudo=True):
        self._mega, self._paradox, self._legendary, self._pseudo = mega, paradox, legendary, pseudo
    def matches(self, pokemon, kg) -> bool:
        if pokemon.is_mega: return self._mega
        if pokemon.is_paradox: return self._paradox
        if pokemon.is_legendary: return self._legendary
        if pokemon.is_pseudo: return self._pseudo
        return True

class FilterChain:
    def __init__(self):
        self._filters: list[PokemonFilter] = []
    def add(self, f): self._filters.append(f)
    def passes(self, pokemon, kg) -> bool:
        return all(f.matches(pokemon, kg) for f in self._filters)


# ═══════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════

def _stat_bar_color(value: int, max_val: int) -> str:
    """Yellow (low) -> Green (high) gradient for stat bars."""
    ratio = min(1.0, max(0.0, value / max(max_val, 1)))
    # Yellow #ffe600 -> Green #39ff14
    r = int(255 * (1 - ratio) + 57 * ratio)
    g = int(230 * (1 - ratio) + 255 * ratio)
    b = int(0 * (1 - ratio) + 20 * ratio)
    return f"#{r:02x}{g:02x}{b:02x}"


def _score_eval_text(score: float) -> str:
    if score >= 0.8:    return "Dominant — hard counter"
    elif score >= 0.5:  return "Strong advantage"
    elif score >= 0.2:  return "Slight edge"
    elif score > -0.2:  return "Neutral — depends on plays"
    elif score > -0.5:  return "Disadvantage"
    elif score > -0.8:  return "Unfavorable"
    else:               return "Hard countered"


MATCHUP_LOAD_INITIAL = 10
MATCHUP_LOAD_MORE = 5


# ═══════════════════════════════════════════════════════════════════════
# MAIN PAGE
# ═══════════════════════════════════════════════════════════════════════

class PokemonPage(tk.Frame):

    def __init__(self, parent, kg: KnowledgeGraph, go_home_cb, matchup_cache: MatchupCache | None = None):
        super().__init__(parent, bg=BG_DARK)
        self.kg = kg
        self._go_home = go_home_cb
        self._selected_pokemon_id: str | None = None
        self._selected_set_id: str | None = None
        self._stats_cache: dict[str, SetStats] = {}
        self._sprite_mgr = get_sprite_manager()
        self._photo_refs: list = []  # prevent GC
        self._matchup_cache = matchup_cache

        self._search_filter = RegexSearchFilter()
        self._type_filter = TypeFilter()
        self._class_filter = ClassificationFilter()
        self._filter_chain = FilterChain()
        self._filter_chain.add(self._search_filter)
        self._filter_chain.add(self._type_filter)
        self._filter_chain.add(self._class_filter)

        self._build_ui()
        self._load_pokemon_list()

        api_names = [p.api_name or p.id for p in kg.get_all_pokemon()]
        self._sprite_mgr.download_missing(api_names, callback=self._on_sprites_ready)

    def _on_sprites_ready(self, count):
        if count > 0:
            self.after(0, self._refresh_list_sprites)

    def _refresh_list_sprites(self):
        for pid, widgets in self._pokemon_widgets.items():
            p = self.kg.get_pokemon(pid)
            if not p: continue
            api = p.api_name or p.id
            sprite = self._sprite_mgr.get_sprite(api, (48, 48))
            if sprite and "sprite_label" in widgets:
                widgets["sprite_label"].configure(image=sprite)
                widgets["sprite_label"].image = sprite

    # ── Layout ──────────────────────────────────────────────────────

    def _build_ui(self):
        top = tk.Frame(self, bg=BG_PANEL, height=52)
        top.pack(fill="x")
        top.pack_propagate(False)

        tk.Button(top, text="← Back", font=FONT_BUTTON, fg=NEON_CYAN, bg=BG_PANEL,
                  activebackground=BG_HOVER, activeforeground=NEON_CYAN,
                  bd=0, cursor="hand2", command=self._go_home).pack(side="left", padx=12, pady=10)
        tk.Label(top, text="Pokemon Stats", font=FONT_HEADING, fg=FG_PRIMARY,
                 bg=BG_PANEL).pack(side="left", padx=8)

        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True)

        self._sidebar = tk.Frame(body, bg=BG_PANEL, width=380)
        self._sidebar.pack(side="left", fill="y")
        self._sidebar.pack_propagate(False)

        self._detail_frame = tk.Frame(body, bg=BG_DARK)
        self._detail_frame.pack(side="left", fill="both", expand=True)

        self._build_sidebar()
        self._build_detail_panel()

    # ── Sidebar ─────────────────────────────────────────────────────

    def _build_sidebar(self):
        # Search
        sf = tk.Frame(self._sidebar, bg=BG_PANEL)
        sf.pack(fill="x", padx=10, pady=(10, 4))
        self._search_var = tk.StringVar()
        self._search_var.trace_add("write", lambda *_: self._on_search_change())
        self._search_error = tk.Label(sf, text="", font=FONT_SMALL, fg=NEON_RED, bg=BG_PANEL)
        self._search_entry = tk.Entry(sf, textvariable=self._search_var, font=FONT_BODY,
                                       bg=BG_INPUT, fg=FG_PRIMARY, insertbackground=FG_PRIMARY,
                                       relief="flat", bd=0)
        self._search_entry.pack(fill="x", ipady=8)
        self._search_error.pack(fill="x")
        self._add_placeholder(self._search_entry, "Search (regex)...")

        # Type + toggles + sort row
        ff = tk.Frame(self._sidebar, bg=BG_PANEL)
        ff.pack(fill="x", padx=10, pady=4)

        tk.Label(ff, text="Type:", font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left")
        self._type_var = tk.StringVar(value="All")
        ttk.Combobox(ff, textvariable=self._type_var,
                     values=["All"] + list(TYPE_COLORS.keys()),
                     state="readonly", width=10, font=FONT_SMALL).pack(side="left", padx=4)
        self._type_var.trace_add("write", lambda *_: self._on_type_change())

        tk.Label(ff, text="Sort:", font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_PANEL).pack(side="left", padx=(12, 0))
        self._sort_var = tk.StringVar(value="BST")
        ttk.Combobox(ff, textvariable=self._sort_var, values=SORT_OPTIONS,
                     state="readonly", width=8, font=FONT_SMALL).pack(side="left", padx=4)
        self._sort_var.trace_add("write", lambda *_: self._on_sort_change())

        # Toggles
        tf = tk.Frame(self._sidebar, bg=BG_PANEL)
        tf.pack(fill="x", padx=10, pady=(0, 4))
        self._toggle_vars: dict[str, tk.BooleanVar] = {}
        for label, key, color in [("Mega", "mega", NEON_PINK), ("Paradox", "paradox", NEON_PURPLE),
                                    ("Legend", "legendary", NEON_YELLOW), ("Pseudo", "pseudo", NEON_ORANGE)]:
            var = tk.BooleanVar(value=True)
            self._toggle_vars[key] = var
            tk.Checkbutton(tf, text=label, variable=var, font=FONT_SMALL, fg=color, bg=BG_PANEL,
                           selectcolor=BG_INPUT, activebackground=BG_PANEL, activeforeground=color,
                           highlightthickness=0, command=self._on_toggle_change).pack(side="left", padx=4)

        # Sort header (clickable to toggle asc/desc)
        self._sort_descending = True
        self._sort_header = tk.Frame(self._sidebar, bg=BG_PANEL)
        self._sort_header.pack(fill="x", padx=10, pady=(4, 0))
        self._sort_header_label = tk.Label(
            self._sort_header, text="", font=("Consolas", 10, "bold"),
            fg=NEON_CYAN, bg=BG_PANEL, cursor="hand2", anchor="w",
        )
        self._sort_header_label.pack(side="right")
        self._sort_header_label.bind("<Button-1>", lambda e: self._toggle_sort_direction())
        self._update_sort_header()

        # List
        lo = tk.Frame(self._sidebar, bg=BG_PANEL)
        lo.pack(fill="both", expand=True, padx=10, pady=4)

        self._list_canvas = tk.Canvas(lo, bg=BG_PANEL, highlightthickness=0, bd=0)
        self._list_scrollbar = tk.Scrollbar(
            lo, orient="vertical", command=self._list_canvas.yview,
            bg="#000000", troughcolor="#000000", activebackground=NEON_CYAN,
            highlightthickness=0, bd=0, width=10,
        )
        self._list_inner = tk.Frame(self._list_canvas, bg=BG_PANEL)
        self._list_inner.bind("<Configure>",
                              lambda e: self._list_canvas.configure(scrollregion=self._list_canvas.bbox("all")))
        self._list_canvas.create_window((0, 0), window=self._list_inner, anchor="nw", tags="inner")
        self._list_canvas.configure(yscrollcommand=self._list_scrollbar.set)
        self._list_scrollbar.pack(side="right", fill="y")
        self._list_canvas.pack(side="left", fill="both", expand=True)
        self._list_canvas.bind("<Configure>", self._on_list_resize)

        # Mousewheel — bind on the canvas AND propagate to all children
        def _on_list_wheel(event):
            self._list_canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"

        self._list_canvas.bind("<MouseWheel>", _on_list_wheel)
        self._list_inner.bind("<MouseWheel>", _on_list_wheel)
        # Bind on the outer frame too so scrolling works when mouse is over any child
        lo.bind("<MouseWheel>", _on_list_wheel)

    def _add_placeholder(self, entry, placeholder):
        def on_in(_):
            if entry.get() == placeholder:
                entry.delete(0, "end"); entry.config(fg=FG_PRIMARY)
        def on_out(_):
            if not entry.get():
                entry.insert(0, placeholder); entry.config(fg=FG_DIM)
        entry.insert(0, placeholder); entry.config(fg=FG_DIM)
        entry.bind("<FocusIn>", on_in); entry.bind("<FocusOut>", on_out)

    def _on_list_resize(self, event):
        self._list_canvas.itemconfig("inner", width=event.width - 4)

    def _update_sort_header(self):
        """Update the sort header label with current sort and direction arrow."""
        sk = self._sort_var.get() if hasattr(self, '_sort_var') else "BST"
        arrow = "▼" if self._sort_descending else "▲"
        self._sort_header_label.config(text=f"  {sk}  {arrow}  ")

    def _toggle_sort_direction(self):
        """Toggle ascending/descending sort and rebuild list."""
        self._sort_descending = not self._sort_descending
        self._update_sort_header()
        self._rebuild_list()

    # ── Filter callbacks ────────────────────────────────────────────

    def _on_sort_change(self):
        self._update_sort_header()
        self._rebuild_list()

    def _on_search_change(self):
        text = self._search_var.get()
        if text == "Search (regex)...": text = ""
        self._search_filter.set_pattern(text)
        if text:
            try:
                re.compile(text); self._search_error.config(text="")
            except re.error as e:
                self._search_error.config(text=f"Bad regex: {e}")
        else:
            self._search_error.config(text="")
        self._apply_filters()

    def _on_type_change(self):
        self._type_filter.set_type(self._type_var.get())
        self._apply_filters()

    def _on_toggle_change(self):
        self._class_filter.set_toggles(
            mega=self._toggle_vars["mega"].get(),
            paradox=self._toggle_vars["paradox"].get(),
            legendary=self._toggle_vars["legendary"].get(),
            pseudo=self._toggle_vars["pseudo"].get())
        self._apply_filters()

    def _apply_filters(self):
        if not hasattr(self, '_pokemon_widgets'): return
        for pid, widgets in self._pokemon_widgets.items():
            p = self.kg.get_pokemon(pid)
            if p and self._filter_chain.passes(p, self.kg):
                widgets["frame"].pack(fill="x", padx=2, pady=2)
            else:
                widgets["frame"].pack_forget()

    # ── Pokemon List ────────────────────────────────────────────────

    def _load_pokemon_list(self):
        self._rebuild_list()

    def _rebuild_list(self):
        for w in self._list_inner.winfo_children(): w.destroy()
        pokemon = list(self.kg.get_all_pokemon())
        sk = self._sort_var.get() if hasattr(self, '_sort_var') else "BST"
        desc = self._sort_descending if hasattr(self, '_sort_descending') else True
        sm = {"HP": "hp", "Atk": "atk", "Def": "def", "SpA": "spa", "SpD": "spd", "Spe": "spe"}
        if sk == "Name":
            pokemon.sort(key=lambda p: p.name, reverse=desc)
        elif sk == "BST":
            pokemon.sort(key=lambda p: p.bst, reverse=desc)
        elif sk in sm:
            pokemon.sort(key=lambda p: p.base_stats.get(sm[sk], 0), reverse=desc)

        self._pokemon_widgets: dict[str, dict] = {}
        for p in pokemon:
            self._create_list_item(p)
        self._list_canvas.yview_moveto(0)
        self._apply_filters()

    def _create_list_item(self, pokemon: PokemonClass):
        frame = tk.Frame(self._list_inner, bg=BG_CARD, cursor="hand2", height=56)
        frame.pack(fill="x", padx=2, pady=2)
        frame.pack_propagate(False)

        # Determine sort value FIRST (needed for packing order)
        sk = self._sort_var.get() if hasattr(self, '_sort_var') else "BST"
        stat_map = {"HP": "hp", "Atk": "atk", "Def": "def", "SpA": "spa", "SpD": "spd", "Spe": "spe"}
        if sk == "BST":
            sort_val = pokemon.bst
            sort_color = NEON_YELLOW
        elif sk == "Name":
            sort_val = None
            sort_color = FG_DIM
        elif sk in stat_map:
            sort_val = pokemon.base_stats.get(stat_map[sk], 0)
            sort_color = STAT_COLORS.get(stat_map[sk], FG_DIM)
        else:
            sort_val = None
            sort_color = FG_DIM

        # ── Pack RIGHT side first (stat column + set badge) ──
        # In tkinter pack, side="right" must be packed BEFORE side="left" with expand
        if sort_val is not None:
            stat_box = tk.Frame(frame, bg=BG_INPUT, width=52)
            stat_box.pack(side="right", padx=(0, 6), pady=6, fill="y")
            stat_box.pack_propagate(False)
            tk.Label(stat_box, text=str(sort_val), font=("Consolas", 12, "bold"),
                     fg=sort_color, bg=BG_INPUT).pack(expand=True)

        # Set count badge (top-right corner of the frame)
        sets_count = len(self.kg.get_sets(pokemon.id))
        badge = tk.Label(frame, text=str(sets_count), font=("Consolas", 8, "bold"),
                          fg=BG_DARK, bg=NEON_CYAN, padx=4, pady=1)
        badge.place(relx=1.0, rely=0.0, anchor="ne", x=-4, y=4)

        # ── Pack LEFT side (sprite + info) ──
        # Sprite
        api = pokemon.api_name or pokemon.id
        sprite = self._sprite_mgr.get_sprite(api, (48, 48))
        if sprite:
            sprite_label = tk.Label(frame, image=sprite, bg=BG_CARD)
            sprite_label.image = sprite
        else:
            sprite_label = tk.Label(frame, text="□", font=("Consolas", 14), fg=FG_DIM,
                                     bg=BG_CARD, width=4)
        sprite_label.pack(side="left", padx=(8, 8), pady=4)

        # Info column (name + types below) — expand fills remaining space
        info = tk.Frame(frame, bg=BG_CARD)
        info.pack(side="left", fill="both", expand=True, pady=4)

        # Name line
        tk.Label(info, text=pokemon.name, font=("Consolas", 12, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(anchor="w")

        # Types + classification line (below name)
        type_row = tk.Frame(info, bg=BG_CARD)
        type_row.pack(anchor="w")

        for t in pokemon.types:
            tc = TYPE_COLORS.get(t, FG_DIM)
            tk.Label(type_row, text=f" {t} ", font=("Consolas", 8, "bold"),
                     fg=BG_DARK, bg=tc, padx=4, pady=1).pack(side="left", padx=(0, 3))

        if pokemon.has_classification:
            cls_color = NEON_PURPLE if pokemon.is_paradox else NEON_PINK if pokemon.is_mega else NEON_YELLOW if pokemon.is_legendary else NEON_ORANGE
            tk.Label(type_row, text=pokemon.classification, font=("Consolas", 7),
                     fg=cls_color, bg=BG_CARD).pack(side="left", padx=(4, 0))

        # Store refs
        widgets = {"frame": frame, "sprite_label": sprite_label}
        self._pokemon_widgets[pokemon.id] = widgets

        # Click bindings
        all_w = [frame, info, sprite_label, type_row, badge] + type_row.winfo_children()
        if sort_val is not None:
            all_w.append(stat_box)
        for w in all_w:
            w.bind("<Button-1>", lambda e, pid=pokemon.id: self._select_pokemon(pid))
            w.bind("<Enter>", lambda e, f=frame: self._hover(f, BG_HOVER))
            w.bind("<Leave>", lambda e, f=frame: self._hover(f, BG_CARD))

    def _hover(self, frame, color):
        try:
            frame.config(bg=color)
            for c in frame.winfo_children():
                try: c.config(bg=color)
                except tk.TclError: pass
        except tk.TclError: pass

    # ── Detail Panel ────────────────────────────────────────────────

    def _build_detail_panel(self):
        self._detail_canvas = tk.Canvas(self._detail_frame, bg=BG_DARK, highlightthickness=0)
        sb = tk.Scrollbar(
            self._detail_frame, orient="vertical", command=self._detail_canvas.yview,
            bg="#000000", troughcolor="#000000", activebackground=NEON_CYAN,
            highlightthickness=0, bd=0, width=10,
        )
        self._detail_inner = tk.Frame(self._detail_canvas, bg=BG_DARK)
        self._detail_inner.bind("<Configure>",
                                lambda e: self._detail_canvas.configure(scrollregion=self._detail_canvas.bbox("all")))
        self._detail_canvas.create_window((0, 0), window=self._detail_inner, anchor="nw", tags="inner")
        self._detail_canvas.configure(yscrollcommand=sb.set)
        self._detail_canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self._detail_canvas.bind("<Configure>",
                                  lambda e: self._detail_canvas.itemconfig("inner", width=e.width - 4))

        # Mousewheel for detail panel
        def _on_detail_wheel(event):
            self._detail_canvas.yview_scroll(-1 * (event.delta // 120), "units")
            return "break"

        self._detail_canvas.bind("<MouseWheel>", _on_detail_wheel)
        self._detail_inner.bind("<MouseWheel>", _on_detail_wheel)
        self._detail_frame.bind("<MouseWheel>", _on_detail_wheel)
        tk.Label(self._detail_inner, text="Select a Pokemon from the list",
                 font=FONT_HEADING, fg=FG_DIM, bg=BG_DARK).pack(expand=True)

    # ── Pokemon Selection ───────────────────────────────────────────

    def _select_pokemon(self, pokemon_id: str):
        self._selected_pokemon_id = pokemon_id
        self._selected_set_id = None
        pokemon = self.kg.get_pokemon(pokemon_id)
        if not pokemon: return

        for pid, w in self._pokemon_widgets.items():
            w["frame"].config(bg=BG_SELECTED if pid == pokemon_id else BG_CARD)

        for w in self._detail_inner.winfo_children(): w.destroy()

        sets = self.kg.get_sets(pokemon_id)
        self._stats_cache = {s.id: compute_set_stats(self.kg, s, 100) for s in sets}

        # ── Species Card ────────────────────────────────────────────
        card = tk.Frame(self._detail_inner, bg=BG_CARD, padx=16, pady=12)
        card.pack(fill="x", padx=16, pady=(12, 8))

        header = tk.Frame(card, bg=BG_CARD)
        header.pack(fill="x")

        # Sprite in heading
        api = pokemon.api_name or pokemon.id
        sprite = self._sprite_mgr.get_sprite(api, (64, 64))
        if sprite:
            sp = tk.Label(header, image=sprite, bg=BG_CARD)
            sp.image = sprite
            sp.pack(side="left", padx=(0, 12))
            self._photo_refs.append(sprite)

        # Name + types + classification
        name_col = tk.Frame(header, bg=BG_CARD)
        name_col.pack(side="left", fill="y")

        tk.Label(name_col, text=pokemon.name, font=("Consolas", 18, "bold"),
                 fg=FG_PRIMARY, bg=BG_CARD).pack(anchor="w")

        type_row = tk.Frame(name_col, bg=BG_CARD)
        type_row.pack(anchor="w", pady=(2, 0))
        for t in pokemon.types:
            tc = TYPE_COLORS.get(t, FG_DIM)
            tk.Label(type_row, text=f" {t} ", font=("Consolas", 10, "bold"),
                     fg=BG_DARK, bg=tc, padx=6, pady=2).pack(side="left", padx=(0, 4))

        if pokemon.has_classification:
            cls_color = NEON_PURPLE if pokemon.is_paradox else NEON_PINK if pokemon.is_mega else NEON_YELLOW if pokemon.is_legendary else NEON_ORANGE
            tk.Label(type_row, text=f" {pokemon.classification} ", font=("Consolas", 9),
                     fg=cls_color, bg=BG_CARD).pack(side="left", padx=(8, 0))

        # Abilities
        ab_row = tk.Frame(name_col, bg=BG_CARD)
        ab_row.pack(anchor="w", pady=(4, 0))
        tk.Label(ab_row, text="Abilities:", font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_CARD).pack(side="left")
        for a in pokemon.abilities:
            ab = self.kg.get_ability(a)
            tk.Label(ab_row, text=ab.name if ab else a, font=FONT_SMALL,
                     fg=NEON_CYAN, bg=BG_CARD).pack(side="left", padx=(8, 0))

        # ── Side-by-side stats ──────────────────────────────────────
        stats_wrap = tk.Frame(self._detail_inner, bg=BG_DARK)
        stats_wrap.pack(fill="x", padx=16, pady=(8, 4))

        # Base stats (left)
        base_frame = tk.Frame(stats_wrap, bg=BG_CARD, padx=12, pady=8)
        base_frame.pack(side="left", fill="both", expand=True, padx=(0, 6))

        tk.Label(base_frame, text="Base Stats", font=FONT_STAT_HEADING,
                 fg=FG_SECONDARY, bg=BG_CARD).pack(anchor="w")

        for stat in STAT_NAMES:
            val = pokemon.base_stats.get(stat, 0)
            row = tk.Frame(base_frame, bg=BG_CARD)
            row.pack(fill="x", pady=1)
            tk.Label(row, text=stat.upper(), font=("Consolas", 11),
                     fg=STAT_COLORS.get(stat, FG_SECONDARY), bg=BG_CARD,
                     width=4, anchor="w").pack(side="left")
            tk.Label(row, text=str(val), font=("Consolas", 11), fg=FG_PRIMARY,
                     bg=BG_CARD, width=4, anchor="e").pack(side="left", padx=(0, 8))
            bar_bg = tk.Frame(row, bg=BG_INPUT, height=12)
            bar_bg.pack(side="left", fill="x", expand=True)
            bar_bg.pack_propagate(False)
            # Use relwidth so bar scales with container
            ratio = min(val, 200) / 200.0
            bar_fill = tk.Frame(bar_bg, bg=_stat_bar_color(val, 200))
            bar_fill.place(x=0, y=0, relheight=1.0, relwidth=ratio)
        
        bst_row = tk.Frame(base_frame, bg=BG_CARD)
        bst_row.pack(fill="x", pady=(4, 0))
        tk.Label(bst_row, text="BST", font=("Consolas", 11, "bold"),
                 fg=NEON_YELLOW, bg=BG_CARD, width=4, anchor="w").pack(side="left")
        tk.Label(bst_row, text=str(pokemon.bst), font=("Consolas", 11, "bold"),
                 fg=NEON_YELLOW, bg=BG_CARD, width=4, anchor="e").pack(side="left", padx=(0, 8))
        bst_bg = tk.Frame(bst_row, bg=BG_INPUT, height=12)
        bst_bg.pack(side="left", fill="x", expand=True)
        bst_bg.pack_propagate(False)

        # Computed stats (right) — updates on set selection
        self._computed_frame = tk.Frame(stats_wrap, bg=BG_CARD, padx=12, pady=8)
        self._computed_frame.pack(side="right", fill="both", expand=True, padx=(6, 0))

        tk.Label(self._computed_frame, text="Computed (Lv.100) — select a set",
                 font=FONT_STAT_HEADING, fg=FG_DIM, bg=BG_CARD).pack(anchor="w")

        self._computed_labels: dict[str, tk.Label] = {}
        self._computed_bars: dict[str, tk.Frame] = {}
        self._computed_bar_bgs: dict[str, tk.Frame] = {}  # parent bg frames
        for stat in STAT_NAMES:
            row = tk.Frame(self._computed_frame, bg=BG_CARD)
            row.pack(fill="x", pady=1)
            tk.Label(row, text=stat.upper(), font=("Consolas", 11),
                     fg=STAT_COLORS.get(stat, FG_SECONDARY), bg=BG_CARD,
                     width=4, anchor="w").pack(side="left")
            vl = tk.Label(row, text="—", font=("Consolas", 11), fg=FG_PRIMARY,
                          bg=BG_CARD, width=4, anchor="e")
            vl.pack(side="left", padx=(0, 8))
            self._computed_labels[stat] = vl
            bar_bg = tk.Frame(row, bg=BG_INPUT, height=12)
            bar_bg.pack(side="left", fill="x", expand=True)
            bar_bg.pack_propagate(False)
            self._computed_bar_bgs[stat] = bar_bg
            # Create bar fill with relwidth=0 initially, update on set select
            bf = tk.Frame(bar_bg, bg=FG_DIM)
            bf.place(x=0, y=0, relheight=1.0, relwidth=0.001)
            self._computed_bars[stat] = bf

        self._computed_bst_label = tk.Label(self._computed_frame, text="BST: —",
                                             font=("Consolas", 11, "bold"), fg=NEON_YELLOW, bg=BG_CARD)
        self._computed_bst_label.pack(anchor="w", pady=(4, 0))

        # ── Sets ────────────────────────────────────────────────────
        sh = tk.Frame(self._detail_inner, bg=BG_DARK)
        sh.pack(fill="x", padx=16, pady=(16, 4))
        tk.Label(sh, text="Sets", font=FONT_HEADING, fg=FG_PRIMARY, bg=BG_DARK).pack(side="left")
        tk.Button(sh, text="+ Add New Set", font=FONT_BUTTON, fg=NEON_GREEN, bg=BG_CARD,
                  activebackground=BG_HOVER, activeforeground=NEON_GREEN, bd=0, cursor="hand2",
                  command=lambda: self._open_set_editor(pokemon_id, None)).pack(side="right")

        self._set_card_frames: dict[str, tk.Frame] = {}
        for s in sets:
            self._create_set_card(pokemon, s)
        if sets:
            self._select_set(sets[0].id)

        # ── Matchup Rankings (side-by-side) ─────────────────────────
        self._build_matchup_rankings(pokemon, sets)

    def _select_set(self, set_id: str):
        self._selected_set_id = set_id
        for sid, frame in self._set_card_frames.items():
            frame.config(bg=BG_SELECTED if sid == set_id else BG_CARD)
        stats = self._stats_cache.get(set_id)
        if stats:
            for stat in STAT_NAMES:
                val = stats.get(stat)
                self._computed_labels[stat].config(text=str(val))
                ratio = min(val, 500) / 500.0
                color = _stat_bar_color(val, 500)
                self._computed_bars[stat].config(bg=color)
                self._computed_bars[stat].place_configure(relwidth=ratio)
            self._computed_bst_label.config(text=f"BST: {stats.bst}")
    def _toggle_primary(self, pokemon_id: str, set_id: str):
        """Toggle the primary set for a Pokémon."""
        pokemon = self.kg.get_pokemon(pokemon_id)
        if not pokemon:
            return
        if pokemon.primary_set_id == set_id:
            pokemon.primary_set_id = ""
        else:
            pokemon.primary_set_id = set_id
        # Update graph node data
        if self.kg.graph.has_node(pokemon_id):
            self.kg.graph.nodes[pokemon_id]["data"] = pokemon.to_dict()
        # Rebuild detail panel to reflect star change
        self._select_pokemon(pokemon_id)
    def _create_set_card(self, pokemon, set_obj):
        card = tk.Frame(self._detail_inner, bg=BG_CARD, padx=12, pady=8, cursor="hand2")
        card.pack(fill="x", padx=16, pady=4)
        self._set_card_frames[set_obj.id] = card

        top = tk.Frame(card, bg=BG_CARD)
        top.pack(fill="x")
        # Star toggle (primary set indicator)
        pokemon_obj = self.kg.get_pokemon(set_obj.pokemon_id)
        is_primary = pokemon_obj and pokemon_obj.primary_set_id == set_obj.id
        star_text = "★" if is_primary else "☆"
        star_color = STAR_ACTIVE if is_primary else STAR_INACTIVE
        star_btn = tk.Label(top, text=star_text, font=("Consolas", 16),
                             fg=star_color, bg=BG_CARD, cursor="hand2")
        star_btn.pack(side="left", padx=(0, 8))
        star_btn.bind("<Button-1>", lambda e, sid=set_obj.id, pid=set_obj.pokemon_id: self._toggle_primary(pid, sid))
        tk.Label(top, text=set_obj.set_name, font=FONT_HEADING, fg=FG_PRIMARY,
                 bg=BG_CARD).pack(side="left")
        rc = ROLE_COLORS.get(set_obj.role, FG_DIM)
        tk.Label(top, text=set_obj.role, font=FONT_SMALL, fg=BG_DARK, bg=rc,
                 padx=6, pady=1).pack(side="left", padx=(8, 0))

        stats = self._stats_cache.get(set_obj.id)
        if stats:
            tk.Label(top, text=f"Spe:{stats.spe}", font=FONT_SMALL,
                     fg=STAT_COLORS["spe"], bg=BG_CARD).pack(side="left", padx=(12, 0))

        bf = tk.Frame(top, bg=BG_CARD)
        bf.pack(side="right")
        for text, color, cmd in [("Edit", NEON_CYAN, lambda s=set_obj.id: self._open_set_editor(pokemon.id, s)),
                                   ("Delete", NEON_RED, lambda s=set_obj.id: self._delete_set(pokemon.id, s))]:
            tk.Button(bf, text=text, font=FONT_SMALL, fg=color, bg=BG_INPUT,
                      activebackground=BG_HOVER, activeforeground=color, bd=0,
                      cursor="hand2", padx=8, command=cmd).pack(side="left", padx=2)

        info = tk.Frame(card, bg=BG_CARD)
        info.pack(fill="x", pady=(4, 0))
        ability = self.kg.get_ability(set_obj.ability)
        item = self.kg.get_item(set_obj.item)
        tk.Label(info, text=f"{item.name if item else set_obj.item}  ·  "
                            f"{ability.name if ability else set_obj.ability}  ·  "
                            f"{set_obj.nature.name}  ·  {set_obj.evs.label or set_obj.evs._auto_label()}",
                 font=FONT_BODY, fg=FG_SECONDARY, bg=BG_CARD).pack(side="left")

        mf = tk.Frame(card, bg=BG_CARD)
        mf.pack(fill="x", pady=(4, 0))
        for mid in set_obj.moves:
            move = self.kg.get_move(mid)
            name = move.name if move else mid
            bp = f" ({move.base_power})" if move and move.base_power > 0 else ""
            mc = NEON_CYAN if move and move.is_status else FG_PRIMARY
            tk.Label(mf, text=f"{name}{bp}", font=FONT_SMALL, fg=mc,
                     bg=BG_INPUT, padx=6, pady=2).pack(side="left", padx=(0, 4))

        card.bind("<Button-1>", lambda e, s=set_obj.id: self._select_set(s))

    # ── Matchup Rankings (side-by-side, lazy loaded) ────────────────

    def _build_matchup_rankings(self, pokemon, sets):
        if not sets: return

        self._matchup_data: dict[str, dict] = {}  # cache

        header = tk.Frame(self._detail_inner, bg=BG_DARK)
        header.pack(fill="x", padx=16, pady=(24, 4))
        tk.Label(header, text="Matchup Rankings (per species)",
                 font=FONT_HEADING, fg=FG_PRIMARY, bg=BG_DARK).pack(side="left")

        active = sets[0]
        self._matchup_container = tk.Frame(self._detail_inner, bg=BG_DARK)
        self._matchup_container.pack(fill="both", expand=True, padx=16, pady=(4, 12))

        self._render_matchups(active)

    def _render_matchups(self, set_obj):
        for w in self._matchup_container.winfo_children(): w.destroy()

        pokemon = self.kg.get_pokemon(set_obj.pokemon_id)
        if not pokemon:
            return

        if self._matchup_cache is None:
            # Fallback to on-the-fly computation if no cache
            from pokeredus.graph.analytics import aggregate_matchups_by_species
            best = aggregate_matchups_by_species(self.kg, set_obj.id, direction="offense")
            worst = aggregate_matchups_by_species(self.kg, set_obj.id, direction="defense")
            self._render_matchups_legacy(set_obj, best, worst)
            return

        our_id = set_obj.pokemon_id

        # Get all cached matchups for our pokemon
        offense_entries = self._matchup_cache.get_all_by(our_id)
        defense_entries = self._matchup_cache.get_all_against(our_id)

        # Aggregate by species — pick best matchup per opponent species
        best = self._aggregate_cache_matchups(offense_entries, direction="offense")
        worst = self._aggregate_cache_matchups(defense_entries, direction="defense")

        # Cache data for detail lookups
        self._matchup_data = {}

        cols = tk.Frame(self._matchup_container, bg=BG_DARK)
        cols.pack(fill="both", expand=True)

        left = tk.Frame(cols, bg=BG_DARK)
        left.pack(side="left", fill="both", expand=True, padx=(0, 8))
        self._build_matchup_column(left, "Best Matchups (we win)", best[:MATCHUP_LOAD_INITIAL],
                                    best, positive=True)

        right = tk.Frame(cols, bg=BG_DARK)
        right.pack(side="right", fill="both", expand=True, padx=(8, 0))
        self._build_matchup_column(right, "Worst Matchups (we lose)", worst[:MATCHUP_LOAD_INITIAL],
                                    worst, positive=False)

    def _aggregate_cache_matchups(self, entries: list[CachedMatchup], direction: str) -> list:
        """Aggregate cached matchups per opponent species."""
        species_map: dict[str, list[CachedMatchup]] = {}
        for cm in entries:
            pid = cm.defender_id if direction == "offense" else cm.attacker_id
            if pid not in species_map:
                species_map[pid] = []
            species_map[pid].append(cm)

        result = []
        for pid, matchups in species_map.items():
            pokemon = self.kg.get_pokemon(pid)
            if not pokemon:
                continue
            # Pick the matchup with best TTK (lowest non-zero)
            valid = [m for m in matchups if m.turns_to_kill > 0]
            if not valid:
                continue
            best_m = min(valid, key=lambda m: m.turns_to_kill)
            result.append((pokemon, best_m))

        # Sort by TTK (best first for offense, also best first for defense since lower = more dangerous)
        result.sort(key=lambda x: x[1].turns_to_kill)
        return result

    def _render_matchups_legacy(self, set_obj, best, worst):
        """Legacy matchup rendering using on-the-fly computation (fallback)."""
        self._matchup_data.clear()
        for m in best + worst:
            self._matchup_data[m.repr_set_id] = {
                "score": m.score, "our_best_move": m.our_best_move,
                "their_best_move": m.their_best_move,
                "turns_to_kill_them": m.turns_to_kill_them,
                "turns_to_kill_us": m.turns_to_kill_us,
                "speed_advantage": m.speed_advantage,
                "damage_us_to_them": m.damage_us_to_them,
                "damage_them_to_us": m.damage_them_to_us,
                "damage_range_us_str": m.damage_range_us_str,
                "damage_range_them_str": m.damage_range_them_str,
                "ttk_range_us_str": m.ttk_range_us_str,
                "ttk_range_them_str": m.ttk_range_them_str,
                "damage_pct_us_lo": m.damage_pct_us_lo,
                "damage_pct_us_hi": m.damage_pct_us_hi,
                "damage_pct_them_lo": m.damage_pct_them_lo,
                "damage_pct_them_hi": m.damage_pct_them_hi,
                "min_ttk_us": m.min_ttk_us,
                "max_ttk_us": m.max_ttk_us,
                "min_ttk_them": m.min_ttk_them,
                "max_ttk_them": m.max_ttk_them,
                "our_set_id": set_obj.id,
                "their_set_id": m.repr_set_id,
                "pokemon_name": m.pokemon_name,
            }

        cols = tk.Frame(self._matchup_container, bg=BG_DARK)
        cols.pack(fill="both", expand=True)

        left = tk.Frame(cols, bg=BG_DARK)
        left.pack(side="left", fill="both", expand=True, padx=(0, 8))
        self._build_legacy_matchup_column(left, "Best Matchups (we win)", best[:MATCHUP_LOAD_INITIAL],
                                           best, positive=True)

        right = tk.Frame(cols, bg=BG_DARK)
        right.pack(side="right", fill="both", expand=True, padx=(8, 0))
        self._build_legacy_matchup_column(right, "Worst Matchups (we lose)", worst[:MATCHUP_LOAD_INITIAL],
                                           worst, positive=False)

    def _build_legacy_matchup_column(self, parent, title, visible_rows, all_rows, positive):
        """Column builder for legacy SpeciesMatchup format."""
        tk.Label(parent, text=title, font=("Consolas", 12, "bold"),
                 fg=NEON_GREEN if positive else NEON_RED, bg=BG_DARK).pack(anchor="w", pady=(0, 4))

        list_frame = tk.Frame(parent, bg=BG_DARK)
        list_frame.pack(fill="both", expand=True)

        shown = [len(visible_rows)]

        def render_rows(rows):
            for r in list_frame.winfo_children(): r.destroy()
            for m in rows:
                self._create_legacy_matchup_row(list_frame, m, positive)
            if shown[0] < len(all_rows):
                more_btn = tk.Button(
                    list_frame, text=f"Show +{min(MATCHUP_LOAD_MORE, len(all_rows) - shown[0])} more",
                    font=FONT_SMALL, fg=NEON_CYAN, bg=BG_CARD, bd=0, cursor="hand2",
                    activebackground=BG_HOVER, activeforeground=NEON_CYAN,
                    command=lambda: show_more(),
                )
                more_btn.pack(fill="x", pady=2)

        def show_more():
            new_count = min(shown[0] + MATCHUP_LOAD_MORE, len(all_rows))
            shown[0] = new_count
            render_rows(all_rows[:new_count])

        render_rows(visible_rows)

    def _create_legacy_matchup_row(self, parent, m, positive):
        """Legacy matchup row for SpeciesMatchup objects."""
        row = tk.Frame(parent, bg=BG_CARD, cursor="hand2")
        row.pack(fill="x", pady=1)

        tk.Label(row, text=m.pokemon_name, font=("Consolas", 11),
                 fg=FG_PRIMARY, bg=BG_CARD, width=14, anchor="w").pack(side="left", padx=4)

        sc = MATCHUP_WIN if m.score > 0.2 else MATCHUP_LOSE if m.score < -0.2 else MATCHUP_NEUTRAL
        tk.Label(row, text=f"{m.score:+.2f}", font=("Consolas", 10), fg=sc,
                 bg=BG_CARD, width=6, anchor="e").pack(side="left", padx=4)

        ttk_t = m.ttk_range_us_str
        tk.Label(row, text=ttk_t, font=("Consolas", 10, "bold"),
                 fg=ttk_color(m.turns_to_kill_them),
                 bg=BG_CARD, width=7, anchor="center").pack(side="left", padx=2)

        ttk_u = m.ttk_range_them_str
        tk.Label(row, text=ttk_u, font=("Consolas", 10, "bold"),
                 fg=ttk_color(m.turns_to_kill_us),
                 bg=BG_CARD, width=7, anchor="center").pack(side="left", padx=2)

        spd = {"us": "Faster", "them": "Slower", "tie": "Tie"}.get(m.speed_advantage, "?")
        tk.Label(row, text=spd, font=FONT_SMALL, fg=speed_color(m.speed_advantage),
                 bg=BG_CARD, width=6, anchor="center").pack(side="left", padx=2)

        cat_c = {"counter": MATCHUP_WIN, "check": NEON_GREEN, "neutral": MATCHUP_NEUTRAL,
                 "checked_by": NEON_ORANGE, "countered_by": MATCHUP_LOSE}.get(m.category, FG_DIM)
        tk.Label(row, text=m.category, font=FONT_SMALL, fg=cat_c,
                 bg=BG_CARD, width=10, anchor="w").pack(side="left", padx=4)

        detail = tk.Frame(parent, bg=BG_INPUT)

        def toggle():
            if detail.winfo_ismapped():
                detail.pack_forget()
                row.config(bg=BG_CARD)
            else:
                for w in detail.winfo_children(): w.destroy()
                self._build_matchup_detail_legacy(detail, m)
                detail.pack(fill="x", padx=8, pady=(0, 2), after=row)
                row.config(bg=BG_SELECTED)

        row.bind("<Button-1>", lambda e: toggle())
        for c in row.winfo_children():
            c.bind("<Button-1>", lambda e: toggle())

    def _build_matchup_detail_legacy(self, parent, m):
        """Legacy expanded matchup detail for SpeciesMatchup objects."""
        inner = tk.Frame(parent, bg=BG_INPUT, padx=12, pady=8)
        inner.pack(fill="x")

        eval_text = _score_eval_text(m.score)
        eval_c = MATCHUP_WIN if m.score > 0.2 else MATCHUP_LOSE if m.score < -0.2 else MATCHUP_NEUTRAL
        tk.Label(inner, text=f"Eval: {eval_text}", font=("Consolas", 10, "bold"),
                 fg=eval_c, bg=BG_INPUT).pack(anchor="w", pady=(0, 6))

        sides = tk.Frame(inner, bg=BG_INPUT)
        sides.pack(fill="x")

        left = tk.Frame(sides, bg=BG_INPUT)
        left.pack(side="left", fill="x", expand=True)

        our_set = self.kg.get_set(self._selected_set_id) if self._selected_set_id else None
        our_pokemon = self.kg.get_pokemon(our_set.pokemon_id) if our_set else None
        if our_pokemon:
            our_api = our_pokemon.api_name or our_pokemon.id
            our_sprite = self._sprite_mgr.get_sprite(our_api, (40, 40))
            if our_sprite:
                sp = tk.Label(left, image=our_sprite, bg=BG_INPUT)
                sp.image = our_sprite
                sp.pack(anchor="w")

        tk.Label(left, text="Our offense →", font=FONT_SMALL, fg=NEON_CYAN, bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"Move: {m.our_best_move}", font=("Consolas", 11),
                 fg=FG_PRIMARY, bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"Dmg: {m.damage_range_us_str}", font=("Consolas", 11, "bold"),
                 fg=NEON_GREEN if m.damage_pct_us_hi >= 50 else NEON_YELLOW if m.damage_pct_us_hi >= 25 else FG_SECONDARY,
                 bg=BG_INPUT).pack(anchor="w")
        ttk_t = m.ttk_range_us_str
        tk.Label(left, text=f"TTK: {ttk_t}", font=("Consolas", 11),
                 fg=ttk_color(m.turns_to_kill_them), bg=BG_INPUT).pack(anchor="w")

        right = tk.Frame(sides, bg=BG_INPUT)
        right.pack(side="right", fill="x", expand=True)

        their_pokemon = self.kg.get_pokemon(m.pokemon_id)
        if their_pokemon:
            their_api = their_pokemon.api_name or their_pokemon.id
            their_sprite = self._sprite_mgr.get_sprite(their_api, (40, 40))
            if their_sprite:
                sp = tk.Label(right, image=their_sprite, bg=BG_INPUT)
                sp.image = their_sprite
                sp.pack(anchor="e")

        tk.Label(right, text="← Their offense", font=FONT_SMALL, fg=NEON_PINK, bg=BG_INPUT).pack(anchor="e")
        tk.Label(right, text=f"Move: {m.their_best_move}", font=("Consolas", 11),
                 fg=FG_PRIMARY, bg=BG_INPUT, anchor="e").pack(anchor="e")
        tk.Label(right, text=f"Dmg: {m.damage_range_them_str}", font=("Consolas", 11, "bold"),
                 fg=NEON_RED if m.damage_pct_them_hi >= 50 else NEON_YELLOW if m.damage_pct_them_hi >= 25 else FG_SECONDARY,
                 bg=BG_INPUT, anchor="e").pack(anchor="e")
        ttk_u = m.ttk_range_them_str
        tk.Label(right, text=f"TTK: {ttk_u}", font=("Consolas", 11),
                 fg=ttk_color(m.turns_to_kill_us), bg=BG_INPUT, anchor="e").pack(anchor="e")

        spd = {"us": "We are faster", "them": "They are faster", "tie": "Speed tie"}.get(m.speed_advantage, "?")
        tk.Label(inner, text=spd, font=FONT_SMALL, fg=speed_color(m.speed_advantage),
                 bg=BG_INPUT).pack(anchor="w", pady=(6, 0))

    def _build_matchup_column(self, parent, title, visible_rows, all_rows, positive):
        tk.Label(parent, text=title, font=("Consolas", 12, "bold"),
                 fg=NEON_GREEN if positive else NEON_RED, bg=BG_DARK).pack(anchor="w", pady=(0, 4))

        list_frame = tk.Frame(parent, bg=BG_DARK)
        list_frame.pack(fill="both", expand=True)

        shown = [len(visible_rows)]

        def render_rows(rows):
            for r in list_frame.winfo_children(): r.destroy()
            for entry in rows:
                self._create_matchup_row(list_frame, entry, positive)
            if shown[0] < len(all_rows):
                more_btn = tk.Button(
                    list_frame, text=f"Show +{min(MATCHUP_LOAD_MORE, len(all_rows) - shown[0])} more",
                    font=FONT_SMALL, fg=NEON_CYAN, bg=BG_CARD, bd=0, cursor="hand2",
                    activebackground=BG_HOVER, activeforeground=NEON_CYAN,
                    command=lambda: show_more(),
                )
                more_btn.pack(fill="x", pady=2)

        def show_more():
            new_count = min(shown[0] + MATCHUP_LOAD_MORE, len(all_rows))
            shown[0] = new_count
            render_rows(all_rows[:new_count])

        render_rows(visible_rows)

    def _create_matchup_row(self, parent, entry, positive):
        """Single matchup row — clicking expands detail below it."""
        pokemon, cm = entry
        row = tk.Frame(parent, bg=BG_CARD, cursor="hand2")
        row.pack(fill="x", pady=1)

        # Species name
        tk.Label(row, text=pokemon.name, font=("Consolas", 11),
                 fg=FG_PRIMARY, bg=BG_CARD, width=14, anchor="w").pack(side="left", padx=4)

        # TTK (our turns to kill them)
        ttk_val = cm.turns_to_kill
        ttk_str = f"{ttk_val}HKO" if ttk_val > 0 else "—"
        tk.Label(row, text=ttk_str, font=("Consolas", 10, "bold"),
                 fg=ttk_color(ttk_val),
                 bg=BG_CARD, width=7, anchor="center").pack(side="left", padx=2)

        # Damage range
        dmg_str = ""
        if cm.damage_pct_lo > 0:
            if abs(cm.damage_pct_lo - cm.damage_pct_hi) < 0.5:
                dmg_str = f"{cm.damage_pct_hi:.1f}%"
            else:
                dmg_str = f"{cm.damage_pct_lo:.1f} – {cm.damage_pct_hi:.1f}%"
        else:
            dmg_str = "—"
        tk.Label(row, text=dmg_str, font=("Consolas", 10),
                 fg=NEON_GREEN if cm.damage_pct_hi >= 50 else NEON_YELLOW if cm.damage_pct_hi >= 25 else FG_SECONDARY,
                 bg=BG_CARD, width=12, anchor="center").pack(side="left", padx=2)

        # Move name
        move = self.kg.get_move(cm.best_move_id)
        move_name = move.name if move else cm.best_move_id
        tk.Label(row, text=move_name, font=("Consolas", 9),
                 fg=FG_SECONDARY, bg=BG_CARD, width=12, anchor="w").pack(side="left", padx=2)

        # Type effectiveness
        eff_str = f"{cm.type_effectiveness}x" if cm.type_effectiveness > 0 else "—"
        eff_color = NEON_GREEN if cm.type_effectiveness >= 2.0 else NEON_RED if cm.type_effectiveness < 1.0 else FG_PRIMARY
        tk.Label(row, text=eff_str, font=("Consolas", 9),
                 fg=eff_color, bg=BG_CARD, width=5, anchor="center").pack(side="left", padx=2)

        # Detail container (hidden)
        detail = tk.Frame(parent, bg=BG_INPUT)

        def toggle():
            if detail.winfo_ismapped():
                detail.pack_forget()
                row.config(bg=BG_CARD)
            else:
                for w in detail.winfo_children(): w.destroy()
                self._build_cache_matchup_detail(detail, pokemon, cm)
                detail.pack(fill="x", padx=8, pady=(0, 2), after=row)
                row.config(bg=BG_SELECTED)

        row.bind("<Button-1>", lambda e: toggle())
        for c in row.winfo_children():
            c.bind("<Button-1>", lambda e: toggle())

    def _build_cache_matchup_detail(self, parent, opponent_pokemon, cm: CachedMatchup):
        """Build expanded detail for a cached matchup."""
        inner = tk.Frame(parent, bg=BG_INPUT, padx=12, pady=8)
        inner.pack(fill="x")

        move = self.kg.get_move(cm.best_move_id)
        move_name = move.name if move else cm.best_move_id

        # Two columns
        sides = tk.Frame(inner, bg=BG_INPUT)
        sides.pack(fill="x")

        # Our side
        left = tk.Frame(sides, bg=BG_INPUT)
        left.pack(side="left", fill="x", expand=True)

        our_set = self.kg.get_set(self._selected_set_id) if self._selected_set_id else None
        our_pokemon = self.kg.get_pokemon(our_set.pokemon_id) if our_set else None
        if our_pokemon:
            our_api = our_pokemon.api_name or our_pokemon.id
            our_sprite = self._sprite_mgr.get_sprite(our_api, (40, 40))
            if our_sprite:
                sp = tk.Label(left, image=our_sprite, bg=BG_INPUT)
                sp.image = our_sprite
                sp.pack(anchor="w")

        tk.Label(left, text="Our offense →", font=FONT_SMALL, fg=NEON_CYAN, bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"Move: {move_name}", font=("Consolas", 11),
                 fg=FG_PRIMARY, bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"Dmg: {cm.damage_pct_lo:.1f} – {cm.damage_pct_hi:.1f}%",
                 font=("Consolas", 11, "bold"),
                 fg=NEON_GREEN if cm.damage_pct_hi >= 50 else NEON_YELLOW,
                 bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"TTK: {cm.turns_to_kill}HKO" if cm.turns_to_kill > 0 else "TTK: —",
                 font=("Consolas", 11),
                 fg=ttk_color(cm.turns_to_kill), bg=BG_INPUT).pack(anchor="w")
        tk.Label(left, text=f"Off: {cm.offensive_stat}  vs  Def: {cm.defensive_stat}",
                 font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_INPUT).pack(anchor="w")
        stab_str = "STAB" if cm.stab else "No STAB"
        tk.Label(left, text=stab_str, font=FONT_SMALL,
                 fg=NEON_CYAN if cm.stab else FG_DIM, bg=BG_INPUT).pack(anchor="w")

        # Their side
        right = tk.Frame(sides, bg=BG_INPUT)
        right.pack(side="right", fill="x", expand=True)

        their_api = opponent_pokemon.api_name or opponent_pokemon.id
        their_sprite = self._sprite_mgr.get_sprite(their_api, (40, 40))
        if their_sprite:
            sp = tk.Label(right, image=their_sprite, bg=BG_INPUT)
            sp.image = their_sprite
            sp.pack(anchor="e")

        tk.Label(right, text="← Their defense", font=FONT_SMALL, fg=NEON_PINK, bg=BG_INPUT).pack(anchor="e")
        tk.Label(right, text=f"Type: {cm.move_type} ({cm.move_category})",
                 font=("Consolas", 11), fg=FG_PRIMARY, bg=BG_INPUT, anchor="e").pack(anchor="e")
        eff_str = f"Effectiveness: {cm.type_effectiveness}x"
        eff_color = NEON_GREEN if cm.type_effectiveness >= 2.0 else NEON_RED if cm.type_effectiveness < 1.0 else FG_PRIMARY
        tk.Label(right, text=eff_str, font=("Consolas", 11),
                 fg=eff_color, bg=BG_INPUT, anchor="e").pack(anchor="e")

    # ── Set Actions ─────────────────────────────────────────────────

    def _open_set_editor(self, pokemon_id, set_id):
        from pokeredus.gui.set_editor import SetEditorDialog
        pokemon = self.kg.get_pokemon(pokemon_id)
        existing = self.kg.get_set(set_id) if set_id else None
        dialog = SetEditorDialog(self, self.kg, pokemon, existing)
        self.wait_window(dialog)
        if self._selected_pokemon_id:
            self._select_pokemon(self._selected_pokemon_id)

    def _delete_set(self, pokemon_id, set_id):
        dlg = tk.Toplevel(self); dlg.title("Confirm Delete"); dlg.configure(bg=BG_DARK)
        dlg.geometry("300x120"); dlg.transient(self); dlg.grab_set()
        tk.Label(dlg, text="Delete set?", font=FONT_HEADING, fg=NEON_RED, bg=BG_DARK).pack(pady=(16, 8))
        bf = tk.Frame(dlg, bg=BG_DARK); bf.pack(pady=8)
        confirmed = [False]
        def ok(): confirmed[0] = True; dlg.destroy()
        tk.Button(bf, text="Delete", font=FONT_BUTTON, fg=NEON_RED, bg=BG_CARD,
                  command=ok, bd=0, padx=16).pack(side="left", padx=8)
        tk.Button(bf, text="Cancel", font=FONT_BUTTON, fg=FG_SECONDARY, bg=BG_CARD,
                  command=dlg.destroy, bd=0, padx=16).pack(side="left", padx=8)
        self.wait_window(dlg)
        if confirmed[0]:
            self.kg.remove_set(set_id)
            self._select_pokemon(pokemon_id)
