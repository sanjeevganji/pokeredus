"""matchup_graph_view — 2D radial + 3D cylinder matchup-graph renderer (pure tkinter).

This is the STUB for Task 2 of the matchup-graph-3d rewrite.  The real
implementations of the geometry helpers, 2D polygon widget, 3D cylinder
widget, and combined view arrive in Tasks 11-15.

The stub module exposes the names that consumers (app.py, matchup_panel.py)
imported from the old graph_view / graph_page modules so the rest of the
app can keep booting.
"""
from __future__ import annotations

import tkinter as tk


# TODO(matchup-graph-3d): real implementation in Task 11.  This stub exists
# only so that the old consumers (matchup_panel.py, app.py) keep importing
# cleanly after we deleted graph_view.py / graph_page.py.  Replace with the
# real MatchupGraphView / MatchupGraph2D / MatchupGraph3D in Task 15.

class _MiniGraphStub(tk.Frame):
    """No-op placeholder for the old MiniGraph3DCanvas.

    Accepts the same constructor signature and the set_data(...) call, then
    just shows a placeholder label.  Visually empty but does not crash the
    team builder's matchup panel.
    """

    def __init__(self, master, kg=None, matchup_cache=None,
                 width: int = 320, height: int = 200, **kwargs):
        super().__init__(master, width=width, height=height, **kwargs)
        self.kg = kg
        self.matchup_cache = matchup_cache
        self._label = tk.Label(
            self,
            text="(graph removed — see Task 15)",
            fg="#888", bg="#0d1117",
            font=("TkFixedFont", 9),
        )
        self._label.pack(expand=True, fill="both")

    def set_data(self, set_ids=None, team_anchor_ids=None,
                 run_simulation: bool = True) -> None:
        # Intentionally a no-op; the real widget rebuilds the canvas here.
        return


MiniGraph3DCanvas = _MiniGraphStub  # alias for the old import path


class _MatchupGraphPageStub(tk.Frame):
    """No-op placeholder for the old MatchupGraphPage.

    The full page (toolbar + 2D/3D view) lands in Task 15/16.  Until then
    this just shows a banner so the app doesn't crash when the user opens
    the matchup graph from the menu or from the team builder.
    """

    def __init__(self, master, kg=None, matchup_cache=None,
                 go_home=None, focus_set_ids=None,
                 focus_team_name=None, on_back_to_team=None, **kwargs):
        super().__init__(master, **kwargs)
        tk.Label(
            self,
            text=("Matchup Graph — placeholder\n"
                  "(real view lands in Task 16 of the rewrite plan)"),
            fg="#e6edf3", bg="#0d1117",
            font=("TkFixedFont", 12, "bold"),
            justify="center",
        ).pack(expand=True, fill="both")
        if go_home is not None:
            tk.Button(self, text="Home", command=go_home).pack(side="bottom")


MatchupGraphPage = _MatchupGraphPageStub  # alias for the old import path
