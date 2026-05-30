"""
PokeRedus graph — KnowledgeGraph, matchup engine, analytics, and query functions.
"""

from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.matchup_engine import compute_matchup, compute_all_matchups
from pokeredus.graph.damage_calc import (
    DamageCalculator, DamageResult, DamageModifier,
    get_calculator, calculate_damage, best_move_ttk,
)
from pokeredus.graph.analytics import (
    SetStats, SpeciesMatchup, SetRanking,
    compute_set_stats, compute_all_set_stats,
    aggregate_matchups_by_species, rank_sets,
    get_best_set_per_species, matchup_matrix,
)
from pokeredus.graph.queries import (
    best_checks, best_counters, threats_to, weaknesses_of,
    team_coverage, team_weaknesses, gaps,
    speed_tier, speed_ranking, role_summary,
    species_threats, species_favorable, set_comparison,
)

__all__ = [
    "KnowledgeGraph",
    # Matchup engine
    "compute_matchup", "compute_all_matchups",
    # Damage calculator
    "DamageCalculator", "DamageResult", "DamageModifier",
    "get_calculator", "calculate_damage", "best_move_ttk",
    # Analytics
    "SetStats", "SpeciesMatchup", "SetRanking",
    "compute_set_stats", "compute_all_set_stats",
    "aggregate_matchups_by_species", "rank_sets",
    "get_best_set_per_species", "matchup_matrix",
    # Queries
    "best_checks", "best_counters", "threats_to", "weaknesses_of",
    "team_coverage", "team_weaknesses", "gaps",
    "speed_tier", "speed_ranking", "role_summary",
    "species_threats", "species_favorable", "set_comparison",
]
