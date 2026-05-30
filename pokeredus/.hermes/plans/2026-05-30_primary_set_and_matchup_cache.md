# Primary Set + Matchup Cache Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a toggleable primary set per Pokémon (star icon) and a precomputed matchup cache that uses each Pokémon's full move pool across all sets, eliminating redundant damage calculations in the GUI.

**Architecture:**
- Each Pokémon gets one "primary set" (star toggle). Stats (EVs/nature/item/ability) come from the starred set, but the move pool is the union of all moves across all sets for that species.
- A `MatchupCache` precomputes pairwise TTK/damage outcomes for every Pokémon pair using these composite sets. Cache is stored as JSON on disk and invalidated when sets change.
- The GUI shows a star on each set card; clicking it marks that set as primary. Matchup panels read from the cache instead of computing on the fly.

**Tech Stack:** Python 3.11, tkinter, existing DamageCalculator/MatchupEngine/KnowledgeGraph

---

## Task 1: Add `primary_set_id` field to PokemonClass

**Objective:** Track which set is "primary" per Pokémon species.

**Files:**
- Modify: `pokeredus/classes/pokemon.py`
- Test: `tests/test_classes.py`

**Step 1: Write failing test**

```python
def test_pokemon_primary_set_id():
    from pokeredus.classes.pokemon import PokemonClass
    p = PokemonClass(id="garchomp", name="Garchomp", types=["Dragon", "Ground"],
                     base_stats={"hp": 108, "atk": 130, "def": 95, "spa": 80, "spd": 85, "spe": 102})
    assert p.primary_set_id == ""
    p.primary_set_id = "garchomp_swords_dance"
    d = p.to_dict()
    assert d["primary_set_id"] == "garchomp_swords_dance"
    p2 = PokemonClass.from_dict(d)
    assert p2.primary_set_id == "garchomp_swords_dance"
```

**Step 2: Run test to verify failure**

Run: `cd D:\PokeRedus\pokeredus && .venv/Scripts/python -m pytest tests/test_classes.py::test_pokemon_primary_set_id -v`
Expected: FAIL — `primary_set_id` attribute doesn't exist

**Step 3: Implement**

Add `primary_set_id: str = ""` field to `PokemonClass` dataclass. Add it to `to_dict()` and `from_dict()`.

**Step 4: Run test to verify pass**

Run: `cd D:\PokeRedus\pokeredus && .venv/Scripts/python -m pytest tests/test_classes.py -v`
Expected: PASS

**Step 5: Commit**

```bash
git add pokeredus/classes/pokemon.py tests/test_classes.py
git commit -m "feat: add primary_set_id field to PokemonClass"
```

---

## Task 2: Add KnowledgeGraph helpers for primary set management

**Objective:** Provide methods to get/set primary sets and build "composite sets" (primary stats + union move pool).

**Files:**
- Modify: `pokeredus/graph/knowledge_graph.py`

**Step 1: Implement methods**

Add to `KnowledgeGraph`:

```python
def get_primary_set(self, pokemon_id: str) -> SetClass | None:
    """Return the primary set for a Pokémon, or the first set if none marked."""
    pokemon = self.get_pokemon(pokemon_id)
    if not pokemon:
        return None
    if pokemon.primary_set_id:
        s = self.get_set(pokemon.primary_set_id)
        if s:
            return s
    sets = self.get_sets(pokemon_id)
    return sets[0] if sets else None

def set_primary_set(self, pokemon_id: str, set_id: str) -> None:
    """Mark a set as the primary set for a Pokémon."""
    pokemon = self.get_pokemon(pokemon_id)
    if pokemon:
        pokemon.primary_set_id = set_id
        # Update the graph node data too
        if self.graph.has_node(pokemon_id):
            self.graph.nodes[pokemon_id]["data"] = pokemon.to_dict()

def get_union_move_pool(self, pokemon_id: str) -> list[str]:
    """Return the union of all move IDs across all sets for a Pokémon."""
    moves = []
    seen = set()
    for s in self.get_sets(pokemon_id):
        for mid in s.moves:
            if mid not in seen:
                moves.append(mid)
                seen.add(mid)
    return moves

def build_composite_set(self, pokemon_id: str) -> SetClass | None:
    """Build a composite set: primary set's stats/ability/item/nature + union move pool."""
    primary = self.get_primary_set(pokemon_id)
    if not primary:
        return None
    union_moves = self.get_union_move_pool(pokemon_id)
    return SetClass(
        id=f"{pokemon_id}__composite",
        pokemon_id=pokemon_id,
        set_name=f"{primary.set_name} (composite)",
        ability=primary.ability,
        item=primary.item,
        nature=primary.nature,
        evs=primary.evs,
        moves=union_moves,
        ivs=dict(primary.ivs),
        role=primary.role,
        tera_type=primary.tera_type,
    )
```

**Step 2: Commit**

```bash
git add pokeredus/graph/knowledge_graph.py
git commit -m "feat: add primary set helpers and composite set builder to KnowledgeGraph"
```

---

## Task 3: Build the MatchupCache system

**Objective:** Precompute pairwise matchup results for all Pokémon using composite sets (primary stats + union moves). Store cache as JSON on disk.

**Files:**
- Create: `pokeredus/graph/matchup_cache.py`
- Modify: `pokeredus/config.py` (add CACHE_DIR)

**Step 1: Add cache directory to config**

Add to `config.py`:
```python
CACHE_DIR = DATA_DIR / "cache"
```

**Step 2: Implement MatchupCache**

Create `pokeredus/graph/matchup_cache.py`:

```python
"""
MatchupCache — precomputed pairwise matchup results between Pokémon species.

Key design:
- Cache is keyed by (attacker_pokemon_id, defender_pokemon_id)
- Uses composite sets: primary set's stats + union of all moves across all sets
- Stored as JSON on disk at CACHE_DIR/matchup_cache.json
- Invalidated when any set is added/removed/modified (hash-based)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

from pokeredus.config import CACHE_DIR
from pokeredus.graph.damage_calc import DamageCalculator, get_calculator

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph


@dataclass
class CachedMatchup:
    """A single cached matchup result between two Pokémon."""
    attacker_id: str
    defender_id: str
    turns_to_kill: int            # attacker kills defender in N turns
    best_move_id: str             # attacker's best move
    damage_per_hit: int           # raw damage of best move
    min_damage: int               # worst-case roll (×0.85)
    max_damage: int               # best-case roll (×1.00)
    min_ttk: int                  # best-case TTK (fewest turns)
    max_ttk: int                  # worst-case TTK (most turns)
    damage_pct_lo: float          # min roll as % of defender HP
    damage_pct_hi: float          # max roll as % of defender HP
    type_effectiveness: float     # best move's type effectiveness
    stab: bool                    # whether best move is STAB
    move_type: str = ""
    move_category: str = ""       # "physical" or "special"
    offensive_stat: int = 0
    defensive_stat: int = 0

    def to_dict(self) -> dict:
        return {
            "attacker_id": self.attacker_id,
            "defender_id": self.defender_id,
            "turns_to_kill": self.turns_to_kill,
            "best_move_id": self.best_move_id,
            "damage_per_hit": self.damage_per_hit,
            "min_damage": self.min_damage,
            "max_damage": self.max_damage,
            "min_ttk": self.min_ttk,
            "max_ttk": self.max_ttk,
            "damage_pct_lo": round(self.damage_pct_lo, 2),
            "damage_pct_hi": round(self.damage_pct_hi, 2),
            "type_effectiveness": self.type_effectiveness,
            "stab": self.stab,
            "move_type": self.move_type,
            "move_category": self.move_category,
            "offensive_stat": self.offensive_stat,
            "defensive_stat": self.defensive_stat,
        }

    @classmethod
    def from_dict(cls, data: dict) -> CachedMatchup:
        return cls(**data)


class MatchupCache:
    """Precomputed matchup cache between Pokémon species."""

    def __init__(self):
        self._cache: dict[tuple[str, str], CachedMatchup] = {}
        self._fingerprint: str = ""  # hash of the set configuration

    def get(self, attacker_id: str, defender_id: str) -> CachedMatchup | None:
        return self._cache.get((attacker_id, defender_id))

    def put(self, matchup: CachedMatchup) -> None:
        self._cache[(matchup.attacker_id, matchup.defender_id)] = matchup

    def get_all_against(self, defender_id: str) -> list[CachedMatchup]:
        """All matchups where defender is the target."""
        return [m for (a, d), m in self._cache.items() if d == defender_id]

    def get_all_by(self, attacker_id: str) -> list[CachedMatchup]:
        """All matchups where attacker is the source."""
        return [m for (a, d), m in self._cache.items() if a == attacker_id]

    @property
    def size(self) -> int:
        return len(self._cache)

    # ── Build / Rebuild ──────────────────────────────────────────────

    def build(
        self,
        kg: KnowledgeGraph,
        calc: DamageCalculator | None = None,
        progress_cb=None,
    ) -> int:
        """Build the full cache from the knowledge graph.

        For each Pokémon pair (A, B):
        - Build composite set for A (primary stats + union moves)
        - Compute best move of A against B
        - Store result

        Returns number of cached entries.
        """
        if calc is None:
            calc = get_calculator()

        # Build fingerprints for invalidation
        self._fingerprint = self._compute_fingerprint(kg)

        pokemon_ids = [p.id for p in kg.get_all_pokemon()]
        self._cache.clear()

        count = 0
        total = len(pokemon_ids) * len(pokemon_ids)

        for atk_id in pokemon_ids:
            composite_a = kg.build_composite_set(atk_id)
            if not composite_a:
                continue
            for def_id in pokemon_ids:
                if atk_id == def_id:
                    continue
                composite_b = kg.build_composite_set(def_id)
                if not composite_b:
                    continue

                result = calc.best_move(composite_a, composite_b, kg)
                if result is None or result.is_immune or result.final_damage <= 0:
                    # Can't deal damage
                    cm = CachedMatchup(
                        attacker_id=atk_id,
                        defender_id=def_id,
                        turns_to_kill=0,
                        best_move_id="",
                        damage_per_hit=0,
                        min_damage=0,
                        max_damage=0,
                        min_ttk=0,
                        max_ttk=0,
                        damage_pct_lo=0.0,
                        damage_pct_hi=0.0,
                        type_effectiveness=0.0,
                        stab=False,
                    )
                else:
                    # Get attacker pokemon for STAB check
                    atk_pokemon = kg.get_pokemon(atk_id)
                    is_stab = result.move_type in (atk_pokemon.types if atk_pokemon else [])
                    cm = CachedMatchup(
                        attacker_id=atk_id,
                        defender_id=def_id,
                        turns_to_kill=result.turns_to_kill,
                        best_move_id=result.move_id,
                        damage_per_hit=result.final_damage,
                        min_damage=result.min_damage,
                        max_damage=result.max_damage,
                        min_ttk=result.min_turns_to_kill,
                        max_ttk=result.max_turns_to_kill,
                        damage_pct_lo=result.min_damage_percent,
                        damage_pct_hi=result.max_damage_percent,
                        type_effectiveness=result.type_effectiveness,
                        stab=is_stab,
                        move_type=result.move_type,
                        move_category=result.move_category,
                        offensive_stat=result.offensive_stat,
                        defensive_stat=result.defensive_stat,
                    )
                self.put(cm)
                count += 1

                if progress_cb and count % 100 == 0:
                    progress_cb(count, total)

        return count

    # ── Fingerprinting (invalidation) ────────────────────────────────

    @staticmethod
    def _compute_fingerprint(kg: KnowledgeGraph) -> str:
        """Compute a hash of the current set configuration for cache invalidation."""
        parts = []
        for p in sorted(kg.get_all_pokemon(), key=lambda x: x.id):
            parts.append(f"{p.id}:{p.primary_set_id}")
            for s in sorted(kg.get_sets(p.id), key=lambda x: x.id):
                parts.append(f"  {s.id}:{','.join(sorted(s.moves))}:{s.nature.id}:{s.evs.label}")
        h = hashlib.sha256("\n".join(parts).encode()).hexdigest()[:16]
        return h

    def is_valid(self, kg: KnowledgeGraph) -> bool:
        """Check if the cache is still valid for the current graph state."""
        if not self._fingerprint:
            return False
        return self._fingerprint == self._compute_fingerprint(kg)

    # ── Disk I/O ─────────────────────────────────────────────────────

    def save(self, path: Path | None = None) -> None:
        """Save cache to JSON file."""
        path = path or (CACHE_DIR / "matchup_cache.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "fingerprint": self._fingerprint,
            "matchups": [m.to_dict() for m in self._cache.values()],
        }
        path.write_text(json.dumps(data, indent=1), encoding="utf-8")

    @classmethod
    def load(cls, path: Path | None = None) -> MatchupCache:
        """Load cache from JSON file."""
        path = path or (CACHE_DIR / "matchup_cache.json")
        cache = cls()
        if not path.exists():
            return cache
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            cache._fingerprint = data.get("fingerprint", "")
            for md in data.get("matchups", []):
                cm = CachedMatchup.from_dict(md)
                cache.put(cm)
        except (json.JSONDecodeError, OSError, KeyError):
            pass
        return cache

    @classmethod
    def load_or_build(cls, kg: KnowledgeGraph, force: bool = False) -> MatchupCache:
        """Load from disk if valid, otherwise build fresh."""
        cache = cls.load()
        if not force and cache.is_valid(kg) and cache.size > 0:
            return cache
        cache.build(kg)
        cache.save()
        return cache
```

**Step 3: Commit**

```bash
git add pokeredus/graph/matchup_cache.py pokeredus/config.py
git commit -m "feat: add MatchupCache for precomputed pairwise Pokémon matchups"
```

---

## Task 4: Add star toggle to set cards in PokemonPage

**Objective:** Add a toggleable star (★/☆) on each set card that marks a set as primary. The star is visually distinct (gold when active, dim when inactive) and clicking it updates the primary set.

**Files:**
- Modify: `pokeredus/gui/pokemon_panel.py` (set card creation + star rendering)
- Modify: `pokeredus/gui/theme.py` (add STAR color constant)

**Step 1: Add star color to theme.py**

```python
STAR_ACTIVE = "#ffe600"    # gold — primary set
STAR_INACTIVE = "#484f58"  # dim — not primary
```

**Step 2: Modify `_create_set_card` in PokemonPage**

In the set card top row (where set name + role + speed + edit/delete buttons are), add a star button:

```python
# Star toggle (primary set indicator) — far left of top row
is_primary = (pokemon.primary_set_id == set_obj.id)
star_text = "★" if is_primary else "☆"
star_color = STAR_ACTIVE if is_primary else STAR_INACTIVE
star_btn = tk.Label(top, text=star_text, font=("Consolas", 16),
                     fg=star_color, bg=BG_CARD, cursor="hand2")
star_btn.pack(side="left", padx=(0, 8))
star_btn.bind("<Button-1>", lambda e, s=set_obj.id, p=pokemon.id: self._toggle_primary(p, s))
```

**Step 3: Implement `_toggle_primary` method**

```python
def _toggle_primary(self, pokemon_id: str, set_id: str):
    """Toggle the primary set for a Pokémon."""
    pokemon = self.kg.get_pokemon(pokemon_id)
    if not pokemon:
        return
    # If already primary, unset it (revert to first set or none)
    if pokemon.primary_set_id == set_id:
        pokemon.primary_set_id = ""
    else:
        pokemon.primary_set_id = set_id
    # Update graph
    if self.kg.graph.has_node(pokemon_id):
        self.kg.graph.nodes[pokemon_id]["data"] = pokemon.to_dict()
    # Rebuild the detail panel to reflect star change
    self._select_pokemon(pokemon_id)
```

**Step 4: Commit**

```bash
git add pokeredus/gui/pokemon_panel.py pokeredus/gui/theme.py
git commit -m "feat: add star toggle for primary set selection in PokemonPage"
```

---

## Task 5: Integrate MatchupCache with the GUI matchup display

**Objective:** Replace on-the-fly `aggregate_matchups_by_species()` calls with cached lookups when displaying matchup rankings.

**Files:**
- Modify: `pokeredus/gui/pokemon_panel.py` (matchup rendering section)
- Modify: `pokeredus/gui/app.py` (cache initialization on startup)

**Step 1: Initialize cache on app startup**

In `PokeRedusApp.__init__`, after loading the knowledge graph:

```python
from pokeredus.graph.matchup_cache import MatchupCache
self.matchup_cache = MatchupCache.load_or_build(self.kg)
```

Pass `matchup_cache` reference to `PokemonPage`.

**Step 2: Modify PokemonPage to accept and use the cache**

In `PokemonPage.__init__`, accept `matchup_cache` parameter. In `_build_matchup_rankings` and `_render_matchups`, use cache lookups instead of computing on the fly:

```python
def _render_matchups(self, set_obj):
    for w in self._matchup_container.winfo_children(): w.destroy()

    pokemon = self.kg.get_pokemon(set_obj.pokemon_id)
    if not pokemon:
        return

    # Use cache: get all matchups where our Pokémon attacks and where it defends
    our_id = set_obj.pokemon_id
    offense_entries = self._matchup_cache.get_all_by(our_id)
    defense_entries = self._matchup_cache.get_all_against(our_id)

    # Build species-aggregated best/worst from cache
    best = self._aggregate_cache_matchups(offense_entries, defense_entries, direction="offense")
    worst = self._aggregate_cache_matchups(offense_entries, defense_entries, direction="defense")

    # ... rest of rendering code stays similar, adapt to use CachedMatchup fields
```

**Step 3: Implement cache-based aggregation**

```python
def _aggregate_cache_matchups(self, offense, defense, direction):
    """Aggregate cached matchups per species, picking best representative."""
    # Group by defender species (for offense) or attacker species (for defense)
    species_map: dict[str, list] = {}
    entries = offense if direction == "offense" else defense
    key = "defender_id" if direction == "offense" else "attacker_id"

    for cm in entries:
        pid = getattr(cm, key)
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
        if direction == "offense":
            best_m = min(valid, key=lambda m: m.turns_to_kill)
        else:
            best_m = min(valid, key=lambda m: m.turns_to_kill)
        result.append((pokemon, best_m))

    # Sort
    if direction == "offense":
        result.sort(key=lambda x: x[1].turns_to_kill)
    else:
        result.sort(key=lambda x: x[1].turns_to_kill)

    return result
```

**Step 4: Adapt `_create_matchup_row` and `_build_matchup_detail` to use CachedMatchup**

These methods currently expect `SpeciesMatchup` objects. Adapt them to work with `(PokemonClass, CachedMatchup)` tuples from the cache. The field mapping:
- `m.turns_to_kill_them` → `cm.turns_to_kill` (for offense)
- `m.turns_to_kill_us` → `cm.turns_to_kill` (for defense)
- `m.damage_range_us_str` → compute from `cm.damage_pct_lo`, `cm.damage_pct_hi`
- `m.our_best_move` → resolve `cm.best_move_id` to name
- etc.

**Step 5: Commit**

```bash
git add pokeredus/gui/pokemon_panel.py pokeredus/gui/app.py
git commit -m "feat: integrate MatchupCache with GUI matchup display"
```

---

## Task 6: Add cache rebuild trigger on set changes

**Objective:** Invalidate and rebuild the cache when sets are added, edited, or deleted.

**Files:**
- Modify: `pokeredus/gui/set_editor.py` (after save)
- Modify: `pokeredus/gui/pokemon_panel.py` (after delete)

**Step 1: Add cache invalidation callback**

In `PokeRedusApp`, add a method:

```python
def invalidate_matchup_cache(self):
    """Rebuild the matchup cache (called when sets change)."""
    from pokeredus.graph.matchup_cache import MatchupCache
    self.matchup_cache = MatchupCache.load_or_build(self.kg, force=True)
```

**Step 2: Wire up from SetEditorDialog**

After saving a set in `_save()`, call the app's cache invalidation. Pass a callback into the dialog.

**Step 3: Wire up from _delete_set in PokemonPage**

After deleting a set, trigger cache rebuild.

**Step 4: Commit**

```bash
git add pokeredus/gui/set_editor.py pokeredus/gui/pokemon_panel.py pokeredus/gui/app.py
git commit -m "feat: trigger cache rebuild on set add/edit/delete"
```

---

## Task 7: Add star toggle to TeamBuilder slot cards

**Objective:** Show the primary set star on team slot cards too, and allow toggling from the team builder.

**Files:**
- Modify: `pokeredus/gui/team_builder.py` (TeamSlotCard._build_filled)

**Step 1: Add star to slot card header**

In `TeamSlotCard._build_filled`, add a star button in the header area (next to the sprite):

```python
# Primary set star
pokemon_obj = self.kg.get_pokemon(set_obj.pokemon_id)
is_primary = pokemon_obj and pokemon_obj.primary_set_id == set_obj.id
star_text = "★" if is_primary else "☆"
star_color = STAR_ACTIVE if is_primary else STAR_INACTIVE
star_btn = tk.Label(header, text=star_text, font=("Consolas", 14),
                     fg=star_color, bg=BG_CARD, cursor="hand2")
star_btn.pack(side="right", padx=(4, 0))
star_btn.bind("<Button-1>", lambda e: self._toggle_primary_star())
```

**Step 2: Implement toggle**

```python
def _toggle_primary_star(self):
    if not self.set_id:
        return
    set_obj = self.kg.get_set(self.set_id)
    if not set_obj:
        return
    pokemon = self.kg.get_pokemon(set_obj.pokemon_id)
    if not pokemon:
        return
    if pokemon.primary_set_id == self.set_id:
        pokemon.primary_set_id = ""
    else:
        pokemon.primary_set_id = self.set_id
    if self.kg.graph.has_node(set_obj.pokemon_id):
        self.kg.graph.nodes[set_obj.pokemon_id]["data"] = pokemon.to_dict()
    self._build_filled(self.set_id)
    self._on_change()  # triggers cache rebuild
```

**Step 3: Commit**

```bash
git add pokeredus/gui/team_builder.py
git commit -m "feat: add primary set star toggle to team builder slot cards"
```

---

## Task 8: Persist primary_set_id with graph save

**Objective:** Ensure `primary_set_id` survives graph save/load cycles.

**Files:**
- Verify: `pokeredus/graph/knowledge_graph.py` (already handles it via to_dict/from_dict)
- Test: `tests/test_graph.py`

**Step 1: Write test**

```python
def test_primary_set_survives_save_load():
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.classes import PokemonClass, SetClass, NatureClass, EVSpreadClass
    import tempfile, os

    kg = KnowledgeGraph()
    p = PokemonClass(id="test", name="Test", types=["Normal"],
                     base_stats={"hp": 100, "atk": 100, "def": 100, "spa": 100, "spd": 100, "spe": 100})
    kg.add_pokemon(p)
    n = NatureClass("Adamant")
    s = SetClass(id="test_sd", pokemon_id="test", set_name="SD",
                 ability="guts", item="leftovers", nature=n,
                 evs=EVSpreadClass(hp=252), moves=["tackle"])
    kg.add_set(s)
    p.primary_set_id = "test_sd"
    kg.graph.nodes["test"]["data"] = p.to_dict()

    # Save and reload
    with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as f:
        path = f.name
    try:
        kg.save(path)
        kg2 = KnowledgeGraph.load(path)
        p2 = kg2.get_pokemon("test")
        assert p2.primary_set_id == "test_sd"
    finally:
        os.unlink(path)
```

**Step 2: Run test, verify pass (it should already work since to_dict/from_dict handle it)**

**Step 3: Commit**

```bash
git add tests/test_graph.py
git commit -m "test: verify primary_set_id survives graph save/load"
```

---

## Summary of files changed

| File | Change |
|------|--------|
| `pokeredus/classes/pokemon.py` | Add `primary_set_id` field |
| `pokeredus/graph/knowledge_graph.py` | Add primary set helpers + composite set builder |
| `pokeredus/graph/matchup_cache.py` | **NEW** — full matchup cache system |
| `pokeredus/config.py` | Add `CACHE_DIR` |
| `pokeredus/gui/pokemon_panel.py` | Star toggle + cache-based matchup display |
| `pokeredus/gui/team_builder.py` | Star toggle on slot cards |
| `pokeredus/gui/set_editor.py` | Cache invalidation on save |
| `pokeredus/gui/app.py` | Cache initialization + invalidation method |
| `pokeredus/gui/theme.py` | Add `STAR_ACTIVE`/`STAR_INACTIVE` colors |
| `tests/test_classes.py` | Test primary_set_id serialization |
| `tests/test_graph.py` | Test persistence through save/load |

## Cache sizing estimate

For ~800 Pokémon in OU: 800 × 800 = 640,000 matchups. Each CachedMatchup is ~200 bytes JSON. Total: ~128MB. This is manageable but may need optimization (e.g., only store non-zero TTK entries). If size is an issue, store only entries where TTK > 0 (most matchups should have at least some damage).

## Key pitfalls

1. **Composite set ID collisions**: The composite set uses `"{pokemon_id}__composite"` as ID. Make sure this doesn't clash with real set IDs.
2. **Cache invalidation**: Any set add/edit/delete must trigger rebuild. The fingerprint approach catches this automatically.
3. **Empty move pools**: If a Pokémon has no sets, `build_composite_set` returns None. Skip these in cache building.
4. **Thread safety**: tkinter is single-threaded, so no concern here.
5. **First-run performance**: Building the full cache for 800 Pokémon takes ~640K damage calculations. Each is fast (~microseconds), so total should be under 30 seconds. Show a progress indicator if needed.
