"""
matchup_engine — compute matchup scores between Pokémon sets.

Phase 5: Refactored to use the damage calculator for turns-to-kill (TTK)
based scoring. The score is derived from TTK differentials and speed
advantage, producing a more accurate matchup score than the previous
weighted-sum heuristic.

Scoring pipeline:
1. Compute TTK for A→B and B→A using the damage calculator
2. Factor in speed advantage (who attacks first)
3. Map TTK differential to [-1.0, +1.0] score
4. Generate tags (OHKO, 2HKO, outsped, etc.)

Modifier hooks: The damage calculator uses a pluggable modifier system.
Items and abilities are registered as DamageModifier instances on the
calculator. To add a new item/ability effect:
    1. Subclass DamageModifier in damage_calc.py
    2. Register it with calc.register_modifier(MyModifier())
    3. Recompute matchups
"""

from __future__ import annotations

import math

from pokeredus.classes import (
    MatchupRelation, SetClass, PokemonClass,
    get_effectiveness, get_best_effectiveness,
)
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.damage_calc import DamageCalculator, get_calculator


def compute_matchup(
    set_a: SetClass,
    set_b: SetClass,
    kg: KnowledgeGraph,
    calc: DamageCalculator | None = None,
) -> MatchupRelation:
    """Compute a matchup score for set_a vs set_b using TTK-based scoring.

    Returns a MatchupRelation with score in [-1.0, +1.0].
    Positive score favors set_a.

    Args:
        set_a: The attacking set (perspective source)
        set_b: The defending set (perspective target)
        kg: Knowledge graph for lookups
        calc: Optional damage calculator (uses default if None)
    """
    if calc is None:
        calc = get_calculator()

    pokemon_a = kg.get_pokemon(set_a.pokemon_id)
    pokemon_b = kg.get_pokemon(set_b.pokemon_id)

    if not pokemon_a or not pokemon_b:
        return MatchupRelation(
            set_a_id=set_a.id, set_b_id=set_b.id,
            score=0.0, confidence=0.0, source="ttk_calc",
        )

    # ── 1. Compute TTK via damage calculator ────────────────────────
    matchup = calc.full_matchup(set_a, set_b, kg)

    ttk_ab = matchup["ttk_a_to_b"]  # A kills B in N turns
    ttk_ba = matchup["ttk_b_to_a"]  # B kills A in N turns
    speed_adv = matchup["speed_advantage"]

    # ── 2. Build tags ───────────────────────────────────────────────
    tags: list[str] = []

    if ttk_ab > 0:
        if ttk_ab == 1:
            tags.append("OHKO")
        elif ttk_ab == 2:
            tags.append("2HKO")
        elif ttk_ab == 3:
            tags.append("3HKO")
        else:
            tags.append(f"{ttk_ab}HKO")

    if speed_adv == "a":
        tags.append("faster")
    elif speed_adv == "b":
        tags.append("slower")
    else:
        tags.append("speed_tie")

    # Check for immunities
    if matchup["best_move_a"] and matchup["best_move_a"].is_immune:
        tags.append("immune_to_a")
    if matchup["best_move_b"] and matchup["best_move_b"].is_immune:
        tags.append("immune_to_b")

    # Coverage tags
    if matchup["best_move_a"] and matchup["best_move_a"].type_effectiveness >= 2.0:
        tags.append("super_effective_coverage")
    if matchup["best_move_b"] and matchup["best_move_b"].type_effectiveness >= 2.0:
        tags.append("vulnerable_to_super_effective")

    # ── 3. Compute TTK-based score ──────────────────────────────────
    score = _compute_ttk_score(ttk_ab, ttk_ba, speed_adv)

    # ── 4. Confidence ───────────────────────────────────────────────
    # Higher confidence when we have real damage data
    confidence = 0.5  # TTK calc is more reliable than pure type heuristic
    if ttk_ab > 0 and ttk_ba > 0:
        confidence = 0.7  # both sides can deal damage
    if matchup["best_move_a"] and matchup["best_move_a"].type_effectiveness >= 2.0:
        confidence += 0.1
    if matchup["best_move_b"] and matchup["best_move_b"].type_effectiveness >= 2.0:
        confidence += 0.1
    confidence = min(1.0, confidence)

    # ── Build relation ──────────────────────────────────────────────
    return MatchupRelation(
        set_a_id=set_a.id,
        set_b_id=set_b.id,
        score=round(score, 4),
        confidence=round(confidence, 2),
        sample_count=0,
        source="ttk_calc",
        tags=tags,
        # TTK fields
        turns_to_kill_a=ttk_ab,
        turns_to_kill_b=ttk_ba,
        speed_advantage=speed_adv,
        best_move_a_id=matchup["best_move_a_id"],
        best_move_b_id=matchup["best_move_b_id"],
        damage_a_to_b=matchup["damage_a_to_b"],
        damage_b_to_a=matchup["damage_b_to_a"],
        effective_hp_a=matchup["hp_a"],
        effective_hp_b=matchup["hp_b"],
        # Damage range fields
        min_damage_a_to_b=matchup["min_damage_a_to_b"],
        max_damage_a_to_b=matchup["max_damage_a_to_b"],
        min_damage_b_to_a=matchup["min_damage_b_to_a"],
        max_damage_b_to_a=matchup["max_damage_b_to_a"],
        damage_pct_a_to_b_lo=matchup["damage_pct_a_to_b_lo"],
        damage_pct_a_to_b_hi=matchup["damage_pct_a_to_b_hi"],
        damage_pct_b_to_a_lo=matchup["damage_pct_b_to_a_lo"],
        damage_pct_b_to_a_hi=matchup["damage_pct_b_to_a_hi"],
        min_ttk_a_to_b=matchup["min_ttk_a_to_b"],
        max_ttk_a_to_b=matchup["max_ttk_a_to_b"],
        min_ttk_b_to_a=matchup["min_ttk_b_to_a"],
        max_ttk_b_to_a=matchup["max_ttk_b_to_a"],
    )


def _compute_ttk_score(
    ttk_a_to_b: int,
    ttk_b_to_a: int,
    speed_advantage: str,
) -> float:
    """Map TTK differential + speed advantage to a [-1.0, +1.0] score.

    Logic:
    - If A can't kill B but B can kill A: score = -1.0 (hard loss)
    - If B can't kill A but A can kill B: score = +1.0 (hard win)
    - If neither can kill: score = 0.0 (stall/mutual wall)
    - If both can kill:
        ttk_diff = B_TTK - A_TTK (positive = A kills faster)
        Base score = tanh(ttk_diff / 3.0) → smooth [-1, 1]
        Speed adjustment: +0.1 if A faster, -0.1 if B faster
        Speed tiebreaker: if ttk_diff == 0, faster mon gets +0.15
    """
    a_can_kill = ttk_a_to_b > 0
    b_can_kill = ttk_b_to_a > 0

    # Special cases
    if not a_can_kill and not b_can_kill:
        return 0.0  # mutual wall
    if a_can_kill and not b_can_kill:
        return 1.0  # A wins by default (B can't deal damage)
    if not a_can_kill and b_can_kill:
        return -1.0  # A loses by default

    # Both can kill: compare TTK
    ttk_diff = ttk_b_to_a - ttk_a_to_b  # positive = A kills faster

    # Base score from TTK differential
    # Use tanh for smooth mapping: diff of 1 → ~0.31, diff of 3 → ~0.76
    base_score = math.tanh(ttk_diff / 2.5)

    # Speed adjustment
    speed_adj = 0.0
    if speed_advantage == "a":
        speed_adj = 0.10
    elif speed_advantage == "b":
        speed_adj = -0.10

    # When TTK is equal, speed becomes the tiebreaker
    if ttk_diff == 0:
        if speed_advantage == "a":
            speed_adj = 0.15
        elif speed_advantage == "b":
            speed_adj = -0.15

    score = base_score + speed_adj

    return max(-1.0, min(1.0, score))


def compute_all_matchups(
    kg: KnowledgeGraph,
    calc: DamageCalculator | None = None,
) -> int:
    """Compute pairwise matchups for all sets in the graph.

    Returns the number of matchup edges added.
    """
    if calc is None:
        calc = get_calculator()

    sets = kg.get_all_sets()
    count = 0
    for i, set_a in enumerate(sets):
        for j, set_b in enumerate(sets):
            if i == j:
                continue
            matchup = compute_matchup(set_a, set_b, kg, calc)
            kg.add_matchup(matchup)
            count += 1
    return count


# ── Legacy helpers (kept for backward compatibility) ─────────────────

def _offensive_score(
    attacker_set: SetClass,
    attacker_pokemon: PokemonClass,
    defender_pokemon: PokemonClass,
    kg: KnowledgeGraph,
) -> float:
    """Score how well attacker's STAB moves hit the defender (0.0 – 2.0)."""
    best = 0.0
    for move_id in attacker_set.moves:
        move = kg.get_move(move_id)
        if not move or move.is_status:
            continue
        is_stab = move.type in attacker_pokemon.types
        mult = get_effectiveness(move.type, defender_pokemon.types)
        if is_stab:
            mult *= 1.5
        best = max(best, mult)
    return best


def _best_move_effectiveness(
    attacker_set: SetClass,
    defender_pokemon: PokemonClass,
    kg: KnowledgeGraph,
) -> tuple[str, float]:
    """Return (move_type, best_effectiveness) for the attacker vs defender."""
    best_type = "Normal"
    best_mult = 0.0
    for move_id in attacker_set.moves:
        move = kg.get_move(move_id)
        if not move or move.is_status:
            continue
        mult = get_effectiveness(move.type, defender_pokemon.types)
        if mult > best_mult:
            best_mult = mult
            best_type = move.type
    return best_type, best_mult
