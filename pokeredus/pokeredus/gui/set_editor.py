"""
Set editor dialog — create or edit a Pokémon set.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk
from typing import TYPE_CHECKING

from pokeredus.gui.theme import *
from pokeredus.classes import (
    SetClass, NatureClass, EVSpreadClass,
)
from pokeredus.classes.natures import STANDARD_NATURES
from pokeredus.graph.matchup_engine import compute_matchup

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.classes import PokemonClass


class SetEditorDialog(tk.Toplevel):
    """Modal dialog for creating or editing a Pokémon set."""

    def __init__(self, parent, kg: KnowledgeGraph, pokemon: PokemonClass, existing: SetClass | None):
        super().__init__(parent)
        self.kg = kg
        self.pokemon = pokemon
        self.existing = existing
        self.result: SetClass | None = None

        title = f"Edit Set — {pokemon.name}" if existing else f"New Set — {pokemon.name}"
        self.title(title)
        self.configure(bg=BG_DARK)
        self.geometry("600x720")
        self.transient(parent)
        self.grab_set()

        self._build_form()

        if existing:
            self._populate_existing()

    def _build_form(self):
        form = tk.Frame(self, bg=BG_DARK, padx=20, pady=16)
        form.pack(fill="both", expand=True)

        # ── Set Name ────────────────────────────────────────────────
        self._add_label(form, "Set Name", 0)
        self._name_var = tk.StringVar()
        self._name_entry = self._add_entry(form, self._name_var, 1)

        # ── Ability ─────────────────────────────────────────────────
        self._add_label(form, "Ability", 2)
        ability_names = []
        self._ability_map: dict[str, str] = {}
        for aid in self.pokemon.abilities:
            ab = self.kg.get_ability(aid)
            display = ab.name if ab else aid
            ability_names.append(display)
            self._ability_map[display] = aid
        self._ability_var = tk.StringVar()
        self._ability_cb = self._add_combobox(form, self._ability_var, ability_names, 3)

        # ── Item ────────────────────────────────────────────────────
        self._add_label(form, "Item", 4)
        item_names = sorted([item.name for item in self.kg.get_all_items()])
        self._item_map: dict[str, str] = {}
        for item in self.kg.get_all_items():
            self._item_map[item.name] = item.id
        self._item_var = tk.StringVar()
        self._item_cb = self._add_combobox(form, self._item_var, item_names, 5)

        # ── Nature ──────────────────────────────────────────────────
        self._add_label(form, "Nature", 6)
        nature_names = [n.name for n in STANDARD_NATURES]
        self._nature_var = tk.StringVar()
        self._nature_cb = self._add_combobox(form, self._nature_var, nature_names, 7)

        # ── Tera Type ───────────────────────────────────────────────
        self._add_label(form, "Tera Type", 8)
        self._tera_var = tk.StringVar()
        self._tera_cb = self._add_combobox(
            form, self._tera_var, [""] + list(TYPE_COLORS.keys()), 9)

        # ── Role ────────────────────────────────────────────────────
        self._add_label(form, "Role", 10)
        self._role_var = tk.StringVar()
        self._role_cb = self._add_combobox(form, self._role_var, list(ROLE_COLORS.keys()), 11)

        # ── EVs ─────────────────────────────────────────────────────
        self._add_label(form, "EVs", 12)
        ev_frame = tk.Frame(form, bg=BG_DARK)
        ev_frame.grid(row=13, column=0, columnspan=2, sticky="ew", pady=(0, 8))

        self._ev_vars: dict[str, tk.StringVar] = {}
        for i, (stat, label) in enumerate([
            ("hp", "HP"), ("atk", "Atk"), ("def", "Def"),
            ("spa", "SpA"), ("spd", "SpD"), ("spe", "Spe"),
        ]):
            col = i % 3
            row = i // 3
            sf = tk.Frame(ev_frame, bg=BG_DARK)
            sf.grid(row=row, column=col, padx=4, pady=2, sticky="ew")

            tk.Label(sf, text=label, font=FONT_SMALL, fg=STAT_COLORS.get(stat, FG_SECONDARY),
                     bg=BG_DARK, width=3).pack(side="left")

            var = tk.StringVar(value="0")
            self._ev_vars[stat] = var
            entry = tk.Entry(sf, textvariable=var, font=FONT_BODY, bg=BG_INPUT, fg=FG_PRIMARY,
                             insertbackground=FG_PRIMARY, relief="flat", width=5, justify="center")
            entry.pack(side="left", padx=(4, 0))

        for i in range(3):
            ev_frame.columnconfigure(i, weight=1)

        # ── Moves ───────────────────────────────────────────────────
        self._add_label(form, "Moves", 14)
        moves_frame = tk.Frame(form, bg=BG_DARK)
        moves_frame.grid(row=15, column=0, columnspan=2, sticky="ew", pady=(0, 8))

        # Build move list from learnset (all moves in graph for now)
        all_move_names = sorted([m.name for m in self.kg.get_all_moves()])
        self._move_map: dict[str, str] = {}
        for m in self.kg.get_all_moves():
            self._move_map[m.name] = m.id

        self._move_vars: list[tk.StringVar] = []
        for i in range(4):
            tk.Label(moves_frame, text=f"Move {i+1}", font=FONT_SMALL, fg=FG_SECONDARY,
                     bg=BG_DARK).grid(row=i, column=0, sticky="w", padx=(0, 8), pady=2)
            var = tk.StringVar()
            self._move_vars.append(var)
            cb = ttk.Combobox(moves_frame, textvariable=var, values=all_move_names,
                              font=FONT_BODY, width=24)
            cb.grid(row=i, column=1, sticky="ew", pady=2)
            moves_frame.columnconfigure(1, weight=1)

        # ── Buttons ─────────────────────────────────────────────────
        btn_frame = tk.Frame(form, bg=BG_DARK)
        btn_frame.grid(row=16, column=0, columnspan=2, pady=(16, 0))

        save_btn = tk.Button(
            btn_frame, text="Save", font=FONT_BUTTON, fg=BG_DARK, bg=NEON_GREEN,
            activebackground=NEON_GREEN, activeforeground=BG_DARK,
            bd=0, padx=24, pady=6, cursor="hand2", command=self._save,
        )
        save_btn.pack(side="left", padx=8)

        cancel_btn = tk.Button(
            btn_frame, text="Cancel", font=FONT_BUTTON, fg=FG_SECONDARY, bg=BG_CARD,
            activebackground=BG_HOVER, activeforeground=FG_PRIMARY,
            bd=0, padx=24, pady=6, cursor="hand2", command=self.destroy,
        )
        cancel_btn.pack(side="left", padx=8)

        # Configure grid
        form.columnconfigure(1, weight=1)

    def _add_label(self, parent, text, row):
        tk.Label(parent, text=text, font=FONT_BODY, fg=FG_SECONDARY, bg=BG_DARK).grid(
            row=row, column=0, sticky="w", pady=(4, 0))

    def _add_entry(self, parent, var, row):
        entry = tk.Entry(parent, textvariable=var, font=FONT_BODY, bg=BG_INPUT,
                         fg=FG_PRIMARY, insertbackground=FG_PRIMARY, relief="flat")
        entry.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8), ipady=4)
        return entry

    def _add_combobox(self, parent, var, values, row):
        cb = ttk.Combobox(parent, textvariable=var, values=values, font=FONT_BODY, state="normal")
        cb.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, 8))
        return cb

    def _populate_existing(self):
        s = self.existing
        self._name_var.set(s.set_name)

        # Ability
        ab = self.kg.get_ability(s.ability)
        self._ability_var.set(ab.name if ab else s.ability)

        # Item
        item = self.kg.get_item(s.item)
        self._item_var.set(item.name if item else s.item)

        # Nature
        self._nature_var.set(s.nature.name)

        # Tera
        self._tera_var.set(s.tera_type)

        # Role
        self._role_var.set(s.role)

        # EVs
        for stat in ["hp", "atk", "def", "spa", "spd", "spe"]:
            self._ev_vars[stat].set(str(s.evs.get(stat)))

        # Moves
        for i, mid in enumerate(s.moves[:4]):
            move = self.kg.get_move(mid)
            self._move_vars[i].set(move.name if move else mid)

    # ── Save ────────────────────────────────────────────────────────

    def _save(self):
        # Validate
        name = self._name_var.get().strip()
        if not name:
            return

        ability_display = self._ability_var.get()
        ability_id = self._ability_map.get(ability_display, ability_display.lower().replace(" ", "-"))

        item_display = self._item_var.get()
        item_id = self._item_map.get(item_display, item_display.lower().replace(" ", "-"))

        nature_name = self._nature_var.get()
        nature = None
        for n in STANDARD_NATURES:
            if n.name == nature_name:
                nature = n
                break
        if not nature:
            nature = NatureClass(nature_name)

        # EVs
        evs_dict = {}
        for stat in ["hp", "atk", "def", "spa", "spd", "spe"]:
            try:
                evs_dict[stat] = int(self._ev_vars[stat].get())
            except ValueError:
                evs_dict[stat] = 0

        evs = EVSpreadClass(
            hp=evs_dict["hp"], atk=evs_dict["atk"], def_=evs_dict["def"],
            spa=evs_dict["spa"], spd=evs_dict["spd"], spe=evs_dict["spe"],
        )

        # Moves
        moves = []
        for var in self._move_vars:
            display = var.get().strip()
            if display:
                mid = self._move_map.get(display, display.lower().replace(" ", "-"))
                moves.append(mid)

        # Build ID
        if self.existing:
            set_id = self.existing.id
        else:
            slug = name.lower().replace(" ", "-").replace("+", "plus")
            set_id = f"{self.pokemon.id}_{slug}"

        set_obj = SetClass(
            id=set_id,
            pokemon_id=self.pokemon.id,
            set_name=name,
            ability=ability_id,
            item=item_id,
            nature=nature,
            evs=evs,
            moves=moves[:4],
            role=self._role_var.get(),
            tera_type=self._tera_var.get(),
        )

        # Add to graph
        self.kg.add_set(set_obj)

        # Recompute matchups for this set
        for other in self.kg.get_all_sets():
            if other.id == set_obj.id:
                continue
            mu = compute_matchup(set_obj, other, self.kg)
            self.kg.add_matchup(mu)
            mu2 = compute_matchup(other, set_obj, self.kg)
            self.kg.add_matchup(mu2)

        self.result = set_obj
        self.destroy()
