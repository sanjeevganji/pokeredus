"""
matchup_graph — 3D matchup graph for PokeRedus.

Maps every competitive set (and composites of sets, i.e. teams) into a
three-axis space:

  Axis 1: Type affinity vector (18 discrete cells, one per Pokémon type)
  Axis 2: Offense ↔ Defense spectrum (continuous in [-1, +1])
  Axis 3: Speed / Control / Utility simplex (3-vector summing to 1)

This module is the data layer that powers AI decisions about type
matchups, speed tiers, and offensive/defensive balance.

Design:
  - Pure-Python dataclasses (no NetworkX for projections).
  - On-demand computation; results can be cached by the caller.
  - Generalized to work for single Pokémon, sets, or teams.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Iterable

from pokeredus.classes import (
    SetClass, POKEMON_TYPES, TYPE_CHART, get_effectiveness,
)

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph


# ── Constants for the SCU axis ───────────────────────────────────────

# Pivot and recovery moves (lowercase move.id) for control_score.
PIVOT_OR_RECOVERY: set[str] = {
    "uturn", "voltswitch", "partingshot", "whirlwind", "roar", "haze",
    "dragontail", "circlethrow", "recover", "softboiled", "slackoff",
    "wish", "roost", "morningsun", "moonlight", "synthesis",
    "milkdrink", "healorder",
}

# Hazard-setting moves (lowercase move.id) for utility_score.
HAZARD_SETTERS: set[str] = {
    "stealthrock", "spikes", "toxicspikes", "stickyweb",
}

# Hazard-removing moves.
HAZARD_REMOVERS: set[str] = {
    "defog", "rapidspin", "mortalspin", "tidyup",
}

# Field-condition setters (weather, terrain, screens, room setters).
FIELD_SETTERS: set[str] = {
    "sunnyday", "raindance", "sandstorm", "snowscape",
    "electricterrain", "grassyterrain", "psychicterrain", "mistyterrain",
    "lightscreen", "reflect", "auroraveil", "tailwind", "trickroom",
}

# How many pivot/recovery moves count as "full control".
CONTROL_DENOMINATOR: float = 3.0

# How many of each utility bucket sum to a full score.
UTILITY_HAZARD_SETTER_WEIGHT: float = 0.4
UTILITY_HAZARD_REMOVER_WEIGHT: float = 0.3
UTILITY_FIELD_SETTER_WEIGHT: float = 0.3


# ═════════════════════════════════════════════════════════════════════
# Data structures
# ═════════════════════════════════════════════════════════════════════

@dataclass
class MatchupGraphNode:
    """A single point in 3D matchup-graph space.

    Fields:
      id: stable identifier (set_id for a set, or hash of member ids for a team)
      kind: "set" or "team"
      label: human-readable name
      axis_type_vector: 18-cell dict of type_name -> affinity in [0, 1]
      axis_offdef: float in [-1, +1] (offense-leaning positive, defense-leaning negative)
      axis_speed_control_utility: 3-tuple summing to 1, all >= 0
      member_ids: list of set_ids that comprise this node
    """

    id: str
    kind: str
    label: str
    axis_type_vector: dict[str, float] = field(default_factory=dict)
    axis_offdef: float = 0.0
    axis_speed_control_utility: tuple[float, float, float] = (1.0, 0.0, 0.0)
    member_ids: list[str] = field(default_factory=list)


@dataclass
class GraphProjection:
    """Result of a projection call: node + metadata."""

    target_id: str
    node: MatchupGraphNode
    computed_at: str = ""


@dataclass
class MoveRanking:
    """A single move ranked for use against a specific defender.

    score: combined heuristic (damage + type effectiveness + utility).
    reasoning: human-readable explanation of why this score was assigned.
    type_effectiveness: multiplier for the move's type vs defender.
    is_stab: True if the move is STAB for the attacker.
    estimated_damage_pct: best-case damage roll as % of defender's HP (0-100).
    """

    move_id: str
    move_name: str
    score: float
    reasoning: str
    type_effectiveness: float = 1.0
    is_stab: bool = False
    estimated_damage_pct: float = 0.0


@dataclass
class SwitchRanking:
    """A candidate switch-in ranked against a specific opponent.

    score: combined heuristic (type resist + speed + 3D distance).
    reasons: list of human-readable explanations.
    """

    set_id: str
    pokemon_id: str
    set_name: str
    score: float
    reasons: list[str] = field(default_factory=list)
    type_matchup: float = 1.0  # 0..4, product of incoming effectiveness
    speed_advantage: str = "tie"  # "us", "them", "tie"


@dataclass
class TurnPlan:
    """A composed turn plan returned by analyze_game_state.

    recommended_switch: SwitchRanking | None (None means stay in)
    recommended_move: MoveRanking | None
    confidence: float in [0, 1]
    reasoning_chain: list[str] of human-readable explanations
    """

    recommended_switch: SwitchRanking | None
    recommended_move: MoveRanking | None
    confidence: float = 0.5
    reasoning_chain: list[str] = field(default_factory=list)


@dataclass
class MatchupGraph:
    """Container for projected 3D matchup-graph nodes.

    Storage is a plain dict. Use ``build_for_ou`` to precompute the
    whole OU graph at once, or ``project_and_add`` to add nodes
    one at a time as they're needed.
    """

    _nodes: dict[str, MatchupGraphNode] = field(default_factory=dict)

    def add(self, node: MatchupGraphNode) -> None:
        self._nodes[node.id] = node

    def get(self, node_id: str) -> MatchupGraphNode | None:
        return self._nodes.get(node_id)

    def all(self) -> list[MatchupGraphNode]:
        return list(self._nodes.values())

    def __len__(self) -> int:
        return len(self._nodes)

    def __contains__(self, node_id: str) -> bool:
        return node_id in self._nodes

    def project_and_add(self, target, kg: "KnowledgeGraph") -> MatchupGraphNode:
        """Project a target and store the resulting node. Returns it."""
        node = project_to_3d(target, kg)
        self.add(node)
        return node

    def build_for_ou(self, kg: "KnowledgeGraph") -> int:
        """Project every set in the graph. Returns the number of nodes added."""
        for s in kg.get_all_sets():
            self.project_and_add(s, kg)
        return len(self._nodes)

    # ── serialization ───────────────────────────────────────────────

    def to_json(self) -> dict:
        return {
            "nodes": [
                {
                    "id": n.id,
                    "kind": n.kind,
                    "label": n.label,
                    "axis_type_vector": dict(n.axis_type_vector),
                    "axis_offdef": n.axis_offdef,
                    "axis_speed_control_utility": list(n.axis_speed_control_utility),
                    "member_ids": list(n.member_ids),
                }
                for n in self._nodes.values()
            ]
        }

    @classmethod
    def from_json(cls, payload: dict) -> "MatchupGraph":
        g = cls()
        for n in payload.get("nodes", []):
            scu = tuple(n["axis_speed_control_utility"])
            g.add(MatchupGraphNode(
                id=n["id"],
                kind=n["kind"],
                label=n["label"],
                axis_type_vector=dict(n["axis_type_vector"]),
                axis_offdef=n["axis_offdef"],
                axis_speed_control_utility=scu,
                member_ids=list(n["member_ids"]),
            ))
        return g

    def save(self, path) -> None:
        from pathlib import Path
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_json(), f, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path) -> "MatchupGraph":
        from pathlib import Path
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return cls.from_json(payload)


# ═════════════════════════════════════════════════════════════════════
# Target resolution helpers
# ═════════════════════════════════════════════════════════════════════

def _resolve_sets(target, kg: "KnowledgeGraph") -> list[SetClass]:
    """Normalize a target (SetClass | str | list) to a list of SetClass."""
    if isinstance(target, list):
        return [_resolve_one(t, kg) for t in target if _resolve_one(t, kg) is not None]
    one = _resolve_one(target, kg)
    return [one] if one is not None else []


def _resolve_one(target, kg: "KnowledgeGraph") -> SetClass | None:
    """Resolve one target (SetClass or set_id) to a SetClass."""
    if isinstance(target, SetClass):
        return target
    if isinstance(target, str):
        return kg.get_set(target)
    return None


# ═════════════════════════════════════════════════════════════════════
# Axis 1: Type affinity vector
# ═════════════════════════════════════════════════════════════════════

def project_type_axis(target, kg: "KnowledgeGraph") -> dict[str, float]:
    """Return the 18-cell type affinity vector for a set or team.

    For a single set:
      - Start with zero vector over POKEMON_TYPES.
      - For each type in pokemon.types: cell[T] += 0.5.
      - For each STAB move: cell[move.type] += 0.3.
      - For each nuke (base_power >= 100): cell[move.type] += 0.2.
      - Cap each cell at 1.0.

    For a team: element-wise mean of per-member vectors.
    """
    sets = _resolve_sets(target, kg)
    if not sets:
        return {t: 0.0 for t in POKEMON_TYPES}

    if len(sets) == 1:
        return _type_axis_for_set(sets[0], kg)

    # Team: average of member vectors
    member_vecs = [_type_axis_for_set(s, kg) for s in sets]
    return {
        t: sum(v[t] for v in member_vecs) / len(member_vecs)
        for t in POKEMON_TYPES
    }


def _type_axis_for_set(set_obj: SetClass, kg: "KnowledgeGraph") -> dict[str, float]:
    vec: dict[str, float] = {t: 0.0 for t in POKEMON_TYPES}
    pokemon = kg.get_pokemon(set_obj.pokemon_id)
    if pokemon is None:
        return vec

    # Base type affinity
    for t in pokemon.types:
        if t in vec:
            vec[t] = min(1.0, vec[t] + 0.5)

    # STAB + nuke contributions from moves
    for move_id in set_obj.moves:
        move = kg.get_move(move_id)
        if move is None:
            continue
        if move.is_status or move.base_power <= 0:
            continue
        if move.type in vec:
            if move.type in pokemon.types:
                vec[move.type] = min(1.0, vec[move.type] + 0.3)
            if move.base_power >= 100:
                vec[move.type] = min(1.0, vec[move.type] + 0.2)

    return vec


# ═════════════════════════════════════════════════════════════════════
# Axis 2: Offense ↔ Defense spectrum
# ═════════════════════════════════════════════════════════════════════

def project_offdef_axis(target, kg: "KnowledgeGraph") -> float:
    """Return the offense↔defense score in [-1, +1] for a set or team.

    Formula (per set, level 100):
      offense = (atk + spa) / 2
      bulk    = (hp * 0.5) + ((def + spd) * 0.75)
      ratio   = (offense / max(bulk, 1)) - 0.5
      score   = tanh(ratio * 2.0)

    For a team: BST-weighted average of member scores.
    """
    sets = _resolve_sets(target, kg)
    if not sets:
        return 0.0
    if len(sets) == 1:
        return _offdef_for_set(sets[0], kg)

    # Team: BST-weighted average
    scores = []
    weights = []
    for s in sets:
        scores.append(_offdef_for_set(s, kg))
        p = kg.get_pokemon(s.pokemon_id)
        if p is not None:
            weights.append(max(1, p.bst))
        else:
            weights.append(1)
    total_w = sum(weights)
    if total_w <= 0:
        return 0.0
    return sum(s * w for s, w in zip(scores, weights)) / total_w


def _offdef_for_set(set_obj: SetClass, kg: "KnowledgeGraph") -> float:
    pokemon = kg.get_pokemon(set_obj.pokemon_id)
    if pokemon is None:
        return 0.0
    atk = set_obj.effective_stat("atk", pokemon.base_stats, level=100)
    spa = set_obj.effective_stat("spa", pokemon.base_stats, level=100)
    defense = set_obj.effective_stat("def", pokemon.base_stats, level=100)
    spd = set_obj.effective_stat("spd", pokemon.base_stats, level=100)
    hp = set_obj.effective_stat("hp", pokemon.base_stats, level=100)

    offense = (atk + spa) / 2
    bulk = (hp * 0.5) + ((defense + spd) * 0.75)
    if bulk <= 0:
        bulk = 1
    ratio = (offense / bulk) - 0.5
    return math.tanh(ratio * 2.0)


# ═════════════════════════════════════════════════════════════════════
# Axis 3: Speed / Control / Utility simplex
# ═════════════════════════════════════════════════════════════════════

def project_scu_axis(target, kg: "KnowledgeGraph") -> tuple[float, float, float]:
    """Return the (speed, control, utility) 3-simplex for a set or team.

    For a single set:
      speed_score  = clamp((effective_spe - 60) / 100, 0, 1)
      control_score = min(1.0, pivot_or_recovery_count / 3.0)
      utility_score = clamp(0.4*has_hazard_setter
                            + 0.3*has_hazard_remover
                            + 0.3*has_field_setter, 0, 1)

    Projected to a 3-simplex (sum=1, all >= 0):
      - If sum > 1, divide by sum.
      - If sum < 1, add the remainder to the largest component.

    For a team: mean of member SCU tuples.
    """
    sets = _resolve_sets(target, kg)
    if not sets:
        return (1.0, 0.0, 0.0)
    if len(sets) == 1:
        return _project_to_simplex(*_scu_raw_for_set(sets[0], kg))

    member_scu = [_scu_raw_for_set(s, kg) for s in sets]
    n = len(member_scu)
    raw = tuple(sum(m[i] for m in member_scu) / n for i in range(3))
    return _project_to_simplex(*raw)


def _scu_raw_for_set(set_obj: SetClass, kg: "KnowledgeGraph") -> tuple[float, float, float]:
    """Return raw (unprojected) speed/control/utility scores for a single set.

    Speed normalization is calibrated for level 100 (the project's default
    for competitive analysis). Effective Spe at L100 ranges from ~100
    (Toxapex) to ~400+ (Regieleki). The mapping ``(spe-100)/150`` puts
    a Spe of 100 at 0.0 and Spe of 250 at 1.0, with clamping above.
    """
    pokemon = kg.get_pokemon(set_obj.pokemon_id)
    speed = 0.0
    if pokemon is not None:
        eff_spe = set_obj.effective_stat("spe", pokemon.base_stats, level=100)
        speed = max(0.0, min(1.0, (eff_spe - 100) / 150))

    # Count pivot/recovery by move.id (lowercased)
    pivot_or_recovery_count = 0
    for move_id in set_obj.moves:
        if move_id.lower() in PIVOT_OR_RECOVERY:
            pivot_or_recovery_count += 1
    control = min(1.0, pivot_or_recovery_count / CONTROL_DENOMINATOR)

    # Utility buckets
    has_hazard_setter = False
    has_hazard_remover = False
    has_field_setter = False
    for move_id in set_obj.moves:
        mid = move_id.lower()
        if mid in HAZARD_SETTERS:
            has_hazard_setter = True
        if mid in HAZARD_REMOVERS:
            has_hazard_remover = True
        if mid in FIELD_SETTERS:
            has_field_setter = True
    utility = (
        UTILITY_HAZARD_SETTER_WEIGHT * (1.0 if has_hazard_setter else 0.0)
        + UTILITY_HAZARD_REMOVER_WEIGHT * (1.0 if has_hazard_remover else 0.0)
        + UTILITY_FIELD_SETTER_WEIGHT * (1.0 if has_field_setter else 0.0)
    )
    utility = max(0.0, min(1.0, utility))

    return (speed, control, utility)


def _project_to_simplex(s: float, c: float, u: float) -> tuple[float, float, float]:
    """Project (s, c, u) to the 3-simplex (sum=1, all >=0)."""
    s = max(0.0, s)
    c = max(0.0, c)
    u = max(0.0, u)
    total = s + c + u
    if total <= 0:
        return (1.0, 0.0, 0.0)
    if total > 1.0:
        return (s / total, c / total, u / total)
    # total < 1: add the remainder to the largest component
    remainder = 1.0 - total
    triple = [s, c, u]
    idx_max = max(range(3), key=lambda i: triple[i])
    triple[idx_max] += remainder
    return (triple[0], triple[1], triple[2])


# ═════════════════════════════════════════════════════════════════════
# Composed 3D projection
# ═════════════════════════════════════════════════════════════════════

def project_to_3d(target, kg: "KnowledgeGraph") -> MatchupGraphNode:
    """Project a single set, a list of sets (team), or a set_id into 3D space.

    Args:
      target: SetClass | str (set_id) | list[SetClass|str]
      kg: KnowledgeGraph for lookups

    Returns:
      MatchupGraphNode with all three axes populated.
    """
    sets = _resolve_sets(target, kg)
    if not sets:
        # Empty target → zero node
        return MatchupGraphNode(
            id="empty", kind="set", label="(empty)",
            axis_type_vector={t: 0.0 for t in POKEMON_TYPES},
            axis_offdef=0.0,
            axis_speed_control_utility=(1.0, 0.0, 0.0),
            member_ids=[],
        )

    if len(sets) == 1:
        s = sets[0]
        pokemon = kg.get_pokemon(s.pokemon_id)
        label = f"{pokemon.name} {s.set_name}" if pokemon else s.set_name
        return MatchupGraphNode(
            id=s.id,
            kind="set",
            label=label,
            axis_type_vector=project_type_axis(s, kg),
            axis_offdef=project_offdef_axis(s, kg),
            axis_speed_control_utility=project_scu_axis(s, kg),
            member_ids=[s.id],
        )

    # Team
    team_id = "team:" + "+".join(sorted(s.id for s in sets))
    first_pokemon = kg.get_pokemon(sets[0].pokemon_id)
    label = f"{first_pokemon.name if first_pokemon else 'Team'}+{len(sets)-1} team"
    return MatchupGraphNode(
        id=team_id,
        kind="team",
        label=label,
        axis_type_vector=project_type_axis(sets, kg),
        axis_offdef=project_offdef_axis(sets, kg),
        axis_speed_control_utility=project_scu_axis(sets, kg),
        member_ids=[s.id for s in sets],
    )


# ═════════════════════════════════════════════════════════════════════
# AI Query 1: pick_best_move
# ═════════════════════════════════════════════════════════════════════

def pick_best_move(
    attacker: SetClass | str,
    defender: SetClass | str,
    kg: "KnowledgeGraph",
) -> list[MoveRanking]:
    """Rank every move in the attacker's set for use against the defender.

    Returns a list of MoveRanking sorted by score descending.

    Scoring per move (additive):
      base_score   = 1.0
      type_mult    = TYPE_CHART[move.type][def_types]  (e.g. 2.0, 0.5, 0)
      stab_bonus   = 0.5 if STAB else 0
      utility_bonus = 0.3 if status else 0
                    + 0.2 if priority > 0
                    + 0.1 if status and set has a recovery move (status spam value)
      immunity_penalty = -1.0 if immune (0 type mult)
      damage_boost = (avg_damage_pct / 100) from existing MatchupRelation if available

    Each move's reasoning string documents which bonuses applied.
    """
    a = _resolve_one(attacker, kg)
    d = _resolve_one(defender, kg)
    if a is None or d is None:
        return []

    a_pokemon = kg.get_pokemon(a.pokemon_id)
    d_pokemon = kg.get_pokemon(d.pokemon_id)
    if a_pokemon is None or d_pokemon is None:
        return []

    def_types = d_pokemon.types

    # Look up existing matchup for damage data (optional, may be None)
    existing = kg.get_matchup_between(a.id, d.id)

    # Count recovery moves in the attacker's set for status-spam bonus
    a_has_recovery = any(mid.lower() in PIVOT_OR_RECOVERY for mid in a.moves)

    rankings: list[MoveRanking] = []
    for move_id in a.moves:
        move = kg.get_move(move_id)
        move_name = move.name if move else move_id
        move_type = move.type if move else "Normal"
        is_status = (move is None) or move.is_status
        bp = move.base_power if move else 0
        prio = move.priority if move else 0
        is_stab = move_type in a_pokemon.types

        # Type effectiveness vs defender's types
        type_mult = get_effectiveness(move_type, def_types)

        # Base score
        score = 1.0
        reasons: list[str] = []

        # Damage-derived score (per % of defender HP dealt)
        damage_pct = 0.0
        if existing is not None and move_id == existing.best_move_a_id:
            # Only the "best move" entry has direct damage data; we still
            # use it as a hint, with type_mult as the dominant signal.
            damage_pct = max(0.0, existing.damage_pct_a_to_b_hi)
            if damage_pct > 0:
                score += damage_pct / 100.0
                reasons.append(f"~{damage_pct:.0f}% damage roll")

        # Type effectiveness
        if type_mult == 0.0:
            score = -1.0
            reasons.append("immune — never use")
        elif type_mult >= 2.0:
            score += 0.6
            reasons.append(f"super-effective (x{type_mult})")
        elif type_mult > 1.0:
            score += 0.3
            reasons.append(f"effective (x{type_mult})")
        elif type_mult < 1.0 and type_mult > 0.0:
            score -= 0.3
            reasons.append(f"resisted (x{type_mult})")
        # type_mult == 1.0: neutral, no change

        # STAB
        if is_stab and not is_status:
            score += 0.5
            reasons.append("STAB")

        # High base power (nuke)
        if bp >= 100 and not is_status:
            score += 0.2
            reasons.append("nuke-tier power")

        # Status utility
        if is_status:
            score += 0.3
            reasons.append("status utility")
            if a_has_recovery:
                score += 0.1
                reasons.append("set has recovery → status spam")

        # Priority
        if prio > 0:
            score += 0.2
            reasons.append("priority")

        rankings.append(MoveRanking(
            move_id=move_id,
            move_name=move_name,
            score=round(score, 4),
            reasoning="; ".join(reasons) if reasons else "neutral",
            type_effectiveness=type_mult,
            is_stab=is_stab,
            estimated_damage_pct=damage_pct,
        ))

    # Sort descending by score
    rankings.sort(key=lambda r: r.score, reverse=True)
    return rankings
