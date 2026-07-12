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
# Phase 7: Attribute system
from pokeredus.graph.attribute_registry import AttributeRegistry
from pokeredus.graph.attribute_factory import AttributeFactory
from pokeredus.graph.game_state import GameState, PokemonState, FieldState
from pokeredus.graph.synergy_detector import (
    SynergyDetector, SynergyLink, TeamSynergyProfile,
)
from pokeredus.graph.attribute_manager import AttributeManager, AttributeDefinition
from pokeredus.graph.common_attributes import (
    COMMON_ITEM_ATTRIBUTES,
    COMMON_ABILITY_ATTRIBUTES,
    COMMON_MOVE_ATTRIBUTES,
    get_all_common_attributes,
)
from pokeredus.graph.species_matchup_cache import SpeciesMatchupCache
# Matchup cache for species-level damage/TTK lookups
from pokeredus.graph.matchup_cache import MatchupCache, CachedMatchup
from pokeredus.graph.matchup_cache_provider import (
    CachedMatchupProvider, MatchupSnapshot,
)
# Phase 8: 3D matchup graph + AI query layer
from pokeredus.graph.matchup_graph import (
    MatchupGraphNode, GraphProjection, MatchupGraph,
    MoveRanking, SwitchRanking, TurnPlan,
    project_type_axis, project_offdef_axis, project_scu_axis,
    project_to_3d,
    pick_best_move, find_optimal_switch, analyze_game_state,
    SWITCH_ADVANTAGE_THRESHOLD,
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
    # Phase 7: Attribute system
    "AttributeRegistry", "AttributeFactory",
    "GameState", "PokemonState", "FieldState",
    "SynergyDetector", "SynergyLink", "TeamSynergyProfile",
    "AttributeManager", "AttributeDefinition",
    "COMMON_ITEM_ATTRIBUTES", "COMMON_ABILITY_ATTRIBUTES", "COMMON_MOVE_ATTRIBUTES",
    "get_all_common_attributes",
    "SpeciesMatchupCache",
    # Matchup cache (species-level damage/TTK)
    "MatchupCache", "CachedMatchup",
    "CachedMatchupProvider", "MatchupSnapshot",
    # Phase 8: 3D matchup graph + AI queries
    "MatchupGraphNode", "GraphProjection", "MatchupGraph",
    "MoveRanking", "SwitchRanking", "TurnPlan",
    "project_type_axis", "project_offdef_axis", "project_scu_axis",
    "project_to_3d",
    "pick_best_move", "find_optimal_switch", "analyze_game_state",
    "SWITCH_ADVANTAGE_THRESHOLD",
]
