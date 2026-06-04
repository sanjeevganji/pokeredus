"""Pokemon-centric set list with collapsed rows + expand-on-click.

Data layer (testable headlessly):
    group_sets_by_pokemon(...)   → list[GroupedSet]
    sort_groups(...)             → list[GroupedSet]
    SortKey, SortOrder, GroupedSet

GUI layer (requires Tk):
    PokemonSetList(master, on_select=callback)
        .refresh(records)   # replaces the model and re-renders
        .selected_set_id → tuple[str, str] | None  (pokemon_id, set_name)
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Sequence
import tkinter as tk
from tkinter import ttk


# ── Data model (no Tk) ─────────────────────────────────────────────

class SortKey(str, Enum):
    ALPHA = "alpha"
    VOLUME = "volume"


class SortOrder(str, Enum):
    ASCENDING = "asc"
    DESCENDING = "desc"


@dataclass
class GroupedSet:
    """A Pokémon's sets, grouped together for the collapsed list view."""
    pokemon_id: str
    sets: list[tuple[str, str, float]]   # (pokemon_id, set_name, volume)

    @property
    def best_volume(self) -> float:
        return max((v for _, _, v in self.sets), default=0.0)

    @property
    def best_set_name(self) -> str:
        if not self.sets:
            return ""
        return max(self.sets, key=lambda s: s[2])[1]

    @property
    def set_count(self) -> int:
        return len(self.sets)


def group_sets_by_pokemon(records: Sequence[tuple[str, str, float]]
                          ) -> list[GroupedSet]:
    """Group (pokemon_id, set_name, volume) tuples by pokemon_id while
    preserving insertion order of the first occurrence."""
    bucket: dict[str, list[tuple[str, str, float]]] = {}
    order: list[str] = []
    for pid, sname, vol in records:
        if pid not in bucket:
            order.append(pid)
            bucket[pid] = []
        bucket[pid].append((pid, sname, vol))
    return [GroupedSet(pokemon_id=pid, sets=bucket[pid]) for pid in order]


def sort_groups(groups: list[GroupedSet],
                key: SortKey, order: SortOrder) -> list[GroupedSet]:
    if key == SortKey.ALPHA:
        s = sorted(groups, key=lambda g: g.pokemon_id)
    elif key == SortKey.VOLUME:
        s = sorted(groups, key=lambda g: g.best_volume)
    else:
        s = list(groups)
    if order == SortOrder.DESCENDING:
        s.reverse()
    return s


# ── Tk widget ──────────────────────────────────────────────────────

class PokemonSetList(tk.Frame):
    """Treeview with one row per Pokémon; double-click (or the chevron
    toggle) expands to show the sets under that Pokémon.

    Single-click on a set row fires the on_select callback with
    (pokemon_id, set_name).
    """

    def __init__(self, master,
                 on_select: Callable[[str, str], None] | None = None,
                 **kw):
        super().__init__(master, **kw)
        self._on_select = on_select
        self._groups: list[GroupedSet] = []
        self._sort_key = SortKey.ALPHA
        self._sort_order = SortOrder.ASCENDING
        self._build()

    def _build(self):
        # ── toolbar ────────────────────────────────────────────
        bar = tk.Frame(self, bg="#161b22")
        bar.pack(side="top", fill="x")
        tk.Label(bar, text="Sort:", bg="#161b22", fg="#8b949e",
                 font=("TkFixedFont", 9)).pack(side="left", padx=(8, 2))
        self._key_var = tk.StringVar(value=SortKey.ALPHA.value)
        ttk.Combobox(
            bar, textvariable=self._key_var, width=10, state="readonly",
            values=[k.value for k in SortKey],
        ).pack(side="left")
        self._order_var = tk.StringVar(value=SortOrder.ASCENDING.value)
        ttk.Combobox(
            bar, textvariable=self._order_var, width=6, state="readonly",
            values=[o.value for o in SortOrder],
        ).pack(side="left", padx=(4, 8))
        self._key_var.trace_add("write", lambda *_: self._on_sort_change())
        self._order_var.trace_add("write", lambda *_: self._on_sort_change())

        # ── tree ───────────────────────────────────────────────
        wrap = tk.Frame(self)
        wrap.pack(side="top", fill="both", expand=True)
        self._tree = ttk.Treeview(
            wrap, columns=("best", "vol"), show="tree headings",
            selectmode="browse",
        )
        self._tree.heading("#0", text="Pokémon")
        self._tree.heading("best", text="Best set")
        self._tree.heading("vol", text="Volume")
        self._tree.column("#0", width=140, anchor="w")
        self._tree.column("best", width=140, anchor="w")
        self._tree.column("vol", width=80, anchor="e")
        sb = ttk.Scrollbar(wrap, orient="vertical", command=self._tree.yview)
        self._tree.configure(yscrollcommand=sb.set)
        self._tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        # ── interactions ──────────────────────────────────────
        self._tree.bind("<Button-1>", self._on_click)
        self._tree.bind("<<TreeviewSelect>>", self._on_tree_select)

    # ── public API ──────────────────────────────────────────────
    def refresh(self, records: Sequence[tuple[str, str, float]]) -> None:
        """Replace the model with a new list of
        (pokemon_id, set_name, volume) tuples and re-render."""
        self._groups = sort_groups(
            group_sets_by_pokemon(records),
            self._sort_key, self._sort_order,
        )
        self._repopulate()

    def selected_set_id(self) -> tuple[str, str] | None:
        """Return (pokemon_id, set_name) for the currently selected
        set row, or None if a pokemon header is selected."""
        sel = self._tree.selection()
        if not sel:
            return None
        iid = sel[0]
        tags = self._tree.item(iid, "tags")
        if not tags or tags[0] != "set":
            return None
        return tags[1], tags[2]

    # ── internal ───────────────────────────────────────────────
    def _on_sort_change(self):
        try:
            self._sort_key = SortKey(self._key_var.get())
            self._sort_order = SortOrder(self._order_var.get())
        except ValueError:
            return
        self._groups = sort_groups(self._groups, self._sort_key, self._sort_order)
        self._repopulate()

    def _repopulate(self):
        for iid in self._tree.get_children(""):
            self._tree.delete(iid)
        for gi, g in enumerate(self._groups):
            pid_iid = f"p:{g.pokemon_id}"
            chevron = "▼" if gi == 0 else "▶"
            self._tree.insert(
                "", "end", iid=pid_iid,
                text=f"{chevron} {g.pokemon_id}",
                values=(g.best_set_name, f"{g.best_volume:.0f}"),
                tags=("pokemon", g.pokemon_id, ""),
                open=(gi == 0),
            )
            for pid, sname, vol in g.sets:
                sid_iid = f"s:{pid}::{sname}"
                self._tree.insert(
                    pid_iid, "end", iid=sid_iid,
                    text=f"    {sname}", values=("", f"{vol:.0f}"),
                    tags=("set", pid, sname),
                )

    def _on_click(self, event):
        iid = self._tree.identify_row(event.y)
        if not iid:
            return
        if iid.startswith("p:"):
            open_now = bool(self._tree.item(iid, "open"))
            pid = self._tree.item(iid, "tags")[1]
            new_open = not open_now
            self._tree.item(iid, open=new_open)
            self._tree.item(
                iid,
                text=("▼ " if new_open else "▶ ") + pid,
            )

    def _on_tree_select(self, _evt):
        sel = self.selected_set_id()
        if sel and self._on_select is not None:
            self._on_select(sel[0], sel[1])
