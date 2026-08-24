"""
PokeLink game-state screen — eval scores and live battle updates.

The live CLI writes `live-state.json` (or $POKELINK_STATE). This page polls
that file; it does not open a Showdown connection of its own.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import tkinter as tk

from pokeredus.gui.theme import *


def live_state_path() -> Path:
    env = os.environ.get("POKELINK_STATE")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[3] / "live-state.json"


def load_live_state(path: Path | None = None) -> dict | None:
    p = path or live_state_path()
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def species_label(species_id: str) -> str:
    return (species_id or "?").replace("-", " ").title()


def score_color(value: float) -> str:
    if value > 0.05:
        return MATCHUP_WIN
    if value < -0.05:
        return MATCHUP_LOSE
    return MATCHUP_NEUTRAL


_STATUS_COLOR = {
    "idle": FG_DIM,
    "connecting": NEON_YELLOW,
    "connected": NEON_GREEN,
    "waiting": NEON_CYAN,
    "deciding": NEON_PINK,
    "ended": NEON_ORANGE,
    "error": NEON_RED,
}


class GameStatePage(tk.Frame):
    """HUD for a connected PokeLink battle."""

    POLL_MS = 250

    def __init__(self, parent, go_home_cb, state_path: Path | None = None):
        super().__init__(parent, bg=BG_DARK)
        self._go_home = go_home_cb
        self._path = state_path or live_state_path()
        self._last_ts = ""
        self._photo_refs: list = []
        self._build_ui()
        self.after(self.POLL_MS, self._poll)

    def _build_ui(self):
        top = tk.Frame(self, bg=BG_PANEL, height=52)
        top.pack(fill="x")
        top.pack_propagate(False)
        tk.Button(
            top, text="← Back", font=FONT_BUTTON, fg=NEON_CYAN, bg=BG_PANEL,
            activebackground=BG_HOVER, activeforeground=NEON_CYAN,
            bd=0, cursor="hand2", command=self._go_home,
        ).pack(side="left", padx=12, pady=10)
        tk.Label(top, text="PokeLink", font=FONT_HEADING, fg=FG_PRIMARY, bg=BG_PANEL).pack(side="left", padx=8)
        self._status_var = tk.StringVar(value="idle")
        self._status_lbl = tk.Label(
            top, textvariable=self._status_var, font=FONT_BODY, fg=FG_DIM, bg=BG_PANEL,
        )
        self._status_lbl.pack(side="left", padx=12)
        self._meta_var = tk.StringVar(value="")
        tk.Label(top, textvariable=self._meta_var, font=FONT_SMALL, fg=FG_SECONDARY, bg=BG_PANEL).pack(
            side="right", padx=16,
        )

        body = tk.Frame(self, bg=BG_DARK)
        body.pack(fill="both", expand=True, padx=16, pady=12)
        body.grid_columnconfigure(0, weight=1, uniform="col")
        body.grid_columnconfigure(1, weight=1, uniform="col")
        body.grid_columnconfigure(2, weight=1, uniform="col")
        body.grid_rowconfigure(0, weight=2)
        body.grid_rowconfigure(1, weight=1)

        self._ours_frame = self._panel(body, "Ours")
        self._ours_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        self._eval_frame = self._panel(body, "Eval")
        self._eval_frame.grid(row=0, column=1, sticky="nsew", padx=8)
        self._theirs_frame = self._panel(body, "Theirs")
        self._theirs_frame.grid(row=0, column=2, sticky="nsew", padx=(8, 0))

        log_wrap = self._panel(body, "Live updates")
        log_wrap.grid(row=1, column=0, columnspan=3, sticky="nsew", pady=(12, 0))
        self._log = tk.Text(
            log_wrap, font=FONT_SMALL, bg=BG_INPUT, fg=FG_PRIMARY, insertbackground=FG_PRIMARY,
            bd=0, highlightthickness=0, wrap="word", state="disabled", height=8,
        )
        self._log.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        self._ours_body = tk.Frame(self._ours_frame, bg=BG_CARD)
        self._ours_body.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self._eval_body = tk.Frame(self._eval_frame, bg=BG_CARD)
        self._eval_body.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self._theirs_body = tk.Frame(self._theirs_frame, bg=BG_CARD)
        self._theirs_body.pack(fill="both", expand=True, padx=8, pady=(0, 8))

        self._show_idle()

    def _panel(self, parent, title: str) -> tk.Frame:
        frame = tk.Frame(parent, bg=BG_CARD)
        tk.Label(frame, text=title, font=FONT_HEADING, fg=NEON_CYAN, bg=BG_CARD).pack(
            anchor="w", padx=10, pady=(8, 6),
        )
        return frame

    def _clear(self, frame: tk.Frame):
        for child in frame.winfo_children():
            child.destroy()

    def _show_idle(self):
        self._status_var.set("waiting for battle")
        self._status_lbl.configure(fg=FG_DIM)
        self._meta_var.set(str(self._path.name))
        self._clear(self._ours_body)
        self._clear(self._eval_body)
        self._clear(self._theirs_body)
        tk.Label(
            self._eval_body,
            text="Launch PokeLink from Combined launch\n(GUI + PokeLink live).\nThis screen reads the connected battle.",
            font=FONT_BODY, fg=FG_SECONDARY, bg=BG_CARD, justify="left",
        ).pack(anchor="w", padx=4, pady=8)

    def _poll(self):
        if not self.winfo_exists():
            return
        if self.winfo_ismapped():
            state = load_live_state(self._path)
            ts = state.get("ts", "") if state else ""
            if state is None:
                if self._last_ts != "idle":
                    self._last_ts = "idle"
                    self._show_idle()
                    self._set_log([])
            elif ts != self._last_ts:
                self._last_ts = ts
                self._render(state)
        self.after(self.POLL_MS, self._poll)

    def _render(self, state: dict):
        status = str(state.get("status") or "idle")
        room = str(state.get("room") or "")
        turn = state.get("turn", 0)
        policy = state.get("policy") or ""
        dry = "dry-run" if state.get("dryRun") else "send"
        self._status_var.set(status)
        self._status_lbl.configure(fg=_STATUS_COLOR.get(status, FG_SECONDARY))
        field = state.get("field") or {}
        weather = field.get("weather") or "none"
        terrain = field.get("terrain") or "none"
        tr = "TR" if field.get("trickroom") else ""
        winner = state.get("winner")
        bits = [f"turn {turn}", policy, dry, f"wx {weather}", f"ter {terrain}"]
        if tr:
            bits.append(tr)
        if room:
            bits.append(room)
        if winner:
            bits.append(f"winner {winner}")
        self._meta_var.set("  ·  ".join(bits))

        self._fill_side(self._ours_body, state.get("ours") or [], NEON_CYAN)
        self._fill_side(self._theirs_body, state.get("theirs") or [], NEON_PINK)
        self._fill_eval(state.get("eval"))
        self._set_log(state.get("events") or [])

    def _fill_side(self, frame: tk.Frame, slots: list, accent: str):
        self._clear(frame)
        if not slots:
            tk.Label(frame, text="(none revealed)", font=FONT_SMALL, fg=FG_DIM, bg=BG_CARD).pack(anchor="w")
            return
        for slot in slots:
            row = tk.Frame(frame, bg=BG_CARD)
            row.pack(fill="x", pady=4)
            name = species_label(str(slot.get("speciesId") or "?"))
            if slot.get("active"):
                name = "● " + name
            hp = int(slot.get("hp") or 0)
            max_hp = max(int(slot.get("maxHp") or 0), 1)
            status = str(slot.get("status") or "")
            fainted = bool(slot.get("fainted"))
            fg = FG_DIM if fainted else FG_PRIMARY
            header = f"{name}  {hp}/{max_hp}"
            if status:
                header += f"  {status}"
            tk.Label(row, text=header, font=FONT_BODY, fg=fg, bg=BG_CARD, anchor="w").pack(fill="x")
            ratio = 0 if fainted else max(0.0, min(1.0, hp / max_hp))
            color = NEON_RED if ratio < 0.25 else (NEON_YELLOW if ratio < 0.5 else accent)
            bar = tk.Frame(row, bg=BG_INPUT, height=8)
            bar.pack(fill="x", pady=(2, 0))
            bar.pack_propagate(False)
            tk.Frame(bar, bg=color, height=8).place(relx=0, rely=0, relwidth=ratio, relheight=1)

    def _fill_eval(self, ev: dict | None):
        self._clear(self._eval_body)
        if not ev:
            tk.Label(
                self._eval_body, text="No eval yet this battle.",
                font=FONT_BODY, fg=FG_DIM, bg=BG_CARD,
            ).pack(anchor="w")
            return
        round_score = float(ev.get("roundScore") or 0)
        tk.Label(
            self._eval_body,
            text=f"roundScore  {round_score:+.3f}",
            font=FONT_HEADING, fg=score_color(round_score), bg=BG_CARD,
        ).pack(anchor="w", pady=(0, 4))
        mate = ev.get("forcedOutcome") or "none"
        p_mate = float(ev.get("mateProbability") or 0)
        tk.Label(
            self._eval_body,
            text=f"mate {mate}   p={p_mate:.3f}",
            font=FONT_BODY, fg=FG_SECONDARY, bg=BG_CARD,
        ).pack(anchor="w")
        sampled = ev.get("sampledAction") or ""
        tk.Label(
            self._eval_body,
            text=f"sampled  {sampled}",
            font=FONT_BODY_BOLD, fg=NEON_GREEN, bg=BG_CARD,
        ).pack(anchor="w", pady=(4, 8))
        for choice in ev.get("choices") or []:
            cid = choice.get("id") or ""
            tag = f"cta={choice['cta']:.3f}" if choice.get("cta") is not None else (
                f"cts={choice['cts']:.3f}" if choice.get("cts") is not None else ""
            )
            impact = float(choice.get("expectedImpact") or 0)
            score = float(choice.get("choiceScore") or 0)
            prob = choice.get("probability")
            mark = ">" if cid == sampled else " "
            line = f"{mark} [{cid}] {tag}  impact={impact:+.3f}  choice={score:+.3f}"
            if isinstance(prob, (int, float)):
                line += f"  p={prob:.3f}"
            fg = NEON_GREEN if cid == sampled else FG_PRIMARY
            tk.Label(
                self._eval_body, text=line, font=FONT_SMALL, fg=fg, bg=BG_CARD, anchor="w",
            ).pack(fill="x")

    def _set_log(self, events: list):
        lines = []
        for ev in events:
            if isinstance(ev, dict):
                ts = str(ev.get("ts") or "")
                clock = ts[11:19] if len(ts) >= 19 else ts
                text = ev.get("text") or ""
                lines.append(f"{clock}  {text}" if clock else str(text))
            else:
                lines.append(str(ev))
        blob = "\n".join(lines) if lines else "(no updates yet)"
        self._log.configure(state="normal")
        self._log.delete("1.0", "end")
        self._log.insert("1.0", blob)
        self._log.see("end")
        self._log.configure(state="disabled")
