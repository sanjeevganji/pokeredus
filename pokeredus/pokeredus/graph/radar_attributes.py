"""radar_attributes — On-the-fly 8-attribute radar computation engine.

Computes 8 scalar values (0-100) for a Pokémon set's radial bar chart.
Values are NOT stored per set — they are computed fresh each render from
the set's moves, stats, types, item, and ability data.

The 8 attributes in compass-rose order:
  0°   attack  — base damage output (moves + STAB + items/abilities)
  45°  threat  — compound: attack × speed (speed-tier damage reach)
  90°  speed   — normalized speed (priority, Trick Room)
 135°  punish  — compound: utility × speed (punish with speed advantage)
 180°  utility — setup, hazards, field, healing, pivoting
 225°  sponge  — compound: defense × utility (tank + recovery/hazards)
 270°  defense — base tanking across all attack types
 315°  counter — compound: attack × defense (dish + take)

Formula constants are loaded from ``pokeredus/data/config/radar_config.json``.
Built-in RadarConfig defaults apply for any missing key.

Public API:
  compute_radar_8(set_obj, pokemon, kg) -> dict[str, float]
  load_radar_config() -> RadarConfig
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pokeredus.classes.sets import SetClass
    from pokeredus.classes.pokemon import PokemonClass

# ── Canonical attribute order (matches ATTRIBUTE_NAMES in matchup_graph) ──

ATTRIBUTE_NAMES: list[str] = [
    "attack", "threat", "speed", "punish",
    "utility", "sponge", "defense", "counter",
]

# ── Move buckets (same source as matchup_graph.py) ────────────────────

_SETUP_MOVES: set[str] = {
    "swordsdance", "nastyplot", "calmindmind", "dragondance",
    "bulkup", "coil", "quiverdance", "shellsmash", "workup",
}

_HAZARD_SETTER_MOVES: set[str] = {
    "stealthrock", "spikes", "toxicspikes", "stickyweb",
}

_HAZARD_REMOVAL_MOVES: set[str] = {
    "defog", "rapidspin", "tidyup", "mortalspin",
}

_HEALING_MOVES: set[str] = {
    "recover", "softboiled", "roost", "wish", "milkdrink",
    "morningsun", "moonlight", "synthesis", "healorder", "slackoff",
}

_FIELD_MOVES: set[str] = {
    "trickroom", "tailwind", "lightscreen", "reflect", "auroraveil",
    "sunnyday", "raindance", "sandstorm", "snowscape",
    "electricterrain", "grassyterrain", "psychicterrain", "mistyterrain",
}

_PIVOT_MOVES: set[str] = {
    "uturn", "voltswitch", "partingshot", "whirlwind", "roar",
    "dragontail", "circlethrow", "teleport", "batonpass",
}

_STATUS_MOVES: set[str] = {
    "spore", "sleeppowder", "stunspore", "thunderwave", "willowisp",
    "toxic", "swagger", "confuseray", "haze",
}

_PRIORITY_MOVES: set[str] = {
    "extremespeed", "suckerpunch", "aquajet", "bulletpunch",
    "machpunch", "shadowsneak", "quickattack", "vacuumwave",
    "icepunch", "thunderpunch",
}

_PROTECT_MOVES: set[str] = {
    "protect", "substitute",
}

_ALL_UTILITY: set[str] = (
    _SETUP_MOVES | _HAZARD_SETTER_MOVES | _HAZARD_REMOVAL_MOVES
    | _HEALING_MOVES | _FIELD_MOVES | _PIVOT_MOVES | _STATUS_MOVES
    | _PROTECT_MOVES
)

# ── Item / Ability modifiers (IDs are lowercase Showdown slugs) ───────

_CHOICE_ITEMS: set[str] = {"choiceband", "choicespecs", "choicescarf"}
_POWER_ITEMS: set[str] = {"lifeorb", "expertbelt", "muscleband", "wiseberries"}
_BOOST_ABILITIES_ATK: set[str] = {
    "hugepower", "purepower", "hustle", "parentalbond",
    "technician", "sheerforce", "ironfist", "strongjaw",
    "reckless", "adaptability", "protosynthesis",
}
_BOOST_ABILITIES_DEF: set[str] = {
    "multiscale", "intimidate", "marvelscale", "furcoat",
    "iceface", "disguise", "magicbounce", "goodsgold",
}
_BOOST_ABILITIES_SPE: set[str] = {
    "speedboost", "unburden", "swiftswim", "chlorophyll",
    "sandrush", "slushrush", "surgesurfer", "windrider",
    "quickfeet", "motordrive", "steadfast",
}
_REGEN_ABILITIES: set[str] = {
    "regenerator", "naturalcure", "healer",
}
_ABSORB_ABILITIES: set[str] = {
    "voltabsorb", "waterabsorb", "flashfire", "dryskin",
    "stormdrain", "lightningrod", "motordrive", "eartheater",
}

# ── RadarConfig: all tunable formula constants ────────────────────────


@dataclass
class RadarConfig:
    """All tunable parameters for the 8-attribute radar.

    Defaults are chosen so typical OU sets produce a spread across 0-100.
    ``load_radar_config()`` overlays ``data/config/radar_config.json``.
    """

    # ── Attack formula ──────────────────────────────────────────────
    atk_scale: float = 400.0      # logistic midpoint for raw attack sum
    atk_steepness: float = 1.5    # logistic steepness for attack
    stab_multiplier: float = 1.5  # STAB damage bonus
    nuke_threshold: int = 100     # BP >= this counts as a "nuke"
    nuke_bonus: float = 1.2       # multiplier for nuke moves
    choice_atk_mult: float = 1.5  # Choice Band/Specs damage multiplier
    lifeorb_mult: float = 1.3     # Life Orb damage multiplier
    atk_ability_mult: float = 1.3 # generic atk-boosting ability multiplier

    # ── Speed formula ───────────────────────────────────────────────
    spe_floor: float = 50.0       # stat below this → 0
    spe_ceiling: float = 200.0    # stat at or above this → 100
    priority_bonus: float = 15.0  # flat bonus for having priority moves
    trickroom_invert: bool = True # if True, invert speed when Trick Room

    # ── Utility formula ─────────────────────────────────────────────
    util_scale: float = 4.0       # logistic midpoint for utility point sum
    util_steepness: float = 1.2   # logistic steepness for utility
    setup_points: float = 2.0     # points per setup move
    hazard_set_points: float = 1.5  # points per hazard-setter move
    hazard_remove_points: float = 1.0  # points per hazard-removal move
    heal_points: float = 1.5      # points per healing move
    field_points: float = 1.0     # points per field-condition move
    pivot_points: float = 1.0     # points per pivot move
    status_points: float = 1.5    # points per status-inflict move
    protect_points: float = 0.5   # points per protect/sub move
    regen_ability_points: float = 1.5  # points for Regenerator etc.
    item_util_points: float = 0.5 # generic utility item bonus

    # ── Defense formula ─────────────────────────────────────────────
    def_scale: float = 4.0        # logistic midpoint for defense point sum
    def_steepness: float = 1.3    # logistic steepness for defense
    resist_weight: float = 1.5    # weight per 0.5× resistance
    immune_weight: float = 3.0    # weight per 0× immunity
    weakness_penalty: float = 1.0 # penalty per 2× weakness
    quadweak_penalty: float = 2.0 # penalty per 4× double-weakness
    def_ability_mult: float = 1.3 # generic def-boosting ability multiplier
    absorb_ability_pts: float = 2.0  # flat points for absorb abilities
    item_def_points: float = 0.5  # generic defensive item bonus

    # ── Compound formula ────────────────────────────────────────────
    compound_method: str = "geometric_mean"  # "geometric_mean" or "product"
    compound_scale: float = 80.0   # logistic midpoint for compound values
    compound_steepness: float = 1.5  # logistic steepness for compounds


# ── Singleton config (loaded once, reloaded on demand) ────────────────

_config: RadarConfig | None = None


def get_radar_config() -> RadarConfig:
    """Return the current radar config, lazy-loading from data/config."""
    global _config
    if _config is None:
        _config = load_radar_config()
    return _config


def reload_radar_config() -> RadarConfig:
    """Force-reload the radar config from disk."""
    global _config
    _config = load_radar_config()
    return _config


def load_radar_config() -> RadarConfig:
    """Load radar formula constants from data/config/radar_config.json."""
    from pokeredus.config import CONFIG_DIR
    cfg = RadarConfig()
    path = CONFIG_DIR / "radar_config.json"
    if not path.exists():
        return cfg
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return cfg
    if not isinstance(data, dict):
        return cfg
    for name, val in data.items():
        if hasattr(cfg, name):
            setattr(cfg, name, val)
    return cfg


# ── Logistic scaling ─────────────────────────────────────────────────


def logistic_scale(raw: float, k: float = 1.0, p: float = 1.0) -> float:
    """Logistic polynomial scaling to 0-100.

    ``scaled = 100 * ((raw/k)^p) / (1 + (raw/k)^p)``

    Works on scalars. Negative raw clamped to 0.
    """
    r = max(raw, 0.0)
    safe_k = max(k, 1e-9)
    z = (r / safe_k) ** p
    return 100.0 * z / (1.0 + z)


# ── Knowledge-graph move lookups (with fallback) ─────────────────────

_FALLBACK_MOVES: dict[str, tuple[str, float, int, str]] = {
    # (type, bp, priority, category)
    "sludgebomb": ("Poison", 90, 0, "Special"),
    "leafstorm": ("Grass", 130, 0, "Special"),
    "sleeppowder": ("Grass", 0, 0, "Status"),
    "willowisp": ("Fire", 0, 0, "Status"),
    "spore": ("Grass", 0, 0, "Status"),
    "toxic": ("Poison", 0, 0, "Status"),
    "uturn": ("Bug", 70, 0, "Physical"),
    "voltswitch": ("Electric", 70, 0, "Special"),
    "thunderwave": ("Electric", 0, 0, "Status"),
    "extremespeed": ("Normal", 40, 1, "Physical"),
    "suckerpunch": ("Dark", 70, -1, "Physical"),  # technically +1 in some contexts
    "swordsdance": ("Normal", 0, 0, "Status"),
    "nastyplot": ("Dark", 0, 0, "Status"),
    "calmindmind": ("Psychic", 0, 0, "Status"),
    "recover": ("Normal", 0, 0, "Status"),
    "softboiled": ("Normal", 0, 0, "Status"),
    "roost": ("Flying", 0, 0, "Status"),
    "stealthrock": ("Rock", 0, 0, "Status"),
    "spikes": ("Ground", 0, 0, "Status"),
    "defog": ("Flying", 0, 0, "Status"),
    "rapidspin": ("Normal", 50, 0, "Physical"),
    "earthquake": ("Ground", 100, 0, "Physical"),
    "icebeam": ("Ice", 90, 0, "Special"),
    "thunderbolt": ("Electric", 90, 0, "Special"),
    "flamethrower": ("Fire", 90, 0, "Special"),
    "surf": ("Water", 90, 0, "Special"),
    "moonblast": ("Fairy", 95, 0, "Special"),
    "shadowball": ("Ghost", 80, 0, "Special"),
    "drainpunch": ("Fighting", 75, 0, "Physical"),
    "knockoff": ("Dark", 65, 0, "Physical"),
    "ironhead": ("Steel", 80, 0, "Physical"),
    "psychic": ("Psychic", 90, 0, "Special"),
    "darkpulse": ("Dark", 80, 0, "Special"),
    "dracometeor": ("Dragon", 130, 0, "Special"),
    "closecombat": ("Fighting", 120, 0, "Physical"),
    "flareblitz": ("Fire", 120, 0, "Physical"),
    "stoneedge": ("Rock", 100, 0, "Physical"),
    "earthpower": ("Ground", 90, 0, "Special"),
    "boomburst": ("Normal", 140, 0, "Special"),
    "bravebird": ("Flying", 120, 0, "Physical"),
    "scald": ("Water", 80, 0, "Special"),
    "dragondance": ("Dragon", 0, 0, "Status"),
    "protect": ("Normal", 0, 4, "Status"),
    "substitute": ("Normal", 0, 0, "Status"),
    "aquajet": ("Water", 40, 1, "Physical"),
    "bulletpunch": ("Steel", 40, 1, "Physical"),
    "machpunch": ("Fighting", 40, 1, "Physical"),
    "shadowsneak": ("Ghost", 40, 1, "Physical"),
    "quickattack": ("Normal", 40, 1, "Physical"),
    "vacuumwave": ("Fighting", 40, 1, "Special"),
    "icepunch": ("Ice", 75, 0, "Physical"),
    "thunderpunch": ("Electric", 75, 0, "Physical"),
    "wish": ("Normal", 0, 0, "Status"),
    "batonpass": ("Normal", 0, 0, "Status"),
    "teleport": ("Psychic", 0, -6, "Status"),
    "haze": ("Ice", 0, 0, "Status"),
    "partingshot": ("Dark", 0, 0, "Status"),
    "whirlwind": ("Normal", 0, -6, "Status"),
    "roar": ("Normal", 0, -6, "Status"),
    "dragontail": ("Dragon", 60, -6, "Physical"),
    "circlethrow": ("Fighting", 60, -6, "Physical"),
    "trickroom": ("Psychic", 0, -7, "Status"),
    "tailwind": ("Flying", 0, 0, "Status"),
    "lightscreen": ("Psychic", 0, 0, "Status"),
    "reflect": ("Psychic", 0, 0, "Status"),
    "auroraveil": ("Ice", 0, 0, "Status"),
    "toxicspikes": ("Poison", 0, 0, "Status"),
    "stickyweb": ("Bug", 0, 0, "Status"),
    "tidyup": ("Normal", 0, 0, "Status"),
    "mortalspin": ("Poison", 60, 0, "Physical"),
}


def _lookup_move(mid: str, kg) -> tuple[str | None, float, int, str | None]:
    """Return (type, bp, priority, category) for a move ID.

    Uses the KnowledgeGraph if available, else falls back to the
    built-in table.
    """
    if kg is not None:
        try:
            mv = kg.get_move(mid)
            if mv is not None:
                mt = getattr(mv, "type", None)
                bp = float(getattr(mv, "base_power", 0) or 0)
                pri = int(getattr(mv, "priority", 0) or 0)
                cat = getattr(mv, "category", None)
                return mt, bp, pri, cat
        except Exception:
            pass
    fb = _FALLBACK_MOVES.get(mid.lower(), (None, 0.0, 0, None))
    return fb


def _eff_spe(set_obj, p) -> float:
    """Compute effective Speed stat for the set."""
    try:
        return float(set_obj.effective_stat("spe", p.base_stats, level=100))
    except Exception:
        return float(p.base_stats.get("spe", 100))


# ── Type effectiveness helper ─────────────────────────────────────────


def _type_effectiveness_for_def(p_types: list[str]) -> dict[str, float]:
    """Return {attacking_type: effectiveness_mult} for the defending Pokémon."""
    from pokeredus.classes import get_effectiveness
    from pokeredus.config import POKEMON_TYPES
    result = {}
    for atk_type in POKEMON_TYPES:
        result[atk_type] = get_effectiveness(atk_type, p_types)
    return result


# ── 4 base attribute computations ────────────────────────────────────


def _compute_attack(set_obj: SetClass, pokemon: PokemonClass, kg, cfg: RadarConfig) -> float:
    """Raw attack score: weighted sum of move damage contributions.

    Considers base power, STAB, nuke bonus, item boosts, and ability boosts.
    """
    raw = 0.0
    item_lower = (set_obj.item or "").lower()
    ability_lower = (set_obj.ability or "").lower()

    # Item multiplier
    item_mult = 1.0
    if item_lower in _CHOICE_ITEMS:
        if item_lower == "choiceband" or item_lower == "choicespecs":
            item_mult = cfg.choice_atk_mult
        # Choice Scarf doesn't boost attack
    if item_lower == "lifeorb":
        item_mult = max(item_mult, cfg.lifeorb_mult)

    # Ability multiplier
    ability_mult = 1.0
    if ability_lower in _BOOST_ABILITIES_ATK:
        ability_mult = cfg.atk_ability_mult

    for mid in set_obj.moves:
        move_type, bp, _pri, cat = _lookup_move(mid, kg)
        if not move_type or bp <= 0:
            continue
        # STAB
        stab = cfg.stab_multiplier if move_type in pokemon.types else 1.0
        # Nuke bonus for high-BP moves
        nuke = cfg.nuke_bonus if bp >= cfg.nuke_threshold else 1.0
        raw += bp * stab * nuke * item_mult * ability_mult

    return raw


def _compute_speed(set_obj: SetClass, pokemon: PokemonClass, kg, cfg: RadarConfig) -> float:
    """Raw speed score: normalized effective speed with priority bonus.

    Linear mapping from [spe_floor, spe_ceiling] → [0, 80], then
    +priority_bonus for each priority move (max +20).
    """
    spe = _eff_spe(set_obj, pokemon)

    # Base speed: linear 0-80
    if spe <= cfg.spe_floor:
        base = 0.0
    elif spe >= cfg.spe_ceiling:
        base = 80.0
    else:
        base = 80.0 * (spe - cfg.spe_floor) / (cfg.spe_ceiling - cfg.spe_floor)

    # Priority bonus: up to +20 (capped at 100 total)
    pri_bonus = 0.0
    for mid in set_obj.moves:
        _, _, pri, _ = _lookup_move(mid, kg)
        if pri > 0:
            pri_bonus += cfg.priority_bonus
    pri_bonus = min(pri_bonus, 20.0)

    raw = base + pri_bonus

    # Trick Room inversion: slow = good → invert the base portion
    if cfg.trickroom_invert:
        has_tr = any(m.lower() == "trickroom" for m in set_obj.moves)
        if has_tr:
            raw = 80.0 - base + pri_bonus  # slow Pokémon get high score

    return min(raw, 100.0)


def _compute_utility(set_obj: SetClass, pokemon: PokemonClass, kg, cfg: RadarConfig) -> float:
    """Raw utility score: sum of utility points for various move roles.

    Considers setup, hazards, healing, field conditions, pivoting,
    status, protection, and ability/item bonuses.
    """
    moves_lower = {m.lower() for m in set_obj.moves}
    ability_lower = (set_obj.ability or "").lower()
    item_lower = (set_obj.item or "").lower()

    pts = 0.0

    # Move-role points
    pts += sum(cfg.setup_points for m in moves_lower if m in _SETUP_MOVES)
    pts += sum(cfg.hazard_set_points for m in moves_lower if m in _HAZARD_SETTER_MOVES)
    pts += sum(cfg.hazard_remove_points for m in moves_lower if m in _HAZARD_REMOVAL_MOVES)
    pts += sum(cfg.heal_points for m in moves_lower if m in _HEALING_MOVES)
    pts += sum(cfg.field_points for m in moves_lower if m in _FIELD_MOVES)
    pts += sum(cfg.pivot_points for m in moves_lower if m in _PIVOT_MOVES)
    pts += sum(cfg.status_points for m in moves_lower if m in _STATUS_MOVES)
    pts += sum(cfg.protect_points for m in moves_lower if m in _PROTECT_MOVES)

    # Ability utility
    if ability_lower in _REGEN_ABILITIES:
        pts += cfg.regen_ability_points

    # Item utility (Leftovers, Heavy-Duty Boots, etc.)
    utility_items = {"leftovers", "heavydutyboots", "rockyhelmet", "blacksludge"}
    if item_lower in utility_items:
        pts += cfg.item_util_points

    return pts


def _compute_defense(set_obj: SetClass, pokemon: PokemonClass, kg, cfg: RadarConfig) -> float:
    """Raw defense score: type-resistance profile × stat bulk × item/ability.

    For each of the 18 attacking types:
      - Resistance (0.5×) → +resist_weight points
      - Immunity (0×) → +immune_weight points
      - Weakness (2×) → -weakness_penalty points
      - Double weakness (4×) → -quadweak_penalty points
    Sum is then multiplied by a bulk factor from HP and defensive stats,
    and item/ability bonuses.
    """
    eff_map = _type_effectiveness_for_def(pokemon.types)
    pts = 0.0

    for atk_type, mult in eff_map.items():
        if mult == 0.0:
            pts += cfg.immune_weight
        elif mult < 1.0:
            pts += cfg.resist_weight * (1.0 / mult - 1.0)  # 0.5× → +1.5, 0.25× → +4.5
        elif mult == 1.0:
            pts += 0.0
        elif mult == 2.0:
            pts -= cfg.weakness_penalty
        elif mult >= 4.0:
            pts -= cfg.quadweak_penalty

    # Ability defense bonus
    ability_lower = (set_obj.ability or "").lower()
    ability_mult = 1.0
    if ability_lower in _BOOST_ABILITIES_DEF:
        ability_mult = cfg.def_ability_mult

    # Absorb abilities (flat bonus per immunity granted by ability)
    absorb_pts = 0.0
    if ability_lower in _ABSORB_ABILITIES:
        absorb_pts = cfg.absorb_ability_pts

    # Bulk factor: geometric mean of HP and average of def+spd, normalized
    try:
        hp = set_obj.effective_stat("hp", pokemon.base_stats, level=100)
        df = set_obj.effective_stat("def", pokemon.base_stats, level=100)
        sd = set_obj.effective_stat("spd", pokemon.base_stats, level=100)
        avg_def = (df + sd) / 2.0
        # Bulk = sqrt(hp * avg_def), typical range ~100-400
        bulk = math.sqrt(hp * avg_def)
        # Normalize: bulk=100 → ×1.0, bulk=400 → ×2.0, bulk=50 → ×0.5
        bulk_factor = max(bulk / 200.0, 0.3)
    except Exception:
        bulk_factor = 1.0

    # Item defense bonus
    item_lower = (set_obj.item or "").lower()
    def_items = {"leftovers", "heavydutyboots", "assaultvest", "eviolite"}
    item_pts = cfg.item_def_points if item_lower in def_items else 0.0

    raw = (pts * ability_mult * bulk_factor) + absorb_pts + item_pts
    return raw


# ── Compound attribute computations ──────────────────────────────────


def _compute_compound(base_a: float, base_b: float, cfg: RadarConfig) -> float:
    """Compute a compound attribute from two base attributes.

    Uses geometric mean by default: sqrt(a * b), which naturally
    bounds the compound between 0 and the geometric mean of the
    two bases. With the "product" method, uses a*b/100 instead.
    """
    if cfg.compound_method == "geometric_mean":
        return math.sqrt(max(base_a, 0.0) * max(base_b, 0.0))
    else:  # "product"
        return max(base_a, 0.0) * max(base_b, 0.0) / 100.0


# ── Main entry point ─────────────────────────────────────────────────


def compute_radar_8(
    set_obj: SetClass,
    pokemon: PokemonClass,
    kg=None,
    config: RadarConfig | None = None,
) -> dict[str, float]:
    """Compute all 8 radar attributes on-the-fly.

    Returns a dict mapping attribute name → float (0-100) in the
    canonical compass-rose order. Each value is logistic-scaled.

    Args:
        set_obj: The competitive set (moves, item, ability, EVs, nature).
        pokemon: The species data (base_stats, types).
        kg: KnowledgeGraph for move lookups (None → fallback table).
        config: Override config (None → load from Obsidian / defaults).

    Returns:
        dict with keys: attack, threat, speed, punish,
                        utility, sponge, defense, counter
        All values in [0, 100].
    """
    cfg = config or get_radar_config()

    # ── Base attributes (raw, then logistic-scaled to 0-100) ────────
    attack_raw = _compute_attack(set_obj, pokemon, kg, cfg)
    attack = logistic_scale(attack_raw, cfg.atk_scale, cfg.atk_steepness)

    speed_raw = _compute_speed(set_obj, pokemon, kg, cfg)
    # speed_raw is already 0-100 from linear+bonus, but we still pass
    # through logistic for consistency (with k=100, p=1, linear input
    # maps almost 1:1 since 100*(100/100)/(1+100/100)=50... so we
    # just clamp instead)
    speed = max(0.0, min(100.0, speed_raw))

    utility_raw = _compute_utility(set_obj, pokemon, kg, cfg)
    utility = logistic_scale(utility_raw, cfg.util_scale, cfg.util_steepness)

    defense_raw = _compute_defense(set_obj, pokemon, kg, cfg)
    defense = logistic_scale(defense_raw, cfg.def_scale, cfg.def_steepness)

    # ── Compound attributes ─────────────────────────────────────────
    # threat  = attack × speed (damage reach via speed tiers)
    # punish  = utility × speed (punish with speed advantage)
    # sponge  = defense × utility (tank + recovery/hazards)
    # counter = attack × defense (dish damage + take hits)
    threat_raw = _compute_compound(attack, speed, cfg)
    punish_raw = _compute_compound(utility, speed, cfg)
    sponge_raw = _compute_compound(defense, utility, cfg)
    counter_raw = _compute_compound(attack, defense, cfg)

    threat = logistic_scale(threat_raw, cfg.compound_scale, cfg.compound_steepness)
    punish = logistic_scale(punish_raw, cfg.compound_scale, cfg.compound_steepness)
    sponge = logistic_scale(sponge_raw, cfg.compound_scale, cfg.compound_steepness)
    counter = logistic_scale(counter_raw, cfg.compound_scale, cfg.compound_steepness)

    return {
        "attack": attack,
        "threat": threat,
        "speed": speed,
        "punish": punish,
        "utility": utility,
        "sponge": sponge,
        "defense": defense,
        "counter": counter,
    }


def radar_values_list(result: dict[str, float]) -> list[float]:
    """Convert the dict output of compute_radar_8 to a list in
    ATTRIBUTE_NAMES order (for the 2D renderer)."""
    return [result[name] for name in ATTRIBUTE_NAMES]
