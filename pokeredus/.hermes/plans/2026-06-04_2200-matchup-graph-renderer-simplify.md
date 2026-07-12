# Matchup Graph Renderer Simplification — Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Simplify the matchup-graph 2D and 3D renderers per user feedback:
1. **No zoom** — the graph must always fit its area.
2. **2D drag rotates around the central axis only** (horizontal drag = rotate; vertical drag is ignored or used to rotate too, but the polygon must stay centered).
3. **3D drag rotates around the world origin** (anchor the rotation at the world origin, not at the camera's look-at point).
4. **Scale all 8 attribute axes to 0-100 in the renderer** — currently the polygon uses raw per-type sums which can be huge; the radial length should be the per-axis scaled value (0-100) so the polygon fits in a fixed fraction of the canvas regardless of magnitude.
5. **List rows show set names only** (no volume column).

**Architecture:** Two renderers, one shared scale. Each axis has its own 0-100 value (already produced by `tune_existing_node` from the previous plan); the renderer reads the per-axis max value, divides each axis by that max, and draws the bar at `axis_value / 100 * radius` of the canvas. The auto-fit uses `min(w, h) * 0.40` for the polygon radius (no zoom state, no zoom key bindings).

**Tech Stack:** Python 3.11, tkinter (Canvas), numpy. Reuses `pokeredus.graph.attribute_engine` for the 0-100 scaling.

---

## Current State (Recap)

- `MatchupGraph2D` has `ZOOM_MIN/MAX/STEP`, `_zoom_by()`, wheel + arrow-key zoom bindings, and `_reset_view()` that resets zoom. The 2D drag uses `dx*0.01` + `dy*0.01` for rotation.
- `MatchupGraph3D` has wheel zoom (changes `cam.distance`), drag rotates yaw + pitch with a look-at point at `(0, 0, center_z)`. Disc radii come from `disc_radius()` which uses the **raw per-type compound area** (not 0-100).
- `MatchupGraphView` shows a "Switch to 2D / 3D" button at the top of the graph pane.
- The 2D redraw uses `sums = [attributes[i].sum() for i in range(8)]` (raw, un-scaled) and multiplies by `min(w, h) * 0.35 * self.zoom` to get the radius. This means the polygon is not bounded — large raw sums blow past the canvas.

## Files

- Modify: `pokeredus/gui/matchup_graph_view.py` (2D + 3D widget bodies, and remove zoom from helpers)
- Modify: `pokeredus/gui/pokemon_set_list.py` (drop the "best set" + "volume" columns, show just `name` per set)
- Test: `tests/test_matchup_graph_view.py` (replace zoom tests with fit-to-canvas tests)
- Test: `tests/test_pokemon_set_list.py` (update column expectations)
- (Optional) Add: `tests/test_matchup_graph_renderer_fit.py` — new test file for the fit-to-canvas invariant.

---

## Task 1: Auto-fit scale in the 2D renderer (no zoom)

**Files:**
- Modify: `pokeredus/gui/matchup_graph_view.py` — `MatchupGraph2D._redraw()`
- Test: `tests/test_matchup_graph_view.py`

**Step 1: Write failing test**

```python
# tests/test_matchup_graph_view.py — add new test
def test_2d_polygon_fits_canvas_for_large_attributes():
    """Even with per-type sums of 1e6, the 2D polygon must fit inside
    the canvas (no zoom, auto-fit scale)."""
    from pokeredus.gui.matchup_graph_view import MatchupGraph2D
    import numpy as np
    root = tk.Tk(); root.withdraw()
    try:
        v = MatchupGraph2D(root, sets_dir=".")
        # Fake node with huge sums.
        n = type("N", (), {})()
        n.attributes = np.ones((8, 18), dtype=np.float32) * 1e6
        n.vase_order = list(range(18))
        n.bias = 1.0
        v.set_node(n)
        v.canvas.update_idletasks()
        v.canvas.config(width=400, height=300)
        v._redraw()
        # Every canvas item should be within the canvas bounding box.
        bbox = v.canvas.bbox("all")
        assert bbox is not None
        x0, y0, x1, y1 = bbox
        assert x0 >= 0 and y0 >= 0
        assert x1 <= 400 and y1 <= 300
    finally:
        root.destroy()
```

**Step 2: Implement the new `_redraw` (no zoom, per-axis scale)**

Replace `MatchupGraph2D._redraw()` body so:
- It reads the **per-axis scaled value** (0-100) from the engine:
  ```python
  from pokeredus.graph.attribute_engine import tune_existing_node
  scaled = tune_existing_node(self.node)  # (8, 18) in 0-100
  axis_vals = scaled.max(axis=1)            # (8,) per-axis max across 18 types
  ```
  Or, if the node already has 0-100 attrs (because the page tuner set them), just read `self.node.attributes.max(axis=1)`. The page always tunes the node before showing, so this is the right path.
- Compute the radius: `radius = min(w, h) * 0.40` (no zoom factor).
- For each axis `i`, length = `axis_vals[i] / 100 * radius` (clamped to `[0, radius]`).
- Delete `self.zoom`, `_zoom_by`, the wheel / Up / Down / Button-4 / Button-5 bindings, the `ZOOM_*` constants.

**Step 3: Run test, verify pass. Commit.**

```bash
git add pokeredus/gui/matchup_graph_view.py tests/test_matchup_graph_view.py
git commit -m "refactor(matchup-graph): 2D auto-fit scale, drop zoom, per-axis 0-100"
```

---

## Task 2: 2D drag rotates around the central axis only

**Files:**
- Modify: `pokeredus/gui/matchup_graph_view.py` — `MatchupGraph2D._on_drag()`

**Step 1: Write failing test**

```python
# tests/test_matchup_graph_view.py
def test_2d_drag_rotates_only_horizontally():
    from pokeredus.gui.matchup_graph_view import MatchupGraph2D
    import numpy as np
    root = tk.Tk(); root.withdraw()
    try:
        v = MatchupGraph2D(root, sets_dir=".")
        n = type("N", (), {})()
        n.attributes = np.ones((8, 18), dtype=np.float32) * 50
        n.vase_order = list(range(18))
        n.bias = 1.0
        v.set_node(n)
        v._on_press(_event(200, 200))
        v._on_drag(_event(300, 100))   # dx=+100, dy=-100
        v._on_release(_event(300, 100))
        # rotation should be 100 * DRAG_RAD_PER_PX = 1.0
        assert v.rotation == pytest.approx(1.0)
    finally:
        root.destroy()
```

Where `_event` is a small fake-event class (use `types.SimpleNamespace(x=..., y=...)` or the existing one in `test_matchup_graph_view_interaction.py`).

**Step 2: Update `_on_drag`** — drop the `dy * DRAG_RAD_PER_PX` subtraction, only horizontal contributes:
```python
def _on_drag(self, e):
    if self._drag_last is None:
        return
    dx = e.x - self._drag_last[0]
    self._drag_last = (e.x, e.y)
    self.rotation += dx * self.DRAG_RAD_PER_PX
    self._redraw()
```

**Step 3: Run, verify pass. Commit.**

```bash
git add pokeredus/gui/matchup_graph_view.py tests/test_matchup_graph_view.py
git commit -m "refactor(matchup-graph): 2D drag rotates only around central axis"
```

---

## Task 3: 3D drag rotates around the world origin

**Files:**
- Modify: `pokeredus/gui/matchup_graph_view.py` — `MatchupGraph3D._on_drag()`, `world_to_screen`, `screen_to_world`
- Test: `tests/test_matchup_graph_view.py`

**Step 1: Background math**

The current `world_to_screen` does:
```python
x = p[0] - cam.center[0]   # translate by look-at
y = p[1] - cam.center[1]
z = p[2] - cam.center[2]
# then yaw + pitch rotations
```
To rotate around the world origin, the look-at must stay at origin (`cam.center = (0, 0, 0)`) and the camera must orbit the origin (i.e., the world rotates relative to a fixed camera). The simplest fix:
- Keep `cam.center = (0, 0, 0)` fixed (mid-tower at world y=0, z=mid of 18-disc stack).
- The yaw and pitch rotations in `world_to_screen` already rotate the world around the origin (not around `cam.center`) once we don't translate by `cam.center` first. So we set the translation to 0.
- The 18 disc centers should be re-laid out with their centroid at world origin (currently they're at `(0, 0, base_z + i*slab_height)` — y is already 0, but z range is 0..340, mid at 170). For origin-anchored rotation, we want them centered at z=0: change `disc_centers()` to subtract the mid-z, OR pass a translation.

**Step 2: Implement**

Two small changes:
1. In `MatchupGraph3D.__init__`, set `self.cam = cam._replace(center=(0, 0, 0))` and remove the 3D wheel bindings.
2. In `world_to_screen`, drop the `cam.center` translation:
   ```python
   x = p[0]
   y = p[1]
   z = p[2]
   ```
3. In `disc_centers`, return centers centered at z=0: `[(-(n-1)/2 * slab, 0, i*slab - (n-1)/2 * slab)]` — but this changes layout for both 2D and 3D. Cleaner: add a `disc_centers_origin_anchored` variant, and have `MatchupGraph3D._redraw` use it.
4. Remove `_zoom_by`, wheel bindings from `MatchupGraph3D._bind_inputs`. The cam distance is fixed at `Camera().distance` (750). Keep `Camera` NamedTuple but no setter.
5. The 3D disc radii are still `disc_radius(...)` which uses raw compound area. Replace with: `radius = (axis_max / 100) * base` where `axis_max` is the max of the 4 compound axes for that type, scaled 0-100. The 3D view reads from the **already-tuned** node (the page tuner keeps it 0-100), so:
   ```python
   a = self.node.attributes
   per_type = (a[4] * a[5] + a[6] * a[7])  # compound area, all 0-100
   r = base * (1 + sqrt(max(per_type[idx], 0)) * 0.2)
   ```

**Step 3: Write tests**

```python
def test_3d_drag_yaw_pitch_changes_cam():
    from pokeredus.gui.matchup_graph_view import MatchupGraph3D, Camera
    root = tk.Tk(); root.withdraw()
    try:
        v = MatchupGraph3D(root, sets_dir=".")
        v._on_press(_event(200, 200))
        v._on_drag(_event(300, 250))  # +100 x, +50 y
        v._on_release(_event(300, 250))
        assert v.cam.yaw != Camera().yaw
        assert v.cam.pitch != Camera().pitch
    finally:
        root.destroy()


def test_3d_world_to_screen_origin_anchored_no_translation():
    """world_to_screen with cam.center=(0,0,0) should NOT translate."""
    from pokeredus.gui.matchup_graph_view import world_to_screen, Camera
    cam = Camera(center=(0.0, 0.0, 0.0), yaw=0.0, pitch=0.0,
                  distance=300, width=600, height=400)
    p = np.array([10.0, 20.0, 0.0])
    s = world_to_screen(p, cam)
    # At identity rotations + distance 300 + focal 400, (10, 20) should
    # project to roughly (10*400/300, ...) = (13.3, ...) offset from center.
    assert abs(s[0] - 600/2 - 13.3) < 1.0
    assert abs(s[1] - 400/2 + 20*400/300) < 1.0
```

**Step 4: Run, verify pass. Commit.**

```bash
git add pokeredus/gui/matchup_graph_view.py tests/test_matchup_graph_view.py
git commit -m "refactor(matchup-graph): 3D drag rotates around world origin, drop zoom"
```

---

## Task 4: 3D disc radius uses 0-100 scaled attributes

**Files:**
- Modify: `pokeredus/gui/matchup_graph_view.py` — `disc_radius()`
- Test: `tests/test_matchup_graph_view.py`

**Step 1: Write failing test**

```python
def test_disc_radius_uses_scaled_attributes():
    """With attributes already in 0-100, the disc radius should be
    bounded (max 100 → 1 + sqrt(100)*0.2 = 3.0 of the base unit)."""
    from pokeredus.gui.matchup_graph_view import disc_radius
    full = np.zeros((8, 18), dtype=np.float32)
    full[4] = 100.0  # counter at max
    full[5] = 100.0  # sponge at max
    r = disc_radius(full, type_index=3, base=8.0)
    assert r <= 8.0 * (1.0 + 0.2 * 10)  # 24, the hard ceiling
    # Compare to old: with raw sums the radius would have been much larger
    # because raw sums are unbounded. With 0-100 attrs the radius is bounded.
    assert r < 30.0
```

**Step 2: Update `disc_radius`** to read from the scaled (0-100) attrs. (No internal scaling change needed; the per-type compound area is now bounded by 100×100 = 10000, so `1 + sqrt(10000)*0.2 = 21` at most. That's a reasonable disc size.)

Actually we want a smaller cap so discs don't overlap. Add a `radius_scale` param: `r = base * (1 + sqrt(max(area, 0)) * 0.02)` (was 0.2). With 0-100 attrs, max sqrt(10000) = 100, so max r = 8 * 3 = 24. Still too big for 18 stacked discs.

The cleanest answer: cap the disc radius at `min(0.8 * (slab_height / 2), 0.2 * min(w, h) / 18)`. Or just shrink the multiplier to 0.005 so max is `8 * (1 + 100*0.005) = 8 * 1.5 = 12`.

Pick `0.005` as the new multiplier. Update `disc_radius` and the test.

**Step 3: Run, verify pass. Commit.**

```bash
git add pokeredus/gui/matchup_graph_view.py tests/test_matchup_graph_view.py
git commit -m "refactor(matchup-graph): 3D disc radius bounded by 0-100 attrs"
```

---

## Task 5: List rows show set names only (drop volume column)

**Files:**
- Modify: `pokeredus/gui/pokemon_set_list.py` — `_build`, `_repopulate`
- Modify: `tests/test_pokemon_set_list.py` — update column expectations

**Step 1: Write failing test**

```python
def test_widget_shows_set_name_only():
    import tkinter as tk
    from pokeredus.gui.pokemon_set_list import PokemonSetList
    root = tk.Tk(); root.withdraw()
    try:
        widget = PokemonSetList(root)
        widget.refresh(_fakes())
        # The set row text should contain the set name, not the volume.
        kids = widget._tree.get_children("")
        garchomp_iid = next(k for k in kids
                             if widget._tree.item(k, "text").endswith("garchomp"))
        set_rows = widget._tree.get_children(garchomp_iid)
        for sr in set_rows:
            text = widget._tree.item(sr, "text")
            assert any(name in text
                       for name in ("swords_dance", "choice_scarf"))
            # The volume column should be empty for set rows
            assert widget._tree.item(sr, "values") == ("",)
    finally:
        root.destroy()
```

**Step 2: Implement**

- Remove `"vol"` from `columns=`, drop the `Vol` heading, drop the `"vol"` column config.
- In `_repopulate`, for the pokemon row, `values = (g.best_set_name, "")` (or just `(g.best_set_name,)` if we drop best too — see Open Question 1).
- For set rows, `values = ()` or just drop the values arg.

**Step 3: Update existing tests** that check `widget._tree.item(set_rows[0], "values")` (they expected `("", "70")`).

**Step 4: Run, verify pass. Commit.**

```bash
git add pokeredus/gui/pokemon_set_list.py tests/test_pokemon_set_list.py
git commit -m "refactor(pokemon-set-list): drop volume column, show set names only"
```

---

## Task 6: Update interaction tests + final regression run

**Files:**
- Modify: `tests/test_matchup_graph_view_interaction.py` — drop zoom-related tests
- Run: `pytest tests/ -q -k "matchup_graph or pokemon_set or attribute" --ignore=tests/test_matchup_graph.py`

**Step 1: Remove or replace tests that reference removed APIs**

- `test_2d_bindings_include_drag_wheel_keys` — remove `<MouseWheel>`, `<Button-4>`, `<Button-5>`, `<Key-Up>`, `<Key-Down>` from the expected bindings. Keep `<Key-Left>`, `<Key-Right>`, drag bindings, and `r`/`R` (reset still works).
- `test_2d_drag_updates_rotation_state` — update to use the new horizontal-only drag (the old test used a horizontal drag of 100 px → 1.0 rad, which still works; the vertical component no longer subtracts).
- `test_combined_view_starts_in_2d` — unchanged.

**Step 2: Add a regression test that the polygon fits for any input**

```python
def test_2d_polygon_always_inside_canvas():
    """For any attribute magnitude (1.0, 1e3, 1e9), the drawn polygon
    must lie inside the canvas."""
    from pokeredus.gui.matchup_graph_view import MatchupGraph2D
    import numpy as np
    for mag in (1.0, 1e3, 1e9):
        root = tk.Tk(); root.withdraw()
        try:
            v = MatchupGraph2D(root, sets_dir=".")
            n = type("N", (), {})()
            n.attributes = np.ones((8, 18), dtype=np.float32) * mag
            n.vase_order = list(range(18))
            n.bias = 1.0
            v.set_node(n)
            v.canvas.config(width=400, height=300)
            v._redraw()
            bbox = v.canvas.bbox("all")
            assert bbox is not None
            x0, y0, x1, y1 = bbox
            assert x0 >= -1 and y0 >= -1
            assert x1 <= 401 and y1 <= 301
        finally:
            root.destroy()
```

**Step 3: Run all matchup-graph tests, verify pass. Commit any final fixes.**

---

## Open Design Questions

1. **Pokemon row contents** — drop the "Best set" column too, leaving just `text="▼ garchomp"` with no `values`? Or keep "Best set" as a small subtitle? The user said "show one entry per Pokémon" originally; with no sprite, just the id and a count badge (`▼ garchomp (3)`) would be cleanest. **Recommendation:** keep the chevron + id, drop the "Best set" / "Volume" columns entirely, and show set count as `(N)` suffix. If you want a different look, say so before I start.

2. **2D drag vertical motion** — should it (a) do nothing, (b) still rotate the polygon, or (c) act as a "vertical-only" rotation around the screen-y axis (i.e., tilt the polygon in 3D)? **Recommendation:** (a) do nothing. The polygon stays anchored at the center. The user said "rotate over central axis" → only horizontal drag rotates around the Z (out-of-screen) axis.

3. **3D pitch range** — currently clamped to ±1.2 rad (~±69°). With origin-anchored rotation, the disc stack will swing up/down. Keep the clamp? **Recommendation:** keep the clamp at ±1.0 rad (~±57°) to prevent the stack from going vertical.

4. **Scaled attribute source** — the page tuner (`_on_tuning_change`) mutates `node.attributes` to the 0-100 scaled matrix. The 2D/3D renderers will read this directly. If the user opens the page WITHOUT touching the tuner, the node has the raw sums and the polygon will be tiny (everything close to 0 in 0-100 terms). **Recommendation:** in `MatchupGraphPage._on_tuning_change` (and in `set_node`), call `tune_existing_node(node, self._tuning)` lazily on first display so the node is always 0-100 before reaching the renderer. Add this to Task 1.

---

## Out of Scope

- Resize handles, fullscreen, or anything beyond the 3-pane layout.
- Animations / transitions on slider drags.
- Persisting the new 2D rotation / 3D yaw-pitch between sessions.
- Rebuilding the existing 3D cylinder model to a proper polyhedron (it's still 18 stacked discs).

---

## Verification

After all tasks:
```bash
pytest tests/ -q -k "matchup_graph or pokemon_set or attribute" --ignore=tests/test_matchup_graph.py
```
Expected: all green (89 + 14 + 11 + 5 + 3 + ~6 new tests = ~128 passing, depending on how many old tests are replaced).

Full GUI smoke check (manual, user does this):
```bash
.venv/Scripts/python.exe scripts/launch.py
# Navigate: Home → Matchup Graph
# Click a pokemon row → expands
# Click a set → 2D radial polygon renders, fits canvas
# Drag horizontally → polygon rotates around the center
# Drag vertically → no change
# Wheel/arrows → no zoom (graph stays the same size)
# Switch to 3D → 18 discs fit, drag rotates the stack around the world origin
# Adjust a slider → polygon and discs update live
```

