"""
analytics — Matchup analytics engine for PokeRedus.

Provides:
1. Per-species matchup aggregation (collapse multiple sets to one representative)
2. MCTS-style set ranking (composite score from TTK + speed + win rate)
3. Computed stat helpers (all stats at level 100 with EVs/IVs/nature)
4. Matchup matrix computation

All functions operate on a KnowledgeGraph and use the DamageCalculator
for TTK-based scoring.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from pokeredus.graph.damage_calc import DamageCalculator, get_calculator

if TYPE_CHECKING:
    from pokeredus.graph.knowledge_graph import KnowledgeGraph
    from pokeredus.classes import SetClass, PokemonClass


# ── Data Structures ──────────────────────────────────────────────────

@dataclass
class SetStats:
    """Computed stats for a single set at a given level."""

    set_id: str
    pokemon_id: str
    set_name: str
    level: int = 100
    hp: int = 0
    atk: int = 0
    def_: int = 0
    spa: int = 0
    spd: int = 0
    spe: int = 0

    @property
    def bst(self) -> int:
        return self.hp + self.atk + self.def_ + self.spa + self.spd + self.spe

    def get(self, stat: str) -> int:
        if stat == "def":
            return self.def_
        return getattr(self, stat, 0)

    def as_dict(self) -> dict[str, int]:
        return {
            "hp": self.hp, "atk": self.atk, "def": self.def_,
            "spa": self.spa, "spd": self.spd, "spe": self.spe,
        }


@dataclass
class SpeciesMatchup:
    """Aggregated matchup against a species (representative set)."""

    pokemon_id: str
    pokemon_name: str
    repr_set_id: str           # the representative set for this species
    repr_set_name: str         # display name of the repr set
    score: float               # matchup score [-1, +1]
    turns_to_kill_us: int      # they kill us in N turns
    turns_to_kill_them: int    # we kill them in N turns
    speed_advantage: str       # "us", "them", "tie"
    our_best_move: str         # move name
    their_best_move: str       # move name
    category: str              # "counter", "check", "neutral", etc.
    damage_us_to_them: int = 0
    damage_them_to_us: int = 0
    is_best_for_us: bool = False    # this is the easiest set to beat
    is_worst_for_us: bool = False   # this is the hardest set to beat

    # Damage range fields (85–100% random roll)
    min_damage_us: int = 0
    max_damage_us: int = 0
    min_damage_them: int = 0
    max_damage_them: int = 0
    damage_pct_us_lo: float = 0.0   # our min roll as % of their HP
    damage_pct_us_hi: float = 0.0   # our max roll as % of their HP
    damage_pct_them_lo: float = 0.0 # their min roll as % of our HP
    damage_pct_them_hi: float = 0.0 # their max roll as % of our HP
    min_ttk_us: int = 0             # best-case TTK (fewest turns)
    max_ttk_us: int = 0             # worst-case TTK (most turns)
    min_ttk_them: int = 0
    max_ttk_them: int = 0
    # ── Display helpers ─────────────────────────────────────────────
    @property
    def damage_range_us_str(self) -> str:
        """Our damage range like '45.2 – 53.1%'."""
        if self.damage_pct_us_lo <= 0:
            return "—"
        lo, hi = self.damage_pct_us_lo, self.damage_pct_us_hi
        if abs(lo - hi) < 0.5:
            return f"{hi:.1f}%"
        return f"{lo:.1f} – {hi:.1f}%"

    @property
    def damage_range_them_str(self) -> str:
        """Their damage range like '45.2 – 53.1%'."""
        if self.damage_pct_them_lo <= 0:
            return "—"
        lo, hi = self.damage_pct_them_lo, self.damage_pct_them_hi
        if abs(lo - hi) < 0.5:
            return f"{hi:.1f}%"
        return f"{lo:.1f} – {hi:.1f}%"

    @property
    def ttk_range_us_str(self) -> str:
        """Our TTK range like '2-3HKO'."""
        if self.min_ttk_us <= 0:
            return "—"
        if self.min_ttk_us == self.max_ttk_us:
            return f"{self.min_ttk_us}HKO"
        return f"{self.min_ttk_us}-{self.max_ttk_us}HKO"

    @property
    def ttk_range_them_str(self) -> str:
        """Their TTK range like '2-3HKO'."""
        if self.min_ttk_them <= 0:
            return "—"
        if self.min_ttk_them == self.max_ttk_them:
            return f"{self.min_ttk_them}HKO"
        return f"{self.min_ttk_them}-{self.max_ttk_them}HKO"


@dataclass
class SetRanking:
    """MCTS-style ranking for a single set."""

    set_id: str
    pokemon_id: str
    set_name: str
    win_rate: float              # fraction of matchups with positive score
    mean_ttk_against: float      # average turns to kill opponents
    mean_ttk_by: float           # average turns for opponents to kill us
    speed_advantage_rate: float  # fraction of matchups where we're faster
    composite_score: float       # weighted combination
    best_matchup: str            # set_id of easiest matchup
    worst_matchup: str           # set_id of hardest matchup
    total_matchups: int = 0
    wins: int = 0
    losses: int = 0
    draws: int = 0


# ── Core Analytics Functions ─────────────────────────────────────────

def compute_set_stats(
    kg: KnowledgeGraph,
    set_obj: SetClass,
    level: int = 100,
) -> SetStats:
    """Compute all 6 stats for a set at the given level."""
    pokemon = kg.get_pokemon(set_obj.pokemon_id)
    if not pokemon:
        return SetStats(set_id=set_obj.id, pokemon_id=set_obj.pokemon_id,
                        set_name=set_obj.set_name, level=level)

    return SetStats(
        set_id=set_obj.id,
        pokemon_id=set_obj.pokemon_id,
        set_name=set_obj.set_name,
        level=level,
        hp=set_obj.effective_stat("hp", pokemon.base_stats, level),
        atk=set_obj.effective_stat("atk", pokemon.base_stats, level),
        def_=set_obj.effective_stat("def", pokemon.base_stats, level),
        spa=set_obj.effective_stat("spa", pokemon.base_stats, level),
        spd=set_obj.effective_stat("spd", pokemon.base_stats, level),
        spe=set_obj.effective_stat("spe", pokemon.base_stats, level),
    )


def compute_all_set_stats(
    kg: KnowledgeGraph,
    level: int = 100,
) -> dict[str, SetStats]:
    """Compute stats for all sets at the given level.

    Returns: dict[set_id -> SetStats]
    """
    result: dict[str, SetStats] = {}
    for s in kg.get_all_sets():
        result[s.id] = compute_set_stats(kg, s, level)
    return result


def aggregate_matchups_by_species(
    kg: KnowledgeGraph,
    set_id: str,
    direction: str = "offense",
    calc: DamageCalculator | None = None,
) -> list[SpeciesMatchup]:
    """Aggregate matchup data per opponent species.

    For each opponent species with multiple sets, picks one representative set.

    Args:
        set_id: The set we're analyzing
        direction: "offense" for best matchups (easiest to beat),
                   "defense" for worst matchups (hardest to beat)
        calc: Optional damage calculator

    Returns: list of SpeciesMatchup, sorted by score (best first for
             "offense", worst first for "defense")
    """
    if calc is None:
        calc = get_calculator()

    our_set = kg.get_set(set_id)
    if not our_set:
        return []

    # Group matchups by opponent species
    species_matchups: dict[str, list[dict]] = {}

    for other in kg.get_all_sets():
        if other.id == set_id or other.pokemon_id == our_set.pokemon_id:
            continue

        mu = kg.get_matchup_between(set_id, other.id)
        if mu is None:
            # Compute on the fly
            from pokeredus.graph.matchup_engine import compute_matchup
            mu = compute_matchup(our_set, other, kg, calc)

        pid = other.pokemon_id
        if pid not in species_matchups:
            species_matchups[pid] = []

        species_matchups[pid].append({
            "set_id": other.id,
            "set_name": other.set_name,
            "score": mu.score,
            "ttk_us_to_them": mu.turns_to_kill_a,
            "ttk_them_to_us": mu.turns_to_kill_b,
            "speed_adv": mu.speed_advantage,
            "best_move_a": mu.best_move_a_id,
            "best_move_b": mu.best_move_b_id,
            "category": mu.category,
            "damage_us_to_them": mu.damage_a_to_b,
            "damage_them_to_us": mu.damage_b_to_a,
            # Damage range fields
            "min_damage_us": mu.min_damage_a_to_b,
            "max_damage_us": mu.max_damage_a_to_b,
            "min_damage_them": mu.min_damage_b_to_a,
            "max_damage_them": mu.max_damage_b_to_a,
            "damage_pct_us_lo": mu.damage_pct_a_to_b_lo,
            "damage_pct_us_hi": mu.damage_pct_a_to_b_hi,
            "damage_pct_them_lo": mu.damage_pct_b_to_a_lo,
            "damage_pct_them_hi": mu.damage_pct_b_to_a_hi,
            "min_ttk_us": mu.min_ttk_a_to_b,
            "max_ttk_us": mu.max_ttk_a_to_b,
            "min_ttk_them": mu.min_ttk_b_to_a,
            "max_ttk_them": mu.max_ttk_b_to_a,
        })

    # Pick representative set per species
    result: list[SpeciesMatchup] = []
    for pid, matchups in species_matchups.items():
        pokemon = kg.get_pokemon(pid)
        pname = pokemon.name if pokemon else pid

        if direction == "offense":
            # Pick the set we beat most easily (highest score for us)
            repr_matchup = max(matchups, key=lambda m: m["score"])
            repr_matchup["is_best"] = True
        else:
            # Pick the set that beats us hardest (lowest score for us)
            repr_matchup = min(matchups, key=lambda m: m["score"])
            repr_matchup["is_worst"] = True

        sa = repr_matchup["speed_adv"]
        speed_label = "us" if sa == "a" else "them" if sa == "b" else "tie"

        # Resolve move names
        move_a = kg.get_move(repr_matchup["best_move_a"])
        move_b = kg.get_move(repr_matchup["best_move_b"])

        result.append(SpeciesMatchup(
            pokemon_id=pid,
            pokemon_name=pname,
            repr_set_id=repr_matchup["set_id"],
            repr_set_name=repr_matchup["set_name"],
            score=repr_matchup["score"],
            turns_to_kill_us=repr_matchup["ttk_them_to_us"],
            turns_to_kill_them=repr_matchup["ttk_us_to_them"],
            speed_advantage=speed_label,
            our_best_move=move_a.name if move_a else repr_matchup["best_move_a"],
            their_best_move=move_b.name if move_b else repr_matchup["best_move_b"],
            category=repr_matchup["category"],
            damage_us_to_them=repr_matchup["damage_us_to_them"],
            damage_them_to_us=repr_matchup["damage_them_to_us"],
            is_best_for_us=repr_matchup.get("is_best", False),
            is_worst_for_us=repr_matchup.get("is_worst", False),
            # Damage range fields
            min_damage_us=repr_matchup["min_damage_us"],
            max_damage_us=repr_matchup["max_damage_us"],
            min_damage_them=repr_matchup["min_damage_them"],
            max_damage_them=repr_matchup["max_damage_them"],
            damage_pct_us_lo=repr_matchup["damage_pct_us_lo"],
            damage_pct_us_hi=repr_matchup["damage_pct_us_hi"],
            damage_pct_them_lo=repr_matchup["damage_pct_them_lo"],
            damage_pct_them_hi=repr_matchup["damage_pct_them_hi"],
            min_ttk_us=repr_matchup["min_ttk_us"],
            max_ttk_us=repr_matchup["max_ttk_us"],
            min_ttk_them=repr_matchup["min_ttk_them"],
            max_ttk_them=repr_matchup["max_ttk_them"],
        ))

    # Sort
    if direction == "offense":
        result.sort(key=lambda m: m.score, reverse=True)  # best first
    else:
        result.sort(key=lambda m: m.score)  # worst first

    return result


def rank_sets(
    kg: KnowledgeGraph,
    calc: DamageCalculator | None = None,
    level: int = 100,
) -> list[SetRanking]:
    """Rank all sets by composite matchup performance (MCTS-style).

    Composite score combines:
    - Win rate (40%): fraction of favorable matchups
    - TTK efficiency (30%): lower mean TTK against = better
    - Speed advantage rate (30%): higher = better

    Returns: list of SetRanking sorted by composite_score (best first)
    """
    if calc is None:
        calc = get_calculator()

    all_sets = kg.get_all_sets()
    rankings: list[SetRanking] = []

    for our_set in all_sets:
        wins = 0
        losses = 0
        draws = 0
        total = 0
        ttks_against: list[int] = []
        ttks_by: list[int] = []
        speed_adv_count = 0
        best_score = -999.0
        worst_score = 999.0
        best_id = ""
        worst_id = ""

        for other in all_sets:
            if other.id == our_set.id or other.pokemon_id == our_set.pokemon_id:
                continue

            mu = kg.get_matchup_between(our_set.id, other.id)
            if mu is None:
                continue

            total += 1
            if mu.score > 0.2:
                wins += 1
            elif mu.score < -0.2:
                losses += 1
            else:
                draws += 1

            if mu.turns_to_kill_a > 0:
                ttks_against.append(mu.turns_to_kill_a)
            if mu.turns_to_kill_b > 0:
                ttks_by.append(mu.turns_to_kill_b)

            if mu.speed_advantage == "a":
                speed_adv_count += 1

            if mu.score > best_score:
                best_score = mu.score
                best_id = other.id
            if mu.score < worst_score:
                worst_score = mu.score
                worst_id = other.id

        if total == 0:
            continue

        win_rate = wins / total
        speed_rate = speed_adv_count / total
        mean_ttk_against = sum(ttks_against) / len(ttks_against) if ttks_against else 10.0
        mean_ttk_by = sum(ttks_by) / len(ttks_by) if ttks_by else 10.0

        # Composite: higher is better
        # Normalize TTK: lower is better, so invert (use 1/TTK or 10-TTK)
        ttk_score = max(0, 1.0 - (mean_ttk_against - 1.0) / 9.0)  # 1 turn → 1.0, 10+ turns → 0.0
        ttk_survival = max(0, (mean_ttk_by - 1.0) / 9.0)  # 10 turns to die → 1.0, 1 turn → 0.0

        composite = (
            win_rate * 0.35 +
            ttk_score * 0.25 +
            ttk_survival * 0.15 +
            speed_rate * 0.25
        )

        best_set = kg.get_set(best_id)
        worst_set = kg.get_set(worst_id)

        rankings.append(SetRanking(
            set_id=our_set.id,
            pokemon_id=our_set.pokemon_id,
            set_name=our_set.set_name,
            win_rate=round(win_rate, 4),
            mean_ttk_against=round(mean_ttk_against, 2),
            mean_ttk_by=round(mean_ttk_by, 2),
            speed_advantage_rate=round(speed_rate, 4),
            composite_score=round(composite, 4),
            best_matchup=best_id,
            worst_matchup=worst_id,
            total_matchups=total,
            wins=wins,
            losses=losses,
            draws=draws,
        ))

    rankings.sort(key=lambda r: r.composite_score, reverse=True)
    return rankings


def get_best_set_per_species(
    kg: KnowledgeGraph,
    calc: DamageCalculator | None = None,
    level: int = 100,
) -> dict[str, str]:
    """For each species, find the set with the highest composite score.

    Returns: dict[pokemon_id -> set_id]
    """
    rankings = rank_sets(kg, calc, level)
    best: dict[str, str] = {}
    for r in rankings:
        if r.pokemon_id not in best:
            best[r.pokemon_id] = r.set_id
    return best


def matchup_matrix(
    kg: KnowledgeGraph,
    set_ids_a: list[str],
    set_ids_b: list[str],
) -> list[list[float]]:
    """Compute a matchup score matrix between two lists of sets.

    Returns: matrix[a_idx][b_idx] = score (positive favors A)
    """
    matrix: list[list[float]] = []
    for sid_a in set_ids_a:
        row: list[float] = []
        for sid_b in set_ids_b:
            mu = kg.get_matchup_between(sid_a, sid_b)
            row.append(mu.score if mu else 0.0)
        matrix.append(row)
    return matrix
