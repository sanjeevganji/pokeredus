"""Sliders for the 12 tunables of AttributeTuning.

Layout: 4 base-axis weights, 4 compound multipliers.  All sliders
write back to a single AttributeTuning instance and fire
``on_change(tuning)`` on every change.

The polynomial-scaling parameters (k, p) for each axis are kept
constant at 1.0 for now — they're an internal calibration detail;
exposing them in a "v2" advanced panel.
"""
from __future__ import annotations

import tkinter as tk
from pokeredus.graph.attribute_engine import AttributeTuning


SLIDER_MIN, SLIDER_MAX = 0, 100    # raw slider value
SLIDER_SCALE = 1.0               # maps slider 0..100 to 0.0..100.0


def format_slider_value(v: float) -> int:
    return int(round(max(SLIDER_MIN, min(SLIDER_MAX, v * SLIDER_SCALE))))


def parse_slider_value(s) -> float:
    return int(float(s)) / SLIDER_SCALE


# (label, AttributeTuning field name, default value)
SLIDER_SPECS: list[tuple[str, str, float]] = [
    ("Attack amp",    "axis_attack",    100.0),
    ("Utility amp",   "axis_utility",   100.0),
    ("Defense amp",   "axis_defense",   100.0),
    ("Speed amp",     "axis_speed",     100.0),
    ("Counter amp",   "compound_counter", 100.0),
    ("Sponge amp",    "compound_sponge",  100.0),
    ("Threat amp",    "compound_threat",  100.0),
    ("Punish amp",    "compound_punish",  100.0),
]


class AttributeTuner(tk.Frame):
    """8 sliders for the axis weights + compound multipliers.

    The ``on_change`` callback fires every time the user moves a
    slider (or the tuning is set programmatically via ``set_tuning``).
    """

    def __init__(self, master, tuning: AttributeTuning | None = None,
                 on_change=None, **kw):
        super().__init__(master, **kw)
        self._tuning = tuning or AttributeTuning()
        self._on_change = on_change
        self._sliders: dict[str, tk.Scale] = {}
        self._build()

    def _build(self):
        tk.Label(self, text="Attribute tuning",
                 font=("TkFixedFont", 10, "bold"),
                 bg="#161b22", fg="#e6edf3",
                 ).grid(row=0, column=0, columnspan=3, sticky="w",
                        padx=8, pady=(6, 4))
        r = 1
        for label, attr, default in SLIDER_SPECS:
            tk.Label(self, text=label, font=("TkFixedFont", 9),
                     bg="#161b22", fg="#e6edf3",
                     ).grid(row=r, column=0, sticky="w", padx=8)
            s = tk.Scale(
                self, from_=SLIDER_MIN, to=SLIDER_MAX, orient="horizontal",
                resolution=1, length=160,
                bg="#161b22", fg="#e6edf3", troughcolor="#0d1117",
                highlightthickness=0,
                command=lambda v, a=attr: self._on_slider(a, v),
            )
            s.set(format_slider_value(getattr(self._tuning, attr, default)))
            s.grid(row=r, column=1, columnspan=2, sticky="ew", padx=4)
            self._sliders[attr] = s
            r += 1
        self.columnconfigure(1, weight=1)

    def set_tuning(self, tuning: AttributeTuning) -> None:
        self._tuning = tuning
        for attr, s in self._sliders.items():
            self._set_slider_value(attr, format_slider_value(getattr(tuning, attr)))
        self._fire()

    def _set_slider_value(self, attr: str, raw: int) -> None:
        """Programmatically set a slider, firing the on_change callback."""
        s = self._sliders[attr]
        s.set(raw)
        # tk's Scale.set() does not invoke the command callback.
        # Manually call the slider's handler so on_change fires.
        self._on_slider(attr, raw)

    def _on_slider(self, attr: str, raw) -> None:
        v = parse_slider_value(raw)
        setattr(self._tuning, attr, v)
        self._fire()

    def _fire(self) -> None:
        if self._on_change is not None:
            self._on_change(self._tuning)
