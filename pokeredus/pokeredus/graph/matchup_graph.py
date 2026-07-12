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
import pathlib
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


# ═════════════════════════════════════════════════════════════════════
# AI Query 2: find_optimal_switch
# ═════════════════════════════════════════════════════════════════════

def find_optimal_switch(
    opponent: SetClass | str,
    candidates: Iterable[SetClass | str],
    kg: "KnowledgeGraph",
) -> list[SwitchRanking]:
    """Rank candidate switch-ins against a single opponent.

    Scoring per candidate (additive):
      type_resist_score  = 1.0 / product(incoming_type_effectiveness)
                            (4x weakness = 0.25, immune = inf → capped)
                            multiplied by 0.4 weight
      speed_advantage     = +0.4 if candidate faster, -0.4 if slower
      matchup_score_bonus = clamp(existing_matchup_score, -1, 1) * 0.4
                            (uses precomputed MatchupRelation if available)
      3d_distance_bonus  = -0.3 * euclidean_distance(opponent_node, candidate_node)
                            in axis-2 + axis-3 space (closer = better)

    Each ranking's ``reasons`` list documents which factors applied.
    """
    opp = _resolve_one(opponent, kg)
    if opp is None:
        return []
    opp_pokemon = kg.get_pokemon(opp.pokemon_id)
    if opp_pokemon is None:
        return []

    opp_proj = project_to_3d(opp, kg)

    # Precompute opponent's offensive type vector (its STAB move types)
    opp_attack_types: list[str] = []
    for mid in opp.moves:
        mv = kg.get_move(mid)
        if mv and not mv.is_status and mv.base_power > 0:
            opp_attack_types.append(mv.type)
    # Also include the opponent's own types for STAB
    opp_attack_types.extend(opp_pokemon.types)
    # Dedupe
    opp_attack_types = list(dict.fromkeys(opp_attack_types))

    rankings: list[SwitchRanking] = []
    for cand in candidates:
        c = _resolve_one(cand, kg)
        if c is None:
            continue
        c_pokemon = kg.get_pokemon(c.pokemon_id)
        if c_pokemon is None:
            continue

        reasons: list[str] = []
        score = 0.0

        # 1. Type resist: product of effectiveness of opponent's attack types
        #    vs the candidate's defensive types
        type_matchup_product = 1.0
        for atk_type in opp_attack_types:
            mult = get_effectiveness(atk_type, c_pokemon.types)
            type_matchup_product *= mult
        # Cap to avoid /0 (immunity gives 0 → treat as best)
        if type_matchup_product == 0.0:
            type_resist_score = 2.0  # huge bonus for being immune
            reasons.append("immune to opponent's STAB")
        else:
            # Lower is better for the candidate (less damage taken)
            # Map (0.25, 0.5, 1.0, 2.0, 4.0) to (2.0, 1.0, 0.5, 0.0, -1.0)
            if type_matchup_product <= 0.25:
                type_resist_score = 2.0
                reasons.append("barely scratched by opponent's STAB (4x resist)")
            elif type_matchup_product <= 0.5:
                type_resist_score = 1.0
                reasons.append("resists opponent's STAB")
            elif type_matchup_product <= 1.0:
                type_resist_score = 0.5
                reasons.append("neutral to opponent's STAB")
            elif type_matchup_product <= 2.0:
                type_resist_score = 0.0
                reasons.append("takes neutral-to-super-effective damage")
            else:
                type_resist_score = -1.0
                reasons.append("4x weak to opponent's STAB")
        score += 0.4 * type_resist_score

        # 2. Speed advantage
        opp_spe = opp.effective_stat("spe", opp_pokemon.base_stats, level=100)
        c_spe = c.effective_stat("spe", c_pokemon.base_stats, level=100)
        if c_spe > opp_spe:
            speed_advantage = "us"
            score += 0.4
            reasons.append("faster than opponent")
        elif c_spe < opp_spe:
            speed_advantage = "them"
            score -= 0.4
            reasons.append("slower than opponent")
        else:
            speed_advantage = "tie"
            reasons.append("speed tie")

        # 3. MatchupRelation score (if precomputed)
        existing = kg.get_matchup_between(c.id, opp.id)
        if existing is not None and existing.confidence > 0:
            m_bonus = max(-1.0, min(1.0, existing.score)) * 0.4
            score += m_bonus
            if m_bonus > 0.1:
                reasons.append(f"favorable precomputed matchup ({existing.score:+.2f})")
            elif m_bonus < -0.1:
                reasons.append(f"unfavorable precomputed matchup ({existing.score:+.2f})")

        # 4. 3D distance in (offdef, scu) space — closer to opponent = similar
        #    role/archetype, but we actually want COMPLEMENTARY. For now,
        #    we use it as a tiebreaker (slight penalty for being too close).
        c_proj = project_to_3d(c, kg)
        dist = math.sqrt(
            (c_proj.axis_offdef - opp_proj.axis_offdef) ** 2
            + sum((a - b) ** 2 for a, b in
                  zip(c_proj.axis_speed_control_utility,
                      opp_proj.axis_speed_control_utility))
        )
        # Distance in [0, ~2.5]; convert to small bonus/penalty
        score -= 0.1 * dist

        rankings.append(SwitchRanking(
            set_id=c.id,
            pokemon_id=c.pokemon_id,
            set_name=c.set_name,
            score=round(score, 4),
            reasons=reasons,
            type_matchup=type_matchup_product,
            speed_advantage=speed_advantage,
        ))

    rankings.sort(key=lambda r: r.score, reverse=True)
    return rankings


# ═════════════════════════════════════════════════════════════════════
# AI Query 3: analyze_game_state (composes pick_best_move + find_optimal_switch)
# ═════════════════════════════════════════════════════════════════════

# Threshold for recommending a switch: if best switch scores at least
# SWITCH_ADVANTAGE_THRESHOLD higher than the active's matchup score,
# the AI will switch. Otherwise it stays in.
SWITCH_ADVANTAGE_THRESHOLD: float = 0.3


def analyze_game_state(
    my_active: SetClass | str,
    opp_active: SetClass | str,
    my_bench: Iterable[SetClass | str],
    kg: "KnowledgeGraph",
) -> TurnPlan:
    """Decide a single turn's plan: switch or stay, and which move to use.

    Decision process:
      1. Compute the active's matchup score vs the opponent.
      2. Compute each bench member's matchup score vs the opponent
         using find_optimal_switch.
      3. If the best bench score > active score + threshold, recommend
         a switch; else recommend staying in.
      4. Always pick a recommended move (either for the active if staying,
         or the switch-in's best move if switching).
      5. Build a reasoning chain documenting each step.

    Returns a TurnPlan with both recommendations and the confidence chain.
    """
    me = _resolve_one(my_active, kg)
    opp = _resolve_one(opp_active, kg)
    if me is None or opp is None:
        return TurnPlan(
            recommended_switch=None,
            recommended_move=None,
            confidence=0.0,
            reasoning_chain=["could not resolve active or opponent"],
        )

    chain: list[str] = []
    chain.append(
        f"analyzing game state: {me.set_name} (active) vs {opp.set_name} (opp)"
    )

    # 1. Project both actives
    me_proj = project_to_3d(me, kg)
    opp_proj = project_to_3d(opp, kg)
    chain.append(
        f"  - active projected: offdef={me_proj.axis_offdef:+.2f}, "
        f"scu={tuple(round(v, 2) for v in me_proj.axis_speed_control_utility)}"
    )
    chain.append(
        f"  - opponent projected: offdef={opp_proj.axis_offdef:+.2f}, "
        f"scu={tuple(round(v, 2) for v in opp_proj.axis_speed_control_utility)}"
    )

    # 2. Active's matchup score
    active_matchup = kg.get_matchup_between(me.id, opp.id)
    active_score = active_matchup.score if active_matchup is not None else 0.0
    chain.append(
        f"  - active matchup score vs opp: {active_score:+.2f}"
    )

    # 3. Best bench matchup
    bench_list = list(my_bench)
    bench_switches = find_optimal_switch(opp, bench_list, kg)
    if bench_switches:
        best_switch = bench_switches[0]
        chain.append(
            f"  - best bench switch: {best_switch.set_name} "
            f"(score={best_switch.score:+.2f})"
        )
        for reason in best_switch.reasons:
            chain.append(f"      * {reason}")
    else:
        best_switch = None
        chain.append("  - no bench available (or empty)")

    # 4. Decide: switch or stay
    should_switch = (
        best_switch is not None
        and best_switch.score > active_score + SWITCH_ADVANTAGE_THRESHOLD
    )

    if should_switch and best_switch is not None:
        chain.append(
            f"  -> decision: SWITCH to {best_switch.set_name} "
            f"(advantage {best_switch.score - active_score:+.2f} > threshold)"
        )
        # The switch-in is the recommended "active" for the move pick
        switch_set = _resolve_one(best_switch.set_id, kg)
        move_rankings = pick_best_move(switch_set, opp, kg) if switch_set else []
        rec_move = move_rankings[0] if move_rankings else None
        confidence = 0.5 + 0.2 * min(1.0, abs(best_switch.score - active_score))
        return TurnPlan(
            recommended_switch=best_switch,
            recommended_move=rec_move,
            confidence=min(1.0, confidence),
            reasoning_chain=chain,
        )
    else:
        chain.append(
            f"  -> decision: STAY with {me.set_name} "
            f"(active score {active_score:+.2f} acceptable; "
            f"best bench {best_switch.score if best_switch else 0:+.2f})"
        )
        move_rankings = pick_best_move(me, opp, kg)
        rec_move = move_rankings[0] if move_rankings else None
        confidence = 0.5 + 0.2 * max(0.0, active_score)
        return TurnPlan(
            recommended_switch=None,
            recommended_move=rec_move,
            confidence=min(1.0, confidence),
            reasoning_chain=chain,
        )


# ═════════════════════════════════════════════════════════════════════
# 8-attribute x 18-type polygonal-solid data layer (Tasks 3-10)
# ═════════════════════════════════════════════════════════════════════
#
# This section is the new visualisation data model that powers the 2D
# radial polygon and 3D cylinder renderers (Tasks 11-15).  It is purely
# additive — the 3D projection and AI queries above are unchanged.
#
# Axis model (per type i):
#     Same-axis (additive): attack+utility on Y; defense+speed on Z.
#     Compound attributes:
#         counter = attack + defense
#         sponge  = utility + defense
#         threat  = attack + speed
#         punish  = utility + speed
#     Volume of the polygonal solid =
#         Σ_i ( counter_i·sponge_i + threat_i·punish_i )  × bias.

import numpy as _np


# ── Canonical Showdown type order ──────────────────────────────────

CANONICAL_TYPES: list[str] = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
    "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]
# Interleaved order: base → compound around the compass rose.
# 0°: attack, 45°: threat, 90°: speed, 135°: punish,
# 180°: utility, 225°: sponge, 270°: defense, 315°: counter.
ATTRIBUTE_NAMES: list[str] = [
    "attack", "threat", "speed", "punish",
    "utility", "sponge", "defense", "counter",
]
ATTRIBUTE_INDEX: dict[str, int] = {n: i for i, n in enumerate(ATTRIBUTE_NAMES)}


# ── Status / pivot / priority / setup move buckets ────────────────

_STATUS_MOVES: set[str] = {
    "spore", "sleeppowder", "stunspore", "thunderwave", "willowisp",
    "toxic", "thundercage", "sandattack", "swagger", "confuseray",
    "haze", "defog", "protect", "substitute", "calmindmind",
    "nastyplot", "swordsdance", "dragondance", "bulkup", "coil",
    "quiverdance", "shellsmash", "workup", "recover", "roost",
    "softboiled", "wish", "milkdrink", "morningsun", "moonlight",
    "synthesis", "healorder", "slackoff", "stealthrock", "spikes",
    "toxicspikes", "stickyweb", "rapidspin", "tidyup", "mortalspin",
    "trickroom", "tailwind", "lightscreen", "reflect", "auroraveil",
    "sunnyday", "raindance", "sandstorm", "snowscape",
    "electricterrain", "grassyterrain", "psychicterrain", "mistyterrain",
    "partingshot", "whirlwind", "roar", "dragontail", "circlethrow",
    "teleport", "batonpass",
}
_PIVOT_MOVES: set[str] = {
    "uturn", "voltswitch", "partingshot", "whirlwind", "roar",
    "dragontail", "circlethrow", "teleport", "batonpass",
}
_PRIORITY_MOVES: set[str] = {
    "extremespeed", "suckerpunch", "aquajet", "bulletpunch",
    "machpunch", "shadowsneak", "quickattack", "icepunch",
    "thunderpunch", "vacuumwave",
}
_SETUP_MOVES: set[str] = {
    "swordsdance", "nastyplot", "calmindmind", "dragondance",
    "bulkup", "coil", "quiverdance", "shellsmash", "workup",
}


# ── Test fallback move table (used when kg is None) ───────────────
# ~60 common moves.  In production the real kg.get_move(...) is used.

_FALLBACK_MOVES: dict[str, tuple[str, float]] = {
    "sludgebomb": ("Poison", 90), "leafstorm": ("Grass", 130),
    "hiddenpowerfire": ("Fire", 60), "sleeppowder": ("Grass", 0),
    "willowisp": ("Fire", 0), "spore": ("Grass", 0),
    "toxic": ("Poison", 0), "uturn": ("Bug", 70),
    "voltswitch": ("Electric", 70), "thunderwave": ("Electric", 0),
    "extremespeed": ("Normal", 40), "suckerpunch": ("Dark", 70),
    "swordsdance": ("Normal", 0), "nastyplot": ("Dark", 0),
    "calmindmind": ("Psychic", 0), "recover": ("Normal", 0),
    "softboiled": ("Normal", 0), "roost": ("Flying", 0),
    "stealthrock": ("Rock", 0), "spikes": ("Ground", 0),
    "defog": ("Flying", 0), "rapidspin": ("Normal", 50),
    "earthquake": ("Ground", 100), "icebeam": ("Ice", 90),
    "thunderbolt": ("Electric", 90), "flamethrower": ("Fire", 90),
    "surf": ("Water", 90), "moonblast": ("Fairy", 95),
    "shadowball": ("Ghost", 80), "drainpunch": ("Fighting", 75),
    "knockoff": ("Dark", 65), "ironhead": ("Steel", 80),
    "psychic": ("Psychic", 90), "darkpulse": ("Dark", 80),
    "dracometeor": ("Dragon", 130), "hurricane": ("Flying", 110),
    "closecombat": ("Fighting", 120), "flareblitz": ("Fire", 120),
    "boltstrike": ("Electric", 130), "leafblade": ("Grass", 90),
    "stoneedge": ("Rock", 100), "earthpower": ("Ground", 90),
    "bugbuzz": ("Bug", 90), "freezedry": ("Ice", 70),
    "icepunch": ("Ice", 75), "thunderpunch": ("Electric", 75),
    "boomburst": ("Normal", 140),
    "magmastorm": ("Fire", 100), "earthpower": ("Ground", 90),
    "bravebird": ("Flying", 120),
    "scald": ("Water", 80), "haze": ("Ice", 0),
    "dragondarts": ("Dragon", 100), "shadowball": ("Ghost", 80),
    "outrage": ("Dragon", 120), "dragonclaw": ("Dragon", 80),
    "dragondance": ("Dragon", 0),
}


def _lookup_move_fallback(mid: str) -> tuple[str | None, float]:
    return _FALLBACK_MOVES.get(mid.lower(), (None, 0.0))


def _get_move_type(mid: str, kg) -> str | None:
    if kg is not None:
        mv = kg.get_move(mid)
        return mv.type if mv else None
    t, _ = _lookup_move_fallback(mid)
    return t


def _get_move_bp(mid: str, kg) -> float:
    if kg is not None:
        mv = kg.get_move(mid)
        return float(mv.base_power) if mv and mv.base_power is not None else 0.0
    _, bp = _lookup_move_fallback(mid)
    return float(bp)


def _is_status_move(mid: str, kg) -> bool:
    if kg is not None:
        mv = kg.get_move(mid)
        if mv is not None:
            return bool(mv.is_status) or float(mv.base_power or 0) <= 0
    t, bp = _lookup_move_fallback(mid)
    return bp <= 0


def _eff_spe(set_obj, p) -> float:
    try:
        return float(set_obj.effective_stat("spe", p.base_stats, level=100))
    except Exception:
        return float(p.base_stats.get("spe", 100))


# ── Data class ─────────────────────────────────────────────────────


class _SetMatchupNode:
    """Per-set 8-attribute x 18-type matchup-graph node.

    Independent dataclass from the legacy MatchupGraphNode (which
    carries the type-vector / offdef / SCU axes for the AI's MCTS
    engine).  The two coexist; build_node() returns one of these.
    """
    set_id: str = ""
    pokemon_id: str = ""

    def __init__(self, set_id: str = "", pokemon_id: str = "",
                 attributes=None, vase_order=None, bias: float = 1.0,
                 weights=None, role: str = "", mcts_composite: float = 0.0):
        self.set_id = set_id
        self.pokemon_id = pokemon_id
        self.attributes = (attributes if attributes is not None
                           else _np.zeros((8, 18), dtype=_np.float32))
        self.vase_order = list(vase_order) if vase_order is not None else []
        self.bias = float(bias)
        self.weights = (weights if weights is not None
                        else _np.ones(8, dtype=_np.float32))
        self.role = role
        self.mcts_composite = float(mcts_composite)


# Public alias for the 8-attribute x 18-type polygonal-solid model.
# The legacy dataclass stays as ``MatchupGraphNode`` for the existing
# 3D-projection and AI-query tests / API.
SetMatchupNode = _SetMatchupNode


# ── Task 4: 4 base attribute computations ─────────────────────────


def compute_base_attributes(set_obj, p, kg=None) -> _np.ndarray:
    """Compute the 4 base attributes (attack, utility, defense, speed) for all 18 types.

    Returns: np.ndarray shape (8, 18); only the first 4 rows are populated,
    the last 4 (compound) are zero — see ``compute_compound_attributes``.
    """
    a = _np.zeros((8, 18), dtype=_np.float32)
    type_to_idx = {t: i for i, t in enumerate(CANONICAL_TYPES)}

    # ── ATTACK per type ────────────────────────────────────────────
    for mid in set_obj.moves:
        move_type = _get_move_type(mid, kg)
        bp = _get_move_bp(mid, kg)
        if move_type not in type_to_idx or bp <= 0:
            continue
        idx = type_to_idx[move_type]
        stab_bonus = 1.5 if move_type in p.types else 1.0
        nuke_bonus = 1.2 if bp >= 100 else 1.0
        a[ATTRIBUTE_INDEX["attack"], idx] += bp * stab_bonus * nuke_bonus

    # ── UTILITY per type ──────────────────────────────────────────
    has_pivot = any(m.lower() in _PIVOT_MOVES for m in set_obj.moves)
    has_priority = any(m.lower() in _PRIORITY_MOVES for m in set_obj.moves)
    has_setup = any(m.lower() in _SETUP_MOVES for m in set_obj.moves)
    util_bonus = 0.4 * float(has_pivot) + 0.5 * float(has_priority) + 0.6 * float(has_setup)
    for mid in set_obj.moves:
        move_type = _get_move_type(mid, kg)
        if move_type in type_to_idx:
            a[ATTRIBUTE_INDEX["utility"], type_to_idx[move_type]] += 0.3
    a[ATTRIBUTE_INDEX["utility"]] += util_bonus  # spread across all types

    # ── DEFENSE per type ──────────────────────────────────────────
    # For each attacking type t, compute incoming effectiveness on self (p.types).
    from pokeredus.classes import get_effectiveness
    for atk_type in CANONICAL_TYPES:
        mult = 1.0
        for self_t in p.types:
            mult *= get_effectiveness(atk_type, self_t)
        idx = type_to_idx[atk_type]
        # higher mult = weaker to that type → LOWER defense.  We invert so
        # higher defense = better resistance to that type.
        a[ATTRIBUTE_INDEX["defense"], idx] = float(1.0 / max(mult, 0.25))

    # ── SPEED per type ────────────────────────────────────────────
    spe = _eff_spe(set_obj, p)
    norm = max(0.0, min(1.0, (spe - 100) / 150.0))
    for i, _t in enumerate(CANONICAL_TYPES):
        a[ATTRIBUTE_INDEX["speed"], i] = norm

    return a


# ── Task 5: 4 compound attributes + volume formula ─────────────────


def compute_compound_attributes(base: _np.ndarray) -> _np.ndarray:
    """Compute the 4 compound attributes from the 4 base attributes.

    Compounds live on the perpendicular product: each compound is the
    sum of one Y-axis attribute and one Z-axis attribute.  The volume
    of the 3D polygonal solid is the sum of the products of every
    perpendicular pair over all 18 types.
    """
    full = base.copy()
    A = ATTRIBUTE_INDEX["attack"]; U = ATTRIBUTE_INDEX["utility"]
    D = ATTRIBUTE_INDEX["defense"]; S = ATTRIBUTE_INDEX["speed"]
    full[ATTRIBUTE_INDEX["counter"]] = base[A] + base[D]
    full[ATTRIBUTE_INDEX["sponge"]]  = base[U] + base[D]
    full[ATTRIBUTE_INDEX["threat"]]  = base[A] + base[S]
    full[ATTRIBUTE_INDEX["punish"]]  = base[U] + base[S]
    return full


def volume_of(attributes: _np.ndarray, bias: float = 1.0) -> float:
    """Total volume of the 3D polygonal solid.

    V = Σ_i  ( counter_i·sponge_i + threat_i·punish_i )  × bias
    """
    C = ATTRIBUTE_INDEX["counter"]; G = ATTRIBUTE_INDEX["sponge"]
    T = ATTRIBUTE_INDEX["threat"]; P = ATTRIBUTE_INDEX["punish"]
    per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
    return float(per_type.sum() * bias)


# ── Task 6: vase sort + role weight table ──────────────────────────


def vase_sort(attributes: _np.ndarray) -> list[int]:
    """Return a permutation of 0..17 sorted by ascending type-area."""
    C = ATTRIBUTE_INDEX["counter"]; G = ATTRIBUTE_INDEX["sponge"]
    T = ATTRIBUTE_INDEX["threat"]; P = ATTRIBUTE_INDEX["punish"]
    per_type = attributes[C] * attributes[G] + attributes[T] * attributes[P]
    return [int(x) for x in _np.argsort(per_type)]


WEIGHT_TABLE: dict[str, dict[str, float]] = {
    "default": {a: 1.0 for a in ATTRIBUTE_NAMES},
    "sweeper": {"attack": 1.3, "speed": 1.2, "threat": 1.2,
                 "counter": 1.0, "punish": 1.0,
                 "sponge": 0.8, "defense": 0.8, "utility": 0.8},
    "wall":    {"defense": 1.4, "utility": 1.2, "sponge": 1.3,
                 "counter": 1.0,
                 "attack": 0.8, "speed": 0.7, "threat": 0.8, "punish": 0.7},
    "pivot":   {"utility": 1.3, "counter": 1.2, "punish": 1.2,
                 "sponge": 1.0,
                 "attack": 0.9, "defense": 1.0, "speed": 1.0, "threat": 0.9},
    "cleric":  {"utility": 1.4, "defense": 1.2, "sponge": 1.2,
                 "punish": 1.0,
                 "attack": 0.7, "speed": 0.7, "counter": 0.8, "threat": 0.7},
    "staller": {"defense": 1.3, "utility": 1.3, "sponge": 1.3,
                 "counter": 1.1, "punish": 1.0,
                 "attack": 0.8, "speed": 0.6, "threat": 0.7},
    "lead":    {"utility": 1.2, "attack": 1.1, "counter": 1.1,
                 "threat": 1.1, "punish": 1.0,
                 "defense": 1.0, "speed": 1.0, "sponge": 0.9},
}


# ── Task 7: end-to-end build_node ──────────────────────────────────


def build_node(set_obj, p, kg=None, mcts_composite: float = 0.0):
    """End-to-end: compute 4 base → 4 compound → vase-sort → bias/weights."""
    base = compute_base_attributes(set_obj, p, kg)
    full = compute_compound_attributes(base)
    role = (getattr(set_obj, "role", "") or "default").lower()
    weights = _np.array([WEIGHT_TABLE.get(role, WEIGHT_TABLE["default"])[a]
                          for a in ATTRIBUTE_NAMES], dtype=_np.float32)
    full = full * weights[:, None]  # broadcast weights across 18 types
    order = vase_sort(full)
    bias = 0.5 + 0.5 * float(_np.clip(mcts_composite, 0.0, 1.0))
    return _SetMatchupNode(
        set_id=set_obj.id,
        pokemon_id=set_obj.pokemon_id,
        attributes=full,
        vase_order=order,
        bias=bias,
        weights=weights,
        role=role,
        mcts_composite=float(mcts_composite),
    )


# ── Task 8: on-disk cache ──────────────────────────────────────────

NODE_CACHE_DIRNAME = "graphs"


def node_cache_paths(pokemon_id: str, set_id: str, sets_dir):
    base = pathlib.Path(sets_dir) / NODE_CACHE_DIRNAME / pokemon_id
    base.mkdir(parents=True, exist_ok=True)
    return base / f"{set_id}.json", base / f"{set_id}.meta.json"


def save_node_cache(node, sets_dir) -> tuple[pathlib.Path, pathlib.Path]:
    data_path, meta_path = node_cache_paths(node.pokemon_id, node.set_id, sets_dir)
    with open(data_path, "w", encoding="utf-8") as f:
        json.dump({
            "set_id": node.set_id,
            "pokemon_id": node.pokemon_id,
            "attributes": node.attributes.tolist(),
        }, f)
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({
            "vase_order": list(node.vase_order),
            "bias": float(node.bias),
            "weights": node.weights.tolist(),
            "role": node.role,
            "mcts_composite": float(node.mcts_composite),
        }, f, indent=2)
    return data_path, meta_path


def load_node_cache(pokemon_id: str, set_id: str, sets_dir):
    data_path, meta_path = node_cache_paths(pokemon_id, set_id, sets_dir)
    if not data_path.exists() or not meta_path.exists():
        return None
    with open(data_path, encoding="utf-8") as f:
        d = json.load(f)
    with open(meta_path, encoding="utf-8") as f:
        m = json.load(f)
    return _SetMatchupNode(
        set_id=d["set_id"],
        pokemon_id=d["pokemon_id"],
        attributes=_np.array(d["attributes"], dtype=_np.float32),
        vase_order=list(m["vase_order"]),
        bias=float(m["bias"]),
        weights=_np.array(m["weights"], dtype=_np.float32),
        role=str(m.get("role", "")),
        mcts_composite=float(m.get("mcts_composite", 0.0)),
    )


# ── Task 10: team composer ─────────────────────────────────────────


def compose_team_node(nodes, weights=None):
    """Weighted union of multiple set nodes into one team node."""
    if not nodes:
        return _SetMatchupNode(set_id="empty_team", pokemon_id="team")
    if weights is None:
        weights = [1.0] * len(nodes)
    ws = _np.array(weights, dtype=_np.float32)
    attrs = sum(w * n.attributes for w, n in zip(ws, nodes))
    bias = float(_np.mean([n.bias for n in nodes]))
    C = ATTRIBUTE_INDEX["counter"]; G = ATTRIBUTE_INDEX["sponge"]
    T = ATTRIBUTE_INDEX["threat"]; P = ATTRIBUTE_INDEX["punish"]
    per_type = attrs[C] * attrs[G] + attrs[T] * attrs[P]
    vase = [int(x) for x in _np.argsort(per_type)]
    return _SetMatchupNode(
        set_id="+".join(n.set_id for n in nodes),
        pokemon_id="team",
        attributes=attrs,
        vase_order=vase,
        bias=bias,
        weights=_np.ones(8, dtype=_np.float32),
        role="team",
        mcts_composite=float(_np.mean([n.mcts_composite for n in nodes])),
    )


def team_volume(team) -> float:
    return volume_of(team.attributes, bias=team.bias)

