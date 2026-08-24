"""
Dynamic Attribute Engine.
Calculates 8 sector scores (0-100) using configurable formulae.
Visualization only — not used by battle policy.
"""
from __future__ import annotations
import yaml
from typing import Any

from pokeredus.config import CONFIG_DIR

FORMULA_PATH = CONFIG_DIR / "attribute_formulas.yaml"

def load_formulas() -> dict:
    """Load sector formulas from pokeredus/data/config/attribute_formulas.yaml."""
    if not FORMULA_PATH.exists():
        return {}
    try:
        with open(FORMULA_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        print(f"Error loading formulas: {e}")
        return {}

def normalize(val: float, lower: float, upper: float) -> float:
    """Clamp and scale a value to 0..1 based on bounds."""
    if upper == lower:
        return 0.0
    return max(0.0, min(1.0, (val - lower) / (upper - lower)))

def calculate_sector_score(sector_name: str, data: dict, formulas: dict) -> float:
    """Evaluate a single sector formula using provided pokemon/set data."""
    config = formulas.get(sector_name)
    if not config:
        return 0.0

    formula = config.get("formula", "0")
    vars_config = config.get("vars", {})
    scale_config = config.get("scale", {"lower": 0, "upper": 100})

    # Context for evaluation
    context = {}
    for var_name, bounds in vars_config.items():
        raw_val = data.get(var_name, 0.0)
        context[var_name] = raw_val
        context[f"norm_{var_name}"] = normalize(raw_val, bounds["lower"], bounds["upper"])

    try:
        # Evaluate formula using a restricted environment that includes common functions
        result = eval(formula, {"__builtins__": {}}, {**context, "len": len, "max": max, "min": min, "abs": abs})
        
        low = scale_config["lower"]
        high = scale_config["upper"]
        return float(max(low, min(high, result)))
    except Exception as e:
        print(f"Formula error in {sector_name}: {e}")
        return 0.0

def compute_all_scores(pokemon: Any, set_obj: Any, formulas: dict) -> dict[str, float]:
    """
    Extracts raw data and computes all 8 sector scores.
    """
    # Extract effective stats
    data = {
        "hp": set_obj.effective_stat("hp", pokemon.base_stats, level=100),
        "atk": set_obj.effective_stat("atk", pokemon.base_stats, level=100),
        "def": set_obj.effective_stat("def", pokemon.base_stats, level=100),
        "spa": set_obj.effective_stat("spa", pokemon.base_stats, level=100),
        "spd": set_obj.effective_stat("spd", pokemon.base_stats, level=100),
        "spe": set_obj.effective_stat("spe", pokemon.base_stats, level=100),
        "eff_hp": set_obj.effective_stat("hp", pokemon.base_stats, level=100),
        "eff_atk": set_obj.effective_stat("atk", pokemon.base_stats, level=100),
        "eff_def": set_obj.effective_stat("def", pokemon.base_stats, level=100),
        "eff_spa": set_obj.effective_stat("spa", pokemon.base_stats, level=100),
        "eff_spd": set_obj.effective_stat("spd", pokemon.base_stats, level=100),
        "eff_spe": set_obj.effective_stat("spe", pokemon.base_stats, level=100),
        "bst": pokemon.bst,
        "weight": pokemon.weight,
        "is_legendary": float(pokemon.is_legendary),
        "moves": set_obj.moves,
    }

    from pokeredus.graph.matchup_graph import PIVOT_OR_RECOVERY
    moves_low = {m.lower() for m in set_obj.moves}
    
    # Basic categories for formula use
    data["support_moves"] = len(moves_low & PIVOT_OR_RECOVERY)
    data["pivot_moves"] = len(moves_low & PIVOT_OR_RECOVERY)
    data["recovery_moves"] = len(moves_low & PIVOT_OR_RECOVERY)
    data["boost_moves"] = 0
    data["priority_moves"] = 0

    sectors = ["attack", "utility", "defense", "speed", "threat", "punish", "sponge", "counter"]
    scores = {}
    for s in sectors:
        scores[s] = calculate_sector_score(s, data, formulas)
    
    return scores

def calculate_cumulative_score(scores: dict[str, float]) -> float:
    """Sum of all sector scores."""
    return sum(scores.values())
