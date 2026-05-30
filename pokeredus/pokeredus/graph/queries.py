"""
queries — high-level graph query functions for PokeRedus.

These functions operate on a KnowledgeGraph instance and return
structured results for the GUI and intelligence layers.

Phase 5 additions:
- species_threats: per-species aggregated threat ranking
- best_set_for_species: find the best-performing set per species
- set_comparison: compare two sets side by side
"""

from __future__ import annotations

from pokeredus.classes import MatchupRelation, SetClass
from pokeredus.graph.knowledge_graph import KnowledgeGraph


def best_checks(
    kg: KnowledgeGraph, set_id: str, top_n: int = 5, min_confidence: float = 0.3
) -> list[MatchupRelation]:
    """Return the top N sets that CHECK set_id (score > 0 from the target's perspective).

    A "check" means the returned set has a favorable matchup against set_id.
    We look at inbound matchup edges to set_id where the score favors the source.
    """
    inbound = kg.get_matchups_against(set_id, min_confidence=min_confidence)
    # Inbound: source → set_id, positive score means source wins
    checks = [m for m in inbound if m.score > 0.2]
    checks.sort(key=lambda m: m.score, reverse=True)
    return checks[:top_n]


def best_counters(
    kg: KnowledgeGraph, set_id: str, top_n: int = 5, min_confidence: float = 0.4
) -> list[MatchupRelation]:
    """Return the top N sets that COUNTER set_id (score >= 0.6 from source's perspective)."""
    inbound = kg.get_matchups_against(set_id, min_confidence=min_confidence)
    counters = [m for m in inbound if m.score >= 0.6]
    counters.sort(key=lambda m: m.score, reverse=True)
    return counters[:top_n]


def threats_to(
    kg: KnowledgeGraph, set_id: str, top_n: int = 5, min_confidence: float = 0.3
) -> list[MatchupRelation]:
    """Return the top N sets that set_id THREATENS (outbound favorable matchups)."""
    outbound = kg.get_matchups(set_id, min_confidence=min_confidence)
    threats = [m for m in outbound if m.score > 0.2]
    threats.sort(key=lambda m: m.score, reverse=True)
    return threats[:top_n]


def weaknesses_of(
    kg: KnowledgeGraph, set_id: str, top_n: int = 5, min_confidence: float = 0.3
) -> list[MatchupRelation]:
    """Return the top N sets that set_id LOSES TO (outbound unfavorable matchups)."""
    outbound = kg.get_matchups(set_id, min_confidence=min_confidence)
    weak = [m for m in outbound if m.score < -0.2]
    weak.sort(key=lambda m: m.score)  # worst first
    return weak[:top_n]


def team_coverage(
    kg: KnowledgeGraph, set_ids: list[str], min_confidence: float = 0.0
) -> dict[str, list[MatchupRelation]]:
    """Return a dict mapping each team member's set_id to its favorable matchups."""
    coverage: dict[str, list[MatchupRelation]] = {}
    for sid in set_ids:
        matchups = kg.get_matchups(sid, min_confidence=min_confidence)
        favorable = [m for m in matchups if m.score > 0.2]
        favorable.sort(key=lambda m: m.score, reverse=True)
        coverage[sid] = favorable
    return coverage


def team_weaknesses(
    kg: KnowledgeGraph, set_ids: list[str], min_confidence: float = 0.0
) -> dict[str, list[MatchupRelation]]:
    """Return a dict mapping each team member to its unfavorable matchups."""
    weaknesses: dict[str, list[MatchupRelation]] = {}
    for sid in set_ids:
        matchups = kg.get_matchups(sid, min_confidence=min_confidence)
        unfavorable = [m for m in matchups if m.score < -0.2]
        unfavorable.sort(key=lambda m: m.score)
        weaknesses[sid] = unfavorable
    return weaknesses


def gaps(
    kg: KnowledgeGraph, set_ids: list[str], min_confidence: float = 0.3
) -> list[dict]:
    """Find meta threats that no team member handles well.

    Returns a list of dicts: {"threat_id": str, "best_answer": str, "best_score": float}
    where best_score < 0.3 means no one on the team has a favorable matchup.
    """
    all_sets = kg.get_all_sets()
    team_set = set(set_ids)

    gap_list: list[dict] = []
    for meta_set in all_sets:
        if meta_set.id in team_set:
            continue
        # Find the best team member against this meta set
        best_score = -2.0
        best_answer = ""
        for team_id in set_ids:
            mu = kg.get_matchup_between(team_id, meta_set.id)
            if mu and mu.confidence >= min_confidence and mu.score > best_score:
                best_score = mu.score
                best_answer = team_id
        # If no matchup data exists at all, skip
        if best_score == -2.0:
            continue
        if best_score < 0.3:
            gap_list.append({
                "threat_id": meta_set.id,
                "threat_name": meta_set.set_name,
                "pokemon_id": meta_set.pokemon_id,
                "best_answer": best_answer,
                "best_score": round(best_score, 3),
            })

    gap_list.sort(key=lambda g: g["best_score"])
    return gap_list


def speed_tier(
    kg: KnowledgeGraph, set_id: str, level: int = 50
) -> int | None:
    """Return the effective speed stat for a set, or None if data is missing."""
    s = kg.get_set(set_id)
    if not s:
        return None
    p = kg.get_pokemon(s.pokemon_id)
    if not p:
        return None
    return s.effective_stat("spe", p.base_stats, level=level)


def speed_ranking(
    kg: KnowledgeGraph, level: int = 50
) -> list[tuple[str, int]]:
    """Return all sets sorted by effective speed (fastest first)."""
    rankings: list[tuple[str, int]] = []
    for s in kg.get_all_sets():
        p = kg.get_pokemon(s.pokemon_id)
        if p:
            spd = s.effective_stat("spe", p.base_stats, level=level)
            rankings.append((s.id, spd))
    rankings.sort(key=lambda x: x[1], reverse=True)
    return rankings


def role_summary(
    kg: KnowledgeGraph, set_ids: list[str]
) -> dict[str, int]:
    """Return a count of roles across the team."""
    counts: dict[str, int] = {}
    for sid in set_ids:
        s = kg.get_set(sid)
        if s:
            role = s.role or "unclassified"
            counts[role] = counts.get(role, 0) + 1
    return counts


# ── Phase 5: Analytics-Aware Queries ─────────────────────────────────

def species_threats(
    kg: KnowledgeGraph,
    set_id: str,
    top_n: int = 10,
) -> list[dict]:
    """Return per-species threat ranking for a set.

    Collapses multiple sets of the same species into one entry,
    using the worst-case set (hardest for us to beat).

    Returns list of dicts with: pokemon_id, pokemon_name, repr_set_id,
    repr_set_name, score, turns_to_kill, speed_advantage, category.
    """
    from pokeredus.graph.analytics import aggregate_matchups_by_species
    defense = aggregate_matchups_by_species(kg, set_id, direction="defense")
    return [
        {
            "pokemon_id": m.pokemon_id,
            "pokemon_name": m.pokemon_name,
            "repr_set_id": m.repr_set_id,
            "repr_set_name": m.repr_set_name,
            "score": round(m.score, 4),
            "turns_to_kill_them": m.turns_to_kill_them,
            "turns_to_kill_us": m.turns_to_kill_us,
            "speed_advantage": m.speed_advantage,
            "our_best_move": m.our_best_move,
            "their_best_move": m.their_best_move,
            "category": m.category,
        }
        for m in defense[:top_n]
    ]


def species_favorable(
    kg: KnowledgeGraph,
    set_id: str,
    top_n: int = 10,
) -> list[dict]:
    """Return per-species favorable matchup ranking for a set.

    Uses the easiest set per species (best-case for us).
    """
    from pokeredus.graph.analytics import aggregate_matchups_by_species
    offense = aggregate_matchups_by_species(kg, set_id, direction="offense")
    return [
        {
            "pokemon_id": m.pokemon_id,
            "pokemon_name": m.pokemon_name,
            "repr_set_id": m.repr_set_id,
            "repr_set_name": m.repr_set_name,
            "score": round(m.score, 4),
            "turns_to_kill_them": m.turns_to_kill_them,
            "turns_to_kill_us": m.turns_to_kill_us,
            "speed_advantage": m.speed_advantage,
            "our_best_move": m.our_best_move,
            "their_best_move": m.their_best_move,
            "category": m.category,
        }
        for m in offense[:top_n]
    ]


def set_comparison(
    kg: KnowledgeGraph,
    set_a_id: str,
    set_b_id: str,
) -> dict | None:
    """Compare two sets side by side with TTK details."""
    from pokeredus.graph.analytics import compute_set_stats

    set_a = kg.get_set(set_a_id)
    set_b = kg.get_set(set_b_id)
    if not set_a or not set_b:
        return None

    mu = kg.get_matchup_between(set_a_id, set_b_id)
    mu_rev = kg.get_matchup_between(set_b_id, set_a_id)

    stats_a = compute_set_stats(kg, set_a)
    stats_b = compute_set_stats(kg, set_b)

    return {
        "set_a": {
            "id": set_a.id,
            "name": set_a.set_name,
            "pokemon_id": set_a.pokemon_id,
            "stats": stats_a.as_dict(),
            "bst": stats_a.bst,
        },
        "set_b": {
            "id": set_b.id,
            "name": set_b.set_name,
            "pokemon_id": set_b.pokemon_id,
            "stats": stats_b.as_dict(),
            "bst": stats_b.bst,
        },
        "matchup_a_vs_b": mu.to_dict() if mu else None,
        "matchup_b_vs_a": mu_rev.to_dict() if mu_rev else None,
    }
