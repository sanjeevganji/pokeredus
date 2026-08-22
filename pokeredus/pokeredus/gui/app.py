"""
PokeRedus GUI — main application with title screen and page navigation.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
import math
import time

from pokeredus.gui.theme import *
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.matchup_cache import MatchupCache


# ═══════════════════════════════════════════════════════════════════════
# CACHE PROGRESS DIALOG
# ═══════════════════════════════════════════════════════════════════════

class CacheProgressDialog(tk.Toplevel):
    """Modal dialog showing cache build / rebuild progress."""

    def __init__(self, parent, title="Building Matchup Cache"):
        super().__init__(parent)
        self.title(title)
        self.configure(bg=BG_DARK)
        self.geometry("420x180")
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()

        # Prevent close via X button
        self.protocol("WM_DELETE_WINDOW", lambda: None)

        self._build_ui()
        self._start_time = time.monotonic()

    def _build_ui(self):
        inner = tk.Frame(self, bg=BG_DARK, padx=24, pady=20)
        inner.pack(fill="both", expand=True)

        # Status label
        self._status_var = tk.StringVar(value="Initializing...")
        tk.Label(inner, textvariable=self._status_var,
                 font=FONT_BODY, fg=FG_PRIMARY, bg=BG_DARK).pack(anchor="w")

        # Progress bar
        self._progress = ttk.Progressbar(
            inner, orient="horizontal", length=370, mode="determinate",
            style="Neon.Horizontal.TProgressbar",
        )
        self._progress.pack(fill="x", pady=(8, 4))

        # Detail label (pair count, elapsed time)
        self._detail_var = tk.StringVar(value="")
        tk.Label(inner, textvariable=self._detail_var,
                 font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_DARK).pack(anchor="w")

        # Cache size label
        self._size_var = tk.StringVar(value="")
        tk.Label(inner, textvariable=self._size_var,
                 font=FONT_SMALL, fg=FG_DIM, bg=BG_DARK).pack(anchor="w", pady=(4, 0))

    def update_progress(self, done: int, total: int):
        """Called per matchup pair to update the display."""
        pct = int(done / max(total, 1) * 100)
        self._progress["value"] = pct
        self._status_var.set(f"Computing matchups... {pct}%")
        self._detail_var.set(f"{done:,} / {total:,} pairs")
        self.update_idletasks()

    def set_loading(self, entry_count: int):
        """Shown when loading from disk (fast)."""
        self._status_var.set(f"Loading cache ({entry_count:,} entries)...")
        self._progress["value"] = 100
        self.update_idletasks()

    def set_saving(self):
        """Shown while writing cache to disk."""
        self._status_var.set("Saving cache to disk...")
        self._detail_var.set("")
        self.update_idletasks()

    def set_done(self, entry_count: int, cache_size_str: str):
        """Called when cache is ready."""
        elapsed = time.monotonic() - self._start_time
        self._progress["value"] = 100
        self._status_var.set(f"Cache ready — {entry_count:,} matchups")
        self._detail_var.set(f"Built in {elapsed:.1f}s")
        self._size_var.set(f"Cache size: {cache_size_str}")
        self.update_idletasks()

    def close(self):
        """Destroy the dialog."""
        try:
            self.grab_release()
            self.destroy()
        except tk.TclError:
            pass


# ═══════════════════════════════════════════════════════════════════════
# MAIN APPLICATION
# ═══════════════════════════════════════════════════════════════════════

class PokeRedusApp(tk.Tk):
    """Main application window with title screen and page stack."""

    def __init__(self, kg: KnowledgeGraph):
        super().__init__()
        self.kg = kg
        self.title("PokeRedus")
        self.configure(bg=BG_DARK)
        self.minsize(WINDOW_MIN_W, WINDOW_MIN_H)
        self.geometry(f"{WINDOW_MIN_W}x{WINDOW_MIN_H}")

        # Configure ttk style for neon progress bar
        self._setup_ttk_styles()

        # Initialize matchup cache (with progress dialog if needed)
        self._init_matchup_cache()

        # Container for all pages
        self._container = tk.Frame(self, bg=BG_DARK)
        self._container.pack(fill="both", expand=True)
        self._container.grid_rowconfigure(0, weight=1)
        self._container.grid_columnconfigure(0, weight=1)

        self._pages: dict[str, tk.Frame] = {}
        self._current_page: str = ""

        # Build title screen
        self._build_title_screen()

        # Build pages (lazy — created on first visit)
        self._pokemon_page = None
        self._team_builder_page = None

    # ── TTK Styles ───────────────────────────────────────────────────

    def _setup_ttk_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(
            "Neon.Horizontal.TProgressbar",
            troughcolor=BG_INPUT,
            background=NEON_CYAN,
            darkcolor=NEON_CYAN,
            lightcolor=NEON_CYAN,
            bordercolor=BG_DARK,
            thickness=14,
        )

    # ── Cache Initialization ─────────────────────────────────────────

    def _init_matchup_cache(self):
        """Load or build the matchup cache, showing progress if building."""
        cache_path = MatchupCache.get_cache_path()

        # Fast path: try loading from disk first
        if cache_path.exists():
            try:
                import json
                with open(cache_path, "r", encoding="utf-8") as f:
                    payload = json.load(f)
                cache = MatchupCache.load(cache_path)
                if cache.is_valid(self.kg):
                    self.matchup_cache = cache
                    self._cache_size_str = MatchupCache.format_cache_file_size()
                    return
            except Exception:
                pass  # fall through to rebuild

        # Slow path: need to build — show progress dialog
        dlg = CacheProgressDialog(self, title="Building Matchup Cache")
        self.update_idletasks()

        def progress_cb(done, total):
            dlg.update_progress(done, total)

        cache = MatchupCache.load_or_build(
            self.kg, force=True, progress_cb=progress_cb,
        )

        self._cache_size_str = MatchupCache.format_cache_file_size()
        dlg.set_done(cache.size, self._cache_size_str)

        # Brief pause so user sees the "done" state, then close
        self.after(800, dlg.close)
        self.matchup_cache = cache

    # ── Title Screen ─────────────────────────────────────────────────

    def _build_title_screen(self):
        page = tk.Frame(self._container, bg=BG_DARK)
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["title"] = page

        # Page state for the matchup graph (focused team etc.)
        self._graph_focus_set_ids: list[str] = []
        self._graph_focus_team_name: str | None = None
        self._last_team_editor = None  # Track current team editor for back-nav

        # Animated canvas background
        self._title_canvas = tk.Canvas(page, bg=BG_DARK, highlightthickness=0)
        self._title_canvas.pack(fill="both", expand=True)

        # Bind resize
        self._title_canvas.bind("<Configure>", self._draw_title_screen)
        self._glow_phase = 0.0
        self._animate_glow()

        # Center frame for content
        self._title_canvas.update_idletasks()

    def _draw_title_screen(self, event=None):
        c = self._title_canvas
        c.delete("all")
        w = c.winfo_width()
        h = c.winfo_height()

        # Gradient background (dark blue → dark purple)
        steps = 40
        for i in range(steps):
            ratio = i / steps
            r = int(13 + ratio * 20)
            g = int(17 + ratio * 10)
            b = int(23 + ratio * 40)
            color = f"#{r:02x}{g:02x}{b:02x}"
            y0 = int(h * i / steps)
            y1 = int(h * (i + 1) / steps)
            c.create_rectangle(0, y0, w, y1, fill=color, outline="")

        # Title text with glow
        glow = int(120 + 80 * math.sin(self._glow_phase))
        glow_color = f"#00{glow:02x}ff"
        c.create_text(
            w // 2, h * 0.3,
            text="PokeRedus",
            font=FONT_TITLE,
            fill=NEON_CYAN,
        )
        # Subtle glow shadow
        c.create_text(
            w // 2 + 1, h * 0.3 + 1,
            text="PokeRedus",
            font=FONT_TITLE,
            fill=glow_color,
        )
        c.create_text(
            w // 2, h * 0.3 + 2,
            text="PokeRedus",
            font=FONT_TITLE,
            fill=NEON_CYAN,
        )

        # Subtitle
        c.create_text(
            w // 2, h * 0.3 + 60,
            text="Class-Based Pokémon Intelligence",
            font=FONT_SUBTITLE,
            fill=FG_SECONDARY,
        )

        # Stats line
        stats_text = (
            f"{self.kg.pokemon_count} Pokémon  ·  "
            f"{self.kg.set_count} Sets  ·  "
            f"{self.kg.matchup_count:,} Matchups"
        )
        c.create_text(
            w // 2, h * 0.3 + 95,
            text=stats_text,
            font=FONT_SMALL,
            fill=FG_DIM,
        )

        # Cache info line
        cache_entries = self.matchup_cache.size if self.matchup_cache else 0
        cache_size = getattr(self, "_cache_size_str", "N/A")
        cache_text = f"Cache: {cache_entries:,} entries  ·  {cache_size}"
        c.create_text(
            w // 2, h * 0.3 + 115,
            text=cache_text,
            font=FONT_SMALL,
            fill=NEON_GREEN,
        )

        # Navigation buttons
        buttons = [
            ("Pokémon Stats", NEON_CYAN, self._go_pokemon),
            ("Team Builder", NEON_GREEN, self._go_team_builder),
            ("Matchup Graph", NEON_PINK, self._go_matchup_graph),
        ]

        btn_w, btn_h = 160, 60
        gap = 20
        total_w = len(buttons) * btn_w + (len(buttons) - 1) * gap
        start_x = (w - total_w) // 2
        btn_y = h * 0.55

        for i, (label, color, cmd) in enumerate(buttons):
            x0 = start_x + i * (btn_w + gap)
            y0 = int(btn_y)
            x1 = x0 + btn_w
            y1 = y0 + btn_h

            # Button background with rounded corners effect
            tag = f"btn_{i}"
            c.create_rectangle(
                x0, y0, x1, y1,
                fill=BG_CARD, outline=color, width=2,
                tags=(tag,),
            )
            # Inner highlight
            c.create_rectangle(
                x0 + 2, y0 + 2, x1 - 2, y1 - 2,
                fill="", outline=color, width=1, stipple="gray25",
                tags=(tag,),
            )
            c.create_text(
                (x0 + x1) // 2, (y0 + y1) // 2,
                text=label, font=FONT_BUTTON, fill=color,
                tags=(tag,),
            )

            if cmd:
                # Bind click
                c.tag_bind(tag, "<Button-1>", lambda e, cb=cmd: cb())
                c.tag_bind(tag, "<Enter>", lambda e, t=tag, cl=color: self._hover_btn(t, cl, True))
                c.tag_bind(tag, "<Leave>", lambda e, t=tag, cl=color: self._hover_btn(t, cl, False))

    def _hover_btn(self, tag: str, color: str, entering: bool):
        c = self._title_canvas
        if entering:
            c.itemconfig(tag, fill=BG_HOVER)
        else:
            c.itemconfig(tag, fill=BG_CARD)

    def _animate_glow(self):
        self._glow_phase += 0.05
        if self._current_page == "title" or self._current_page == "":
            self._draw_title_screen()
        self.after(ANIMATION_DELAY * 3, self._animate_glow)

    # ── Navigation ───────────────────────────────────────────────────

    def _show_page(self, name: str):
        if name in self._pages:
            self._pages[name].tkraise()
            self._current_page = name

    def _go_pokemon(self):
        if self._pokemon_page is None:
            from pokeredus.gui.pokemon_panel import PokemonPage
            page = PokemonPage(self._container, self.kg, self._go_home, self.matchup_cache, self.invalidate_matchup_cache)
            page.grid(row=0, column=0, sticky="nsew")
            self._pages["pokemon"] = page
            self._pokemon_page = page
        self._show_page("pokemon")

    def _go_team_builder(self):
        if self._team_builder_page is None:
            from pokeredus.gui.team_builder import TeamManagerPage
            page = TeamManagerPage(self._container, self.kg,
                                    self._go_home, self._open_team_editor)
            page.grid(row=0, column=0, sticky="nsew")
            self._pages["team_manager"] = page
            self._team_builder_page = page
        else:
            # Refresh team list when navigating back
            self._team_builder_page._refresh_list()
        self._show_page("team_manager")

    def _open_team_editor(self, team_record):
        """Open a specific team in the editor. Called from TeamManagerPage."""
        from pokeredus.gui.team_builder import TeamBuilderPage
        # Destroy old editor if exists
        if "team_editor" in self._pages:
            self._pages["team_editor"].destroy()
        page = TeamBuilderPage(self._container, self.kg,
                                self._go_team_builder, team_record,
                                on_open_matchup_graph=self._open_matchup_graph_for_team)
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["team_editor"] = page
        self._last_team_editor = page
        self._show_page("team_editor")

    def _go_matchup_graph(self):
        """Open the main matchup graph page (full meta view)."""
        # Clear any team focus when entering from the menu
        self._graph_focus_set_ids = []
        self._graph_focus_team_name = None
        self._open_matchup_graph_page(back_to_team=False)

    def _open_matchup_graph_for_team(self, team_set_ids: list[str],
                                     team_name: str | None = None,
                                     team_record=None) -> None:
        """Open the matchup graph focused on a specific team.

        Called from the team builder's 'Open full graph' link.
        """
        self._graph_focus_set_ids = list(team_set_ids)
        self._graph_focus_team_name = team_name
        # Remember the team editor so we can return to it
        if team_record is not None:
            self._last_team_editor_record = team_record
        self._open_matchup_graph_page(back_to_team=True)

    def _open_matchup_graph_page(self, back_to_team: bool = False) -> None:
        from pokeredus.gui.matchup_graph_view import MatchupGraphPage

        # Destroy old graph page if exists
        if "matchup_graph" in self._pages:
            try:
                self._pages["matchup_graph"].destroy()
            except tk.TclError:
                pass
            self._pages.pop("matchup_graph", None)

        on_back = self._go_team_editor if back_to_team else None
        page = MatchupGraphPage(
            self._container, self.kg, self.matchup_cache,
            go_home=self._go_home,
            focus_set_ids=self._graph_focus_set_ids or None,
            focus_team_name=self._graph_focus_team_name,
            on_back_to_team=on_back,
        )
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["matchup_graph"] = page
        self._show_page("matchup_graph")

    def _go_team_editor(self) -> None:
        """Return to the last team editor if one was active."""
        if self._last_team_editor is not None and self._last_team_editor.winfo_exists():
            self._show_page("team_editor")
        else:
            self._go_team_builder()

    def _go_home(self):
        self._show_page("title")

    def invalidate_matchup_cache(self):
        """Rebuild the matchup cache with a progress indicator."""
        dlg = CacheProgressDialog(self, title="Rebuilding Cache")
        self.update_idletasks()

        def progress_cb(done, total):
            dlg.update_progress(done, total)

        self.matchup_cache = MatchupCache.load_or_build(
            self.kg, force=True, progress_cb=progress_cb,
        )
        self._cache_size_str = MatchupCache.format_cache_file_size()

        dlg.set_done(self.matchup_cache.size, self._cache_size_str)
        self.after(600, dlg.close)
