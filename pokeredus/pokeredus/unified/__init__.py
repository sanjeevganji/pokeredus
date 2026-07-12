"""
PokeRedus Unified Core — single integration layer for the four pages and
external training consumers.

Why this module exists
----------------------
The four pages (pokemon stats, team builder, matchup graph, game simulator)
each evolved its own ad-hoc state model:

  * PokemonStats:  SetClass + PokemonClass, no dynamics
  * TeamBuilder:   list[SetClass] fixed at save time
  * MatchupGraph:  SetClass ↔ SetClass scores, no HP/status
  * Simulator:     GameState (PokemonState + FieldState + turns)

They are *the same scene* — a unified match is just a dynamic team with
HP, status, boosts, and field effects. The unified core collapses all
four into one consistent model so:

  (a) the simulator can ask "what's optimal now?" against the same scoring
      model the matchup graph already computed,
  (b) the team builder can be loaded straight into the simulator as the
      starting six, with full moveset preserved,
  (c) ANY page can dump its view as a plain-text snapshot that a
      self-learning model can consume, AND
  (d) we can serialize/deserialize a game state to JSON so we can collect
      training data offline or share snapshots between agents.

Design rules
------------
* No tkinter imports — this module is pure-Python. The GUI layer is thin
  on top of it.
* The public surface is four things only:
      UnifiedState         — the live model every page operates on
      SerializedSnapshot   — JSON-safe dict
      PlainTextScene       — verbose / compact / token modes for models
      TrainingSample       — (scene_text, action_text, reward?) tuples
* Use ONLY classes that already exist (PokemonClass, SetClass, MoveClass,
  PokemonState, GameState, MatchupRelation). We do not duplicate typing
  or stats — we just expose them in a uniform way.
* Picking the "optimal action" reuses pick_best_move / find_optimal_switch
  from graph.matchup_graph (already battle-tested in the meta graph page).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Optional

from pokeredus.classes.pokemon import PokemonClass   # noqa: F401
from pokeredus.classes.sets import SetClass             # noqa: F401
from pokeredus.classes.moves import MoveClass           # noqa: F401
# Importing PokerState/FieldState here is fine — they have no heavy deps.
# GameState is imported lazily inside recommend_actions() to avoid pulling
# in the matchup_graph chain (which requires numpy) on cold import.
from pokeredus.graph.game_state import PokemonState, FieldState


# ═══════════════════════════════════════════════════════════════════════
# Action model — every choice the player can make in a turn
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class UnifiedAction:
    """One possible action at a given UnifiedState.

    Three flavors:
      - "move":   use move_id with active Pokemon
      - "switch": bring bench_index into the active slot
      - "tera":   teracristallize into tera_type (move action modifier)
    """

    kind: str                                 # "move" | "switch" | "tera"
    label: str                                # human-readable ("Earthquake", "Switch to Dragapult")
    detail: dict[str, Any] = field(default_factory=dict)
    score: float = 0.0                        # heuristic value from optimal-action engine
    reasoning: list[str] = field(default_factory=list)
    is_recommended: bool = False

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "label": self.label,
            "detail": dict(self.detail),
            "score": round(self.score, 4),
            "reasoning": list(self.reasoning),
            "is_recommended": self.is_recommended,
        }

    # ── Plain-text serialization for training ─────────────────────────
    # Tokens kept short & stable so models can learn them as a vocabulary.
    def to_text(self, compact: bool = True) -> str:
        if self.kind == "move":
            if compact:
                return f"move:{self.detail.get('move_id', '?')}"
            parts = [f"move {self.detail.get('move_id', '?')}"]
            if self.detail.get("move_type"):
                parts.append(self.detail["move_type"])
            if self.detail.get("category"):
                parts.append(self.detail["category"])
            if self.detail.get("base_power"):
                parts.append(f"BP={self.detail['base_power']}")
            if self.detail.get("priority"):
                parts.append(f"prio={self.detail['priority']}")
            return " ".join(parts)
        if self.kind == "switch":
            target = self.detail.get("pokemon_id", "?")
            return f"switch:{target}" if compact else f"switch to {target}"
        if self.kind == "tera":
            return f"tera:{self.detail.get('tera_type', '?')}" if compact else f"terastallize to {self.detail.get('tera_type', '?')}"
        return self.kind


# ═══════════════════════════════════════════════════════════════════════
# UnifiedState — the live model every page operates on
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class UnifiedTeamSlot:
    """One slot in a team: a Set plus its dynamic battle state (HP, etc.)."""

    slot_index: int
    pokemon_id: str
    set_id: str
    pokemon_state: PokemonState = None  # type: ignore[assignment]

    def to_dict(self) -> dict:
        return {
            "slot_index": self.slot_index,
            "pokemon_id": self.pokemon_id,
            "set_id": self.set_id,
            "pokemon_state": self.pokemon_state.to_dict() if self.pokemon_state else None,
        }


@dataclass
class UnifiedState:
    """One unified scene — covers all four pages.

    Pages project the relevant subset:
      * Pokémon Stats page     → keys: team_a (each slot's set/pokemon)
      * Team Builder page      → keys: team_a (teams don't have HP/active)
      * Matchup Graph page     → keys: team_a vs team_b (as static sets)
      * Game Simulator page    → all keys (live HP, statuses, field, turn)

    HP/active/field are all optional; when None the page treats the scene
    as a static team look-up. This is the unification: one model, four
    projections.
    """

    # Identity — both teams are required, a scene is always "us vs them"
    team_a: list[UnifiedTeamSlot] = field(default_factory=list)
    team_b: list[UnifiedTeamSlot] = field(default_factory=list)

    # Active indices: which slot of each team is in play. -1 = no active
    active_a: int = -1
    active_b: int = -1

    # Field state (live) — weather, terrain, hazards, screens
    # NOTE: named ``field_state`` so the dataclass body doesn't shadow the
    # imported ``field()`` factory from dataclasses.
    field_state: Optional[FieldState] = field(default=None)

    # Battle progression
    turn: int = 0
    trick_room: bool = False
    side_to_move: str = "a"   # which side the active player controls

    # Cached references — purely id lookups (resolved by plugins)
    notes: dict[str, Any] = field(default_factory=dict)

    # ── Constructors from each page's data ────────────────────────────
    @classmethod
    def from_sets(cls, sets: Iterable[SetClass], kg, side_to_move: str = "a") -> "UnifiedState":
        """Project from a saved team (Team Builder) or a list of sets."""
        from pokeredus.classes.pokemon import PokemonClass          # local: avoid cycles

        team_slots: list[UnifiedTeamSlot] = []
        for i, s in enumerate(sets):
            if s is None:
                continue
            ps = PokemonState(pokemon_id=s.pokemon_id, set_id=s.id)
            team_slots.append(
                UnifiedTeamSlot(slot_index=i, pokemon_id=s.pokemon_id, set_id=s.id, pokemon_state=ps)
            )
        if side_to_move == "a":
            us = cls(team_a=team_slots, team_b=[],
                     active_a=0 if team_slots else -1, active_b=-1,
                     side_to_move="a")
        else:
            us = cls(team_a=[], team_b=team_slots,
                     active_a=-1, active_b=0 if team_slots else -1,
                     side_to_move="b")
        return us

    @classmethod
    def from_game_state(cls, game) -> "UnifiedState":
        """Project from a live Simulator GameState.

        ``game`` is duck-typed to avoid pulling numpy via matchup_graph
        at module import time.
        """

        def _convert(team):
            out = []
            for i, ps in enumerate(team):
                out.append(
                    UnifiedTeamSlot(
                        slot_index=i,
                        pokemon_id=ps.pokemon_id,
                        set_id=ps.set_id,
                        pokemon_state=ps,
                    )
                )
            return out

        active_a = game.active_a if game.team_a else -1
        active_b = game.active_b if game.team_b else -1
        return cls(
            team_a=_convert(game.team_a),
            team_b=_convert(game.team_b),
            active_a=active_a,
            active_b=active_b,
            field_state=game.field,
            turn=game.turn,
            trick_room=game.trick_room,
            side_to_move="a",
        )

    @classmethod
    def from_matchup(
        cls,
        left_sets: Iterable[SetClass],
        right_sets: Iterable[SetClass],
        kg,
    ) -> "UnifiedState":
        """Project from a matchup-scoped view (Graph page)."""
        # Build slots directly so neither side gets short-circuited.
        from pokeredus.classes.pokemon import PokemonClass   # local: avoid cycles
        def _slots(sets):
            out = []
            for i, s in enumerate(sets):
                if s is None:
                    continue
                ps = PokemonState(pokemon_id=s.pokemon_id, set_id=s.id)
                out.append(UnifiedTeamSlot(
                    slot_index=i, pokemon_id=s.pokemon_id,
                    set_id=s.id, pokemon_state=ps,
                ))
            return out
        team_a = _slots(left_sets)
        team_b = _slots(right_sets)
        return cls(
            team_a=team_a,
            team_b=team_b,
            active_a=0 if team_a else -1,
            active_b=0 if team_b else -1,
            notes={"projection": "matchup"},
        )

    # ── Active helpers ───────────────────────────────────────────────
    def get_active_slot(self, side: str) -> Optional[UnifiedTeamSlot]:
        team = self.team_a if side == "a" else self.team_b
        idx = self.active_a if side == "a" else self.active_b
        if 0 <= idx < len(team):
            return team[idx]
        return None

    def get_bench(self, side: str) -> list[UnifiedTeamSlot]:
        team = self.team_a if side == "a" else self.team_b
        idx = self.active_a if side == "a" else self.active_b
        return [slot for i, slot in enumerate(team) if i != idx]

    # ── Apply an action to mutate the state ──────────────────────────
    def apply_action(self, action: UnifiedAction) -> bool:
        """Apply a move/switch in-place. Returns True if state changed."""
        if action.kind == "switch":
            target = action.detail.get("bench_index")
            if target is None:
                return False
            new_active = int(target)
            if self.side_to_move == "a":
                if 0 <= new_active < len(self.team_a):
                    self.active_a = new_active
                    self.active_bump_turns("a")
                    return True
            else:
                if 0 <= new_active < len(self.team_b):
                    self.active_b = new_active
                    self.active_bump_turns("b")
                    return True
            return False

        if action.kind == "move":
            slot = self.get_active_slot(self.side_to_move)
            if slot is None or slot.pokemon_state is None:
                return False
            slot.pokemon_state.use_move(action.detail.get("move_id", ""))
            slot.pokemon_state.turns_active += 1
            return True

        # "tera" is recorded as a note; not modeled dynamically here
        if action.kind == "tera":
            self.notes["tera_used"] = action.detail.get("tera_type")
            return True

        return False

    def active_bump_turns(self, side: str) -> None:
        """Reset incoming poke's turns_active — used by switch path."""
        slot = self.get_active_slot(side)
        if slot and slot.pokemon_state is not None:
            slot.pokemon_state.switch_in()

    # ── Build a fresh GameState mirror (for damage calc etc.) ─────────
    def to_game_state(self):
        # Lazy import to avoid pulling numpy via matchup_graph at module
        # import time of pokemonedus.unified.
        from pokeredus.graph.game_state import GameState as _GS
        game = _GS()
        game.team_a = [s.pokemon_state for s in self.team_a if s.pokemon_state]
        game.team_b = [s.pokemon_state for s in self.team_b if s.pokemon_state]
        game.active_a = self.active_a if game.team_a else 0
        game.active_b = self.active_b if game.team_b else 0
        game.field = self.field_state if self.field_state is not None else FieldState()
        game.turn = self.turn
        game.trick_room = self.trick_room
        return game


# ═══════════════════════════════════════════════════════════════════════
# Scene persistence — JSON-safe serialization
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class SerializedSnapshot:
    """JSON-serializable snapshot of a UnifiedState.

    Designed so a model can ingest it both ways:
      * read the structured dict (programmatic agents)
      * read the plain-text scene (LLM / RL policies)
    """

    version: int = 1
    scene_id: str = ""
    captured_at: str = ""
    state: dict[str, Any] = field(default_factory=dict)
    set_lookup: dict[str, dict] = field(default_factory=dict)   # set_id → set dict
    pokemon_lookup: dict[str, dict] = field(default_factory=dict)  # pokemon_id → pokemon dict
    move_lookup: dict[str, dict] = field(default_factory=dict)   # move_id → move dict
    meta: dict[str, Any] = field(default_factory=dict)

    # ── Build from UnifiedState + KnowledgeGraph ─────────────────────
    @classmethod
    def build(
        cls,
        unified: UnifiedState,
        kg,
        set_ids: Optional[Iterable[str]] = None,
    ) -> "SerializedSnapshot":
        """Enrich UnifiedState with set/pokemon/move lookups from KG."""
        set_lookup: dict[str, dict] = {}
        pokemon_lookup: dict[str, dict] = {}
        move_lookup: dict[str, dict] = {}

        # Decide which sets we need to look up: every slot's set
        slot_set_ids: list[str] = []
        for slot in list(unified.team_a) + list(unified.team_b):
            if slot.set_id and slot.set_id not in slot_set_ids:
                slot_set_ids.append(slot.set_id)

        for sid in (set_ids or slot_set_ids):
            s = kg.get_set(sid)
            if s is None:
                continue
            set_lookup[sid] = s.to_dict()
            p = kg.get_pokemon(s.pokemon_id)
            if p:
                pokemon_lookup[p.id] = p.to_dict()
            for mid in s.moves:
                m = kg.get_move(mid)
                if m:
                    move_lookup[m.id] = m.to_dict()

        # Compact pokemon_state (drop the attribute registry — too verbose)
        def _compact_team(team):
            compact = []
            for slot in team:
                if slot.pokemon_state is None:
                    compact.append({
                        "slot_index": slot.slot_index,
                        "pokemon_id": slot.pokemon_id,
                        "set_id": slot.set_id,
                    })
                    continue
                ps = slot.pokemon_state
                compact.append({
                    "slot_index": slot.slot_index,
                    "pokemon_id": slot.pokemon_id,
                    "set_id": slot.set_id,
                    "current_hp": ps.current_hp,
                    "max_hp": ps.max_hp,
                    "hp_percent": round(ps.hp_percent, 1),
                    "status": _status_text(ps),
                    "fainted": ps.is_fainted,
                    "boosts": _boosts_dict(ps),
                    "active": ps.is_active,
                    "turns_active": ps.turns_active,
                })
            return compact

        scene_team_a = _compact_team(unified.team_a)
        scene_team_b = _compact_team(unified.team_b)

        # Compact field — list of names + categories only
        field_dict = None
        if unified.field_state is not None:
            field_dict = {
                "weather": unified.field_state.get_weather(),
                "terrain": unified.field_state.get_terrain(),
                "side_a": [a.name for a in unified.field_state.side_a_attributes],
                "side_b": [a.name for a in unified.field_state.side_b_attributes],
            }

        scene_state = {
            "team_a": scene_team_a,
            "team_b": scene_team_b,
            "active_a": unified.active_a,
            "active_b": unified.active_b,
            "field": field_dict,
            "turn": unified.turn,
            "trick_room": unified.trick_room,
            "side_to_move": unified.side_to_move,
        }

        import datetime as _dt
        return cls(
            version=1,
            scene_id="",
            captured_at=_dt.datetime.now(_dt.timezone.utc).isoformat(),
            state=scene_state,
            set_lookup=set_lookup,
            pokemon_lookup=pokemon_lookup,
            move_lookup=move_lookup,
        )

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)

    @classmethod
    def from_json(cls, text: str) -> "SerializedSnapshot":
        data = json.loads(text)
        return cls(**data)

    def write(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.to_json(), encoding="utf-8")

    @classmethod
    def read(cls, path: str | Path) -> "SerializedSnapshot":
        return cls.from_json(Path(path).read_text(encoding="utf-8"))


# ── Helpers used by SerializedSnapshot.build ─────────────────────────


def _status_text(ps: PokemonState) -> str:
    """First non-volatile status, lowercase. '' if none."""
    for cond in ("burn", "poison", "toxic", "sleep", "paralysis", "freeze"):
        if ps.has_condition(cond):
            return cond
    return ""


def _boosts_dict(ps: PokemonState) -> dict[str, int]:
    """Convert PokemonState.attributes into a {stat: stages} dict (only nonzero)."""
    out: dict[str, int] = {}
    for attr in ps.attributes:
        if attr.attribute_type != "stat_mod":
            continue
        stat = getattr(attr, "stat", None) or attr.params.get("stat")
        stages = getattr(attr, "stages", None)
        if stages is None:
            stages = attr.params.get("stages", 0)
        if stat and stages != 0 and stat not in out:
            out[stat] = int(stages)
    return out


# ═══════════════════════════════════════════════════════════════════════
# Plain-text scene — text an external intelligence can ingest
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class PlainTextScene:
    """The UnifiedState rendered as text.

    Three modes (compact < verbose < tokens):
      * compact:  one-line per slot, abbreviated types, no justification
      * verbose:  multi-line per slot, full type strings, full move lists
      * tokens:   white-space-separated tokens, no punctuation (best for
                  small-vocab sequence models / BERT-style tokenizers)

    The text is designed to be re-parseable: a slot line always starts
    with the slot tier role, the active slot is marked `[A]`. Use
    `parse_scene(corpus, kg)` to reconstruct a UnifiedState.
    """

    text: str = ""
    mode: str = "compact"

    def __str__(self) -> str:
        return self.text


# ── Scenes ────────────────────────────────────────────────────────────


def render_scene(
    unified: UnifiedState,
    kg,
    mode: str = "compact",
) -> PlainTextScene:
    """Render UnifiedState into a PlainTextScene using KG to resolve names."""
    if mode not in {"compact", "verbose", "tokens"}:
        raise ValueError(f"mode must be compact/verbose/tokens, got {mode!r}")

    sections: list[str] = []
    if mode == "verbose":
        sections.append("# Pokemon Redus Unified Scene v1")
        sections.append(f"Turn {unified.turn}; side_to_move={unified.side_to_move}; trick_room={unified.trick_room}")

    sections.append(_render_side(unified, "a", kg, mode))
    sections.append(_render_side(unified, "b", kg, mode))

    if unified.field_state is not None:
        sections.append(_render_field(unified, mode))

    sep = "\n" if mode == "verbose" else " | "
    return PlainTextScene(text=sep.join(sections), mode=mode)


def _render_side(unified: UnifiedState, side: str, kg, mode: str) -> str:
    team = unified.team_a if side == "a" else unified.team_b
    active_idx = unified.active_a if side == "a" else unified.active_b
    side_label = "SideA" if side == "a" else "SideB"

    if not team:
        return f"{side_label}:empty"

    if mode == "verbose":
        lines = [f"# {side_label} team ({len(team)} slots) — active={active_idx}"]
    elif mode == "tokens":
        lines = [f"{side_label} active={active_idx}"]
    else:
        lines = [f"{side_label} active={active_idx}"]

    for slot in team:
        lines.append(_render_slot(slot, slot.slot_index == active_idx, kg, mode))

    if mode == "verbose":
        return "\n".join(lines)
    return " ".join(lines) if mode == "tokens" else " | ".join(lines)


def _render_slot(slot: UnifiedTeamSlot, is_active: bool, kg, mode: str) -> str:
    s = kg.get_set(slot.set_id)
    p = kg.get_pokemon(slot.pokemon_id)
    types = "/".join(p.types) if p else "?"
    name = p.name if p else slot.pokemon_id
    set_name = s.set_name if s else "?"

    abbrev = _abbreviate_types(p.types if p else [])
    status = _status_text(slot.pokemon_state) if slot.pokemon_state else ""
    hp_pct = round(slot.pokemon_state.hp_percent, 0) if slot.pokemon_state else 100
    active_flag = "[A]" if is_active else "   "

    if mode == "compact":
        return (
            f"{active_flag}{slot.slot_index}:{name}({set_name}) "
            f"{abbrev} hp={hp_pct:.0f}%{(' ' + status) if status else ''}"
        )
    if mode == "tokens":
        return (
            f"{active_flag} slot={slot.slot_index} pokemon={_slugify(name)} "
            f"set={_slugify(set_name)} types={abbrev} hp={int(hp_pct)} "
            f"status={status or 'none'}"
        )
    # verbose
    moves_str = ", ".join(s.moves) if s else ""
    boost_str = ""
    if slot.pokemon_state is not None:
        boosts = _boosts_dict(slot.pokemon_state)
        if boosts:
            boost_str = " boosts=" + ",".join(f"{k}:{v}" for k, v in boosts.items())
    return (
        f"  {active_flag} slot {slot.slot_index}: {name} [{set_name}]\n"
        f"    types: {types}   hp: {hp_pct:.0f}\n"
        f"    status: {status or 'none'}{boost_str}\n"
        f"    moves: {moves_str}"
    )


def _render_field(unified: UnifiedState, mode: str) -> str:
    f = unified.field_state
    weather = f.get_weather() if f else None
    terrain = f.get_terrain() if f else None
    if mode == "verbose":
        return f"# Field: weather={weather}, terrain={terrain}, trick_room={unified.trick_room}"
    if mode == "tokens":
        return f"weather={weather or 'none'} terrain={terrain or 'none'} trick_room={unified.trick_room}"
    parts = [f"weather={weather or 'none'}", f"terrain={terrain or 'none'}"]
    if unified.trick_room:
        parts.append("trick_room")
    return "field:" + " ".join(parts)


def _abbreviate_types(types: Iterable[str]) -> str:
    """3-letter abbrev so compact output stays narrow."""
    table = {
        "Normal": "NOR", "Fire": "FIR", "Water": "WAT", "Electric": "ELE",
        "Grass": "GRA", "Ice": "ICE", "Fighting": "FGT", "Poison": "PSN",
        "Ground": "GND", "Flying": "FLY", "Psychic": "PSY", "Bug": "BUG",
        "Rock": "ROC", "Ghost": "GHO", "Dragon": "DRG", "Dark": "DRK",
        "Steel": "STL", "Fairy": "FAY",
    }
    out = "/".join(table.get(t, t[:3].upper()) for t in types)
    return out or "?"


def _slugify(text: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "_" for ch in text).strip("_")


# ═══════════════════════════════════════════════════════════════════════
# Parsing — turn the plain text back into a UnifiedState
# ═══════════════════════════════════════════════════════════════════════


def parse_scene(text: str, kg) -> UnifiedState:
    """Reconstruct a UnifiedState from a compact-mode text scene.

    Supports both compact and tokens modes (they share most of the
    syntax). Verbose mode is read-only — too rich for fast parsing.

    This is the *training ingestion* path: an external system emits
    the text, we rebuild the snapshot, then we feed it into the same
    optimal-action engine the simulator uses.
    """
    unified = UnifiedState()
    current_side: str | None = None
    active_indices: dict[str, int] = {"a": -1, "b": -1}

    field = FieldState()
    unified.field_state = field
    unified.turn = 0
    unified.trick_room = False

    # Split on either newline OR ' | ' so we round-trip the compact/tokens
    # formats (which encode multiple slots per line).
    for raw_line in (
        line
        for chunk in text.splitlines()
        for line in chunk.split(" | ")
    ):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # Side header
        if line.startswith("SideA"):
            current_side = "a"
            unified.team_a = []
            active_a_header = _extract_active(line)
            if active_a_header is not None:
                active_indices["a"] = active_a_header
            continue
        if line.startswith("SideB"):
            current_side = "b"
            unified.team_b = []
            active_b_header = _extract_active(line)
            if active_b_header is not None:
                active_indices["b"] = active_b_header
            continue

        # Field
        if line.startswith("field:") or "weather=" in line and current_side is None:
            unified.trick_room = "trick_room" in line
            continue

        # Slot line
        if current_side is None:
            continue
        slot = _parse_slot_line(line, kg)
        if slot is None:
            continue
        if current_side == "a":
            unified.team_a.append(slot)
        else:
            unified.team_b.append(slot)

    unified.active_a = active_indices["a"] if unified.team_a else -1
    unified.active_b = active_indices["b"] if unified.team_b else -1
    return unified


def _extract_active(line: str) -> Optional[int]:
    import re
    m = re.search(r"active\s*=\s*(-?\d+)", line)
    if m:
        return int(m.group(1))
    return None


def _parse_slot_line(line: str, kg) -> Optional[UnifiedTeamSlot]:
    """Best-effort slot reconstruction from a slot line."""
    import re

    is_active = line.startswith("[A]") or line.startswith("[A ")
    # Strip the [A] / active= marker; we'll set active from the side header
    line = re.sub(r"^\[A\]\s*", "", line).strip()

    # compact mode: SLOT:PokemonName(Set Name) DRG/GND hp=100%
    m = re.match(r"(?:slot=)?(\d+)\s*:\s*(\S+?)\(([^)]+)\)", line)
    if m:
        slot_index = int(m.group(1))
        pokemon_name = m.group(2)
        set_label = m.group(3).strip()
        pokemon_id = _find_pokemon_id_by_name(pokemon_name, kg)
        set_id = _find_set_id_by_label(pokemon_id, set_label, kg)
        if pokemon_id and set_id:
            ps = PokemonState(pokemon_id=pokemon_id, set_id=set_id)
            return UnifiedTeamSlot(slot_index=slot_index, pokemon_id=pokemon_id, set_id=set_id, pokemon_state=ps)

    # tokens mode: pokemon=NAME set=NAME
    m2 = re.search(r"slot=(\d+)\s+pokemon=(\S+)\s+set=(\S+)", line)
    if m2:
        slot_index = int(m2.group(1))
        pokemon_id = _find_pokemon_id_by_slug(m2.group(2), kg)
        set_id = _find_set_id_by_slug(pokemon_id, m2.group(3), kg)
        if pokemon_id and set_id:
            ps = PokemonState(pokemon_id=pokemon_id, set_id=set_id)
            return UnifiedTeamSlot(slot_index=slot_index, pokemon_id=pokemon_id, set_id=set_id, pokemon_state=ps)
    return None


def _find_pokemon_id_by_name(name: str, kg) -> Optional[str]:
    """Linear search is fine — only called during parsing, not in hot path."""
    name_l = name.lower().strip()
    for p in kg.get_all_pokemon():
        if p.name.lower() == name_l:
            return p.id
    return None


def _find_pokemon_id_by_slug(slug: str, kg) -> Optional[str]:
    slug_l = slug.lower().strip().replace("_", " ")
    for p in kg.get_all_pokemon():
        if _slugify(p.name) == slug:
            return p.id
        if p.name.lower() == slug_l:
            return p.id
    return None


def _find_set_id_by_label(pokemon_id: Optional[str], label: str, kg) -> Optional[str]:
    if not pokemon_id:
        return None
    for s in kg.get_sets(pokemon_id):
        if s.set_name.lower().replace(" ", "_") == label.lower():
            return s.id
    # Fallback: first set of the pokemon
    sets = list(kg.get_sets(pokemon_id))
    return sets[0].id if sets else None


def _find_set_id_by_slug(pokemon_id: Optional[str], slug: str, kg) -> Optional[str]:
    if not pokemon_id:
        return None
    for s in kg.get_sets(pokemon_id):
        if _slugify(s.set_name) == slug:
            return s.id
    sets = list(kg.get_sets(pokemon_id))
    return sets[0].id if sets else None


# ═══════════════════════════════════════════════════════════════════════
# Optimal action engine — "given current state, what should I do?"
# ═══════════════════════════════════════════════════════════════════════

# Try to use the AI queries that already exist (battle-tested in graph page).
try:
    from pokeredus.graph.matchup_graph import (
        pick_best_move,
        find_optimal_switch,
        SWITCH_ADVANTAGE_THRESHOLD,
    )
    _HAS_AI_QUERIES = True
except Exception:  # pragma: no cover
    _HAS_AI_QUERIES = False
    SWITCH_ADVANTAGE_THRESHOLD = 0.3


def recommend_actions(unified: UnifiedState, kg) -> list[UnifiedAction]:
    """Compute the optimal-action list for `side_to_move`.

    Returns a list of UnifiedAction sorted by score (best first), each with
    reasoning attached. The first entry is the recommendation; the rest
    are alternates the model can consider. If no AI queries are available,
    falls back to a heuristic "rank all moves" output.

    Reuses the existing `pick_best_move` and `find_optimal_switch` so the
    intelligence here is identical to the one that drove the matchup graph.
    """
    side = unified.side_to_move
    opp_side = "b" if side == "a" else "a"
    me_slot = unified.get_active_slot(side)
    opp_slot = unified.get_active_slot(opp_side)
    if me_slot is None:
        return []

    me_set = kg.get_set(me_slot.set_id)
    actions: list[UnifiedAction] = []

    if _HAS_AI_QUERIES and me_set is not None:
        # ── MOVE OPTIONS (only if opponent is present and active) ─────
        if opp_slot is not None:
            opp_set = kg.get_set(opp_slot.set_id)
            if opp_set is not None:
                try:
                    rankings = pick_best_move(me_set, opp_set, kg)
                except Exception:
                    rankings = []
                for r in rankings:
                    move = kg.get_move(r.move_id)
                    actions.append(UnifiedAction(
                        kind="move",
                        label=r.move_name,
                        detail={
                            "move_id": r.move_id,
                            "move_type": getattr(move, "type", ""),
                            "category": getattr(move, "category", ""),
                            "base_power": getattr(move, "base_power", 0),
                            "priority": getattr(move, "priority", 0),
                            "is_status": getattr(move, "is_status", False),
                        },
                        score=r.score,
                        reasoning=[r.reasoning] if r.reasoning else [],
                    ))

        # ── SWITCH OPTIONS ─────────────────────────────────────────────
        bench = unified.get_bench(side)
        bench_sets = [kg.get_set(s.set_id) for s in bench if s.set_id]
        bench_sets = [s for s in bench_sets if s is not None]
        if opp_slot is not None and bench_sets:
            opp_set = kg.get_set(opp_slot.set_id)
            if opp_set is not None:
                try:
                    switch_rankings = find_optimal_switch(opp_set, bench_sets, kg)
                except Exception:
                    switch_rankings = []
                bench_by_id = {s.set_id: s for s in bench}
                for r in switch_rankings:
                    bench_slot = next(
                        (b for b in bench if b.set_id == r.set_id), None
                    )
                    if bench_slot is None:
                        continue
                    p = kg.get_pokemon(r.pokemon_id)
                    pname = p.name if p else r.pokemon_id
                    actions.append(UnifiedAction(
                        kind="switch",
                        label=f"Switch to {pname} ({r.set_name})",
                        detail={
                            "bench_index": bench_slot.slot_index,
                            "pokemon_id": r.pokemon_id,
                            "set_id": r.set_id,
                            "speed_advantage": r.speed_advantage,
                            "type_matchup": r.type_matchup,
                        },
                        score=r.score,
                        reasoning=list(r.reasons),
                    ))

    # ── TERA (cheap heuristic: type that flips the worst weakness) ───
    p = kg.get_pokemon(me_slot.pokemon_id)
    if p is not None and getattr(p, "tera_type_known", None) is not None:
        actions.append(UnifiedAction(
            kind="tera",
            label=f"Terastallize to {p.tera_type_known}",
            detail={"tera_type": p.tera_type_known},
            score=0.0,
            reasoning=["type-changing terastallize (model nuance)"],
        ))

    # Fallback: at least one move action exists when AI queries are missing
    if not actions and me_set is not None:
        for mid in me_set.moves:
            move = kg.get_move(mid)
            actions.append(UnifiedAction(
                kind="move",
                label=move.name if move else mid,
                detail={"move_id": mid},
                score=0.0,
                reasoning=["fallback: no AI query support"],
            ))

    # Sort — best first
    actions.sort(key=lambda a: a.score, reverse=True)
    if actions:
        actions[0].is_recommended = True
    return actions


# ═══════════════════════════════════════════════════════════════════════
# TrainingSample — pair a scene with the action an agent took
# ═══════════════════════════════════════════════════════════════════════


@dataclass
class TrainingSample:
    """One self-supervised data point: scene + chosen action (+optional reward).

    The model learns: given scene_text → predict action_text.

    `mode` is the scene render mode that was used; the training model
    must see the same mode at inference time. Use the same unified
    rendering pipeline to keep text distribution aligned.
    """

    scene_id: str = ""
    turn: int = 0
    side_to_move: str = "a"
    mode: str = "compact"
    scene_text: str = ""
    action_text: str = ""           # UnifiedAction.to_text() form
    action_kind: str = ""
    action_detail: dict[str, Any] = field(default_factory=dict)
    score: float = 0.0
    reward: Optional[float] = None  # filled in by self-play evaluator

    def to_dict(self) -> dict:
        return asdict(self)


def make_training_sample(
    unified: UnifiedState,
    action: UnifiedAction,
    kg,
    mode: str = "compact",
    include_alternates: bool = False,
) -> TrainingSample:
    """Build one TrainingSample from a state + chosen action."""
    scene = render_scene(unified, kg, mode)
    return TrainingSample(
        scene_id="",
        turn=unified.turn,
        side_to_move=unified.side_to_move,
        mode=mode,
        scene_text=str(scene),
        action_text=action.to_text(compact=(mode != "verbose")),
        action_kind=action.kind,
        action_detail=dict(action.detail),
        score=action.score,
    )


def training_samples_from_actions(
    unified: UnifiedState,
    actions: list[UnifiedAction],
    kg,
    mode: str = "compact",
    reward_field: Optional[dict[str, float]] = None,
) -> list[TrainingSample]:
    """Build a TrainingSample per action in the recommendation list.

    Each sample gets the same scene_text (it's the same situation from
    different candidate actions). The reward map can attach past outcomes
    to the chosen action.
    """
    scene = render_scene(unified, kg, mode)
    samples: list[TrainingSample] = []
    for a in actions:
        samples.append(TrainingSample(
            turn=unified.turn,
            side_to_move=unified.side_to_move,
            mode=mode,
            scene_text=str(scene),
            action_text=a.to_text(compact=(mode != "verbose")),
            action_kind=a.kind,
            action_detail=dict(a.detail),
            score=a.score,
            reward=(reward_field.get(a.label) if reward_field else None),
        ))
    return samples


# ═══════════════════════════════════════════════════════════════════════
# Bulk training-export helper
# ═══════════════════════════════════════════════════════════════════════


def export_training_corpus(
    scenes: Iterable[tuple[UnifiedState, list[UnifiedAction]]],
    kg,
    path: str | Path,
    mode: str = "compact",
) -> int:
    """Write (scene, actions) pairs as JSONL training data.

    Each line is one alternate action against one scene. Returns the
    number of lines written.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with p.open("w", encoding="utf-8") as f:
        for unified, actions in scenes:
            samples = training_samples_from_actions(unified, actions, kg, mode=mode)
            for s in samples:
                f.write(json.dumps(s.to_dict(), sort_keys=True) + "\n")
                n += 1
    return n


# ═══════════════════════════════════════════════════════════════════════
# Convenience access
# ═══════════════════════════════════════════════════════════════════════


__all__ = [
    "UnifiedAction",
    "UnifiedTeamSlot",
    "UnifiedState",
    "SerializedSnapshot",
    "PlainTextScene",
    "TrainingSample",
    "render_scene",
    "parse_scene",
    "recommend_actions",
    "make_training_sample",
    "training_samples_from_actions",
    "export_training_corpus",
]
