"""
PokeRedus GUI — main application with title screen and page navigation.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
import math

from pokeredus.gui.theme import *
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.matchup_cache import MatchupCache


class PokeRedusApp(tk.Tk):
    """Main application window with title screen and page stack."""

    def __init__(self, kg: KnowledgeGraph):
        super().__init__()
        self.kg = kg
        self.title("PokeRedus")
        self.configure(bg=BG_DARK)
        self.minsize(WINDOW_MIN_W, WINDOW_MIN_H)
        self.geometry(f"{WINDOW_MIN_W}x{WINDOW_MIN_H}")

        # Initialize matchup cache
        self.matchup_cache = MatchupCache.load_or_build(self.kg)

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

    # ── Title Screen ────────────────────────────────────────────────

    def _build_title_screen(self):
        page = tk.Frame(self._container, bg=BG_DARK)
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["title"] = page

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

        # Navigation buttons
        buttons = [
            ("Pokémon Stats", NEON_CYAN, self._go_pokemon),
            ("Team Builder", NEON_GREEN, self._go_team_builder),
            ("Matchup Graph", NEON_PINK, None),
        ]

        btn_w, btn_h = 200, 60
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

    # ── Navigation ──────────────────────────────────────────────────

    def _show_page(self, name: str):
        if name in self._pages:
            self._pages[name].tkraise()
            self._current_page = name

    def _go_pokemon(self):
        if self._pokemon_page is None:
            from pokeredus.gui.pokemon_panel import PokemonPage
            page = PokemonPage(self._container, self.kg, self._go_home, self.matchup_cache)
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
                                self._go_team_builder, team_record)
        page.grid(row=0, column=0, sticky="nsew")
        self._pages["team_editor"] = page
        self._show_page("team_editor")

    def _go_home(self):
        self._show_page("title")

    def invalidate_matchup_cache(self):
        """Rebuild the matchup cache (called when sets change)."""
        self.matchup_cache = MatchupCache.load_or_build(self.kg, force=True)
