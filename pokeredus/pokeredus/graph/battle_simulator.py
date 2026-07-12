"""
Battle simulator for MCTS-style matchup analysis.

Core design:
- A Pokémon species is represented by its **OptimalProfile** — best stats
  and complete move pool across ALL sets.
- Damage rolls are probabilistic (0.85–1.0 random factor, 16 discrete rolls).
- All viable attacking moves are evaluated and weighted by viability.
- Attribute modifiers from items/abilities/moves are integrated.
- Scores are decimal and scalable to multi-Pokémon matchups.

Turn model:
- Each turn both Pokémon act.
- Faster Pokémon (or higher priority move) goes first.
- Dead Pokémon cannot act.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Optional
import math

if TYPE_CHECKING:
    from pokeredus.classes import SetClass, MoveClass, PokemonClass
    from pokeredus.graph.damage_calc import DamageCalculator, DamageResult


# ── Species Profile ──────────────────────────────────────────────────


@dataclass
class SpeciesProfile:
    """Optimal profile for a species across all its sets.

    Aggregates the best offensive stats, defensive stats, speed, and
    the full union of moves from every set.
    """
    pokemon_id: str
    pokemon_name: str

    # Best stats across all sets (at level 100)
    max_hp: int = 0
    best_atk: int = 0
    best_def: int = 0
    best_spa: int = 0
    best_spd: int = 0
    best_spe: int = 0

    # Sources: which set provided the best value for each stat
    hp_set_id: str = ""
    atk_set_id: str = ""
    def_set_id: str = ""
    spa_set_id: str = ""
    spd_set_id: str = ""
    spe_set_id: str = ""

    # Union of all moves across all sets
    all_move_ids: list[str] = field(default_factory=list)

    # Items and abilities seen across sets (for attribute lookup)
    items: list[str] = field(default_factory=list)
    abilities: list[str] = field(default_factory=list)

    # The primary/star set id (used as the "base" for damage calc)
    primary_set_id: str = ""

    @property
    def bst(self) -> int:
        return self.max_hp + self.best_atk + self.best_def + self.best_spa + self.best_spd + self.best_spe


def build_species_profile(
    pokemon_id: str,
    kg,
    calc: DamageCalculator,
    level: int = 100,
) -> SpeciesProfile:
    """Build a SpeciesProfile by aggregating all sets for a species."""
    pokemon = kg.get_pokemon(pokemon_id)
    if not pokemon:
        return SpeciesProfile(pokemon_id=pokemon_id, pokemon_name=pokemon_id)

    sets = kg.get_sets(pokemon_id)
    if not sets:
        return SpeciesProfile(
            pokemon_id=pokemon_id,
            pokemon_name=pokemon.name,
        )

    profile = SpeciesProfile(
        pokemon_id=pokemon_id,
        pokemon_name=pokemon.name,
        primary_set_id=pokemon.primary_set_id or (sets[0].id if sets else ""),
    )

    # Collect items and abilities
    items_seen = set()
    abilities_seen = set()
    moves_seen = []
    moves_ids_seen = set()

    for s in sets:
        if s.item:
            items_seen.add(s.item)
        if s.ability:
            abilities_seen.add(s.ability)
        for mid in s.moves:
            if mid not in moves_ids_seen:
                moves_ids_seen.add(mid)
                moves_seen.append(mid)

    profile.items = sorted(items_seen)
    profile.abilities = sorted(abilities_seen)
    profile.all_move_ids = moves_seen

    # Find best stat from each slot across all sets
    best = {
        'hp': (0, ""), 'atk': (0, ""), 'def': (0, ""),
        'spa': (0, ""), 'spd': (0, ""), 'spe': (0, ""),
    }
    for s in sets:
        for stat in best:
            val = s.effective_stat(stat, pokemon.base_stats, level)
            if val > best[stat][0]:
                best[stat] = (val, s.id)

    profile.max_hp = best['hp'][0]
    profile.best_atk = best['atk'][0]
    profile.best_def = best['def'][0]
    profile.best_spa = best['spa'][0]
    profile.best_spd = best['spd'][0]
    profile.best_spe = best['spe'][0]
    profile.hp_set_id = best['hp'][1]
    profile.atk_set_id = best['atk'][1]
    profile.def_set_id = best['def'][1]
    profile.spa_set_id = best['spa'][1]
    profile.spd_set_id = best['spd'][1]
    profile.spe_set_id = best['spe'][1]

    return profile


# ── Move Evaluation ──────────────────────────────────────────────────


@dataclass
class MoveEvaluation:
    """Evaluation of a single move in a matchup context."""
    move_id: str
    move_name: str
    move_type: str
    move_category: str  # "Physical" or "Special"
    base_power: int
    priority: int

    # Damage range (16 rolls from 0.85 to 1.0)
    min_damage: int       # worst roll
    max_damage: int       # best roll
    avg_damage: float     # average across all 16 rolls

    # TTK range
    min_ttk: int          # best-case turns to kill (fewest)
    max_ttk: int          # worst-case turns to kill (most)
    avg_ttk: float        # average TTK

    # Type effectiveness
    type_effectiveness: float
    stab: bool
    is_immune: bool

    # Viability weight (0.0–1.0): how good this move is relative to the best
    weight: float = 0.0

    @property
    def damage_pct_min(self) -> float:
        return self.min_damage  # stored as raw, caller divides by HP

    @property
    def damage_pct_max(self) -> float:
        return self.max_damage


@dataclass
class SpeciesMatchupResult:
    """Full matchup result between two species profiles."""

    our_id: str
    their_id: str
    our_name: str
    their_name: str

    # Per-move evaluations
    our_moves: list[MoveEvaluation] = field(default_factory=list)
    their_moves: list[MoveEvaluation] = field(default_factory=list)

    # Weighted aggregate: effective average TTK considering all move options
    our_effective_ttk: float = 0.0   # avg turns for us to kill them
    their_effective_ttk: float = 0.0 # avg turns for them to kill us

    # Best moves (highest weighted)
    our_best_move: str = ""
    their_best_move: str = ""
    our_best_damage: int = 0
    their_best_damage: int = 0
    our_best_damage_max: int = 0
    their_best_damage_max: int = 0

    # Speed comparison (using best speed + speed modifiers)
    our_speed: int = 0
    their_speed: int = 0
    speed_advantage: str = "tie"  # 'us', 'them', 'tie'

    # HP
    our_hp: int = 0
    their_hp: int = 0

    # MCTS score: -1.0 (total loss) to +1.0 (total win), decimal
    score: float = 0.0
    category: str = "neutral"
    eval_text: str = ""

    @property
    def our_hp_pct(self) -> float:
        return 100.0  # at start of battle

    @property
    def their_hp_pct(self) -> float:
        return 100.0

    # Backward compat for GUI
    @property
    def turns_to_kill_them(self) -> int:
        return int(round(self.our_effective_ttk)) if self.our_effective_ttk > 0 else 0

    @property
    def turns_to_kill_us(self) -> int:
        return int(round(self.their_effective_ttk)) if self.their_effective_ttk > 0 else 0

    @property
    def our_damage(self) -> int:
        return self.our_best_damage

    @property
    def their_damage(self) -> int:
        return self.their_best_damage

    @property
    def our_final_hp(self) -> int:
        return self.our_hp

    @property
    def their_final_hp(self) -> int:
        return self.their_hp

    @property
    def our_max_hp(self) -> int:
        return self.our_hp

    @property
    def their_max_hp(self) -> int:
        return self.their_hp

    @property
    def our_wins(self) -> bool:
        return self.score > 0

    @property
    def our_effective_speed(self) -> int:
        return self.our_speed

    @property
    def their_effective_speed(self) -> int:
        return self.their_speed


# ── Battle Simulator ─────────────────────────────────────────────────


# The 16 discrete damage rolls in Pokémon (0.85 to 1.0)
DAMAGE_ROLLS = [0.85, 0.86, 0.87, 0.88, 0.89, 0.90, 0.91, 0.92,
                0.93, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 1.00]


class BattleSimulator:
    """Simulates matchups between species using optimal profiles.

    Key improvements over the old single-set simulator:
    1. Uses SpeciesProfile (best stats + all moves across sets)
    2. Evaluates all damaging moves with full roll distribution
    3. Weights moves by viability to produce effective TTK
    4. Integrates attribute modifiers from items/abilities
    5. Scalable to team-level matchups
    """

    def __init__(self, calc: DamageCalculator, kg, attribute_manager=None):
        self.calc = calc
        self.kg = kg
        self.attribute_manager = attribute_manager
        self._profile_cache: dict[str, SpeciesProfile] = {}

    def get_profile(self, pokemon_id: str) -> SpeciesProfile:
        """Get or build a species profile (cached)."""
        if pokemon_id not in self._profile_cache:
            self._profile_cache[pokemon_id] = build_species_profile(
                pokemon_id, self.kg, self.calc
            )
        return self._profile_cache[pokemon_id]

    def clear_cache(self):
        """Clear the profile cache (e.g., after sets change)."""
        self._profile_cache.clear()

    def _get_attribute_modifiers(self, profile: SpeciesProfile) -> dict:
        """Collect attribute modifiers from items/abilities for a profile.

        Returns a dict with keys: damage_mult, speed_mult, atk_mult, etc.
        """
        mods = {
            'damage_mult': 1.0,
            'physical_mult': 1.0,
            'special_mult': 1.0,
            'speed_mult': 1.0,
            'defense_mult': 1.0,
            'spdef_mult': 1.0,
        }

        if not self.attribute_manager:
            return mods

        # Collect from items
        for item_id in profile.items:
            attrs = self.attribute_manager.get_item_attributes(item_id)
            for attr in attrs:
                self._apply_attribute(attr, mods)

        # Collect from abilities
        for ability_id in profile.abilities:
            attrs = self.attribute_manager.get_ability_attributes(ability_id)
            for attr in attrs:
                self._apply_attribute(attr, mods)

        return mods

    def _apply_attribute(self, attr, mods: dict):
        """Apply a single attribute definition to the modifier dict."""
        if not hasattr(attr, 'params') or not attr.params:
            return

        atype = getattr(attr, 'type', '')
        params = attr.params

        if atype == 'damage_mod':
            mult = params.get('multiplier', 1.0)
            applies_to = params.get('applies_to', 'all')
            target = params.get('target', 'attacker')
            if target == 'defender':
                # Defensive items reduce incoming damage
                if applies_to == 'all':
                    mods['defense_mult'] *= (1.0 / mult) if mult > 1 else mult
                elif applies_to == 'special':
                    mods['spdef_mult'] *= (1.0 / mult) if mult > 1 else mult
            else:
                # Offensive items boost outgoing damage
                if applies_to == 'all':
                    mods['damage_mult'] *= mult
                elif applies_to == 'physical':
                    mods['physical_mult'] *= mult
                elif applies_to == 'special':
                    mods['special_mult'] *= mult

        elif atype == 'speed_mod':
            mult = params.get('multiplier', 1.0)
            # Only apply unconditional speed mods (no weather condition check here)
            condition = params.get('condition', '')
            if not condition:
                mods['speed_mult'] *= mult

        elif atype == 'stat_mod':
            stat = params.get('stat', '')
            stages = params.get('stages', 0)
            if stages >= 0:
                mult = (2 + stages) / 2
            else:
                mult = 2 / (2 - stages)
            target = params.get('target', 'self')
            if target == 'self':
                if stat == 'atk':
                    mods['physical_mult'] *= mult
                elif stat == 'spa':
                    mods['special_mult'] *= mult
                elif stat == 'spe':
                    mods['speed_mult'] *= mult

    def _evaluate_move(
        self,
        move_id: str,
        attacker_profile: SpeciesProfile,
        defender_profile: SpeciesProfile,
        attacker_mods: dict,
        defender_mods: dict,
    ) -> Optional[MoveEvaluation]:
        """Evaluate a single move's damage against a defender profile.

        Uses the primary set for the damage calc base, then applies
        optimal stat overrides and attribute modifiers.
        """
        move = self.kg.get_move(move_id)
        if not move or move.is_status:
            return None

        # Get the primary set for damage calc
        attacker_set = self.kg.get_set(attacker_profile.primary_set_id)
        defender_set = self.kg.get_set(defender_profile.primary_set_id)

        if not attacker_set or not defender_set:
            return None

        attacker_pokemon = self.kg.get_pokemon(attacker_profile.pokemon_id)
        defender_pokemon = self.kg.get_pokemon(defender_profile.pokemon_id)

        if not attacker_pokemon or not defender_pokemon:
            return None

        # Base damage calculation using the standard formula
        # but with optimal stats from the profile
        is_physical = move.is_physical
        level = self.calc.level

        # Offensive stat: use best from profile
        if is_physical:
            off_stat = attacker_profile.best_atk
            off_stat *= attacker_mods.get('physical_mult', 1.0)
        else:
            off_stat = attacker_profile.best_spa
            off_stat *= attacker_mods.get('special_mult', 1.0)

        # Defensive stat: use best from profile
        if is_physical:
            def_stat = defender_profile.best_def
            def_stat *= defender_mods.get('defense_mult', 1.0)
        else:
            def_stat = defender_profile.best_spd
            def_stat *= defender_mods.get('spdef_mult', 1.0)

        off_stat = max(1, int(off_stat))
        def_stat = max(1, int(def_stat))

        # Type effectiveness
        type_eff = 1.0
        if hasattr(move, 'type') and move.type:
            from pokeredus.classes.types import get_effectiveness
            type_eff = get_effectiveness(move.type, defender_pokemon.types)

        if type_eff == 0:
            return MoveEvaluation(
                move_id=move_id,
                move_name=move.name,
                move_type=getattr(move, 'type', ''),
                move_category=move.category,
                base_power=move.base_power,
                priority=getattr(move, 'priority', 0),
                min_damage=0, max_damage=0, avg_damage=0,
                min_ttk=0, max_ttk=0, avg_ttk=0,
                type_effectiveness=0, stab=False, is_immune=True,
            )

        # STAB
        stab = move.type in attacker_pokemon.types if hasattr(move, 'type') else False
        stab_mult = 1.5 if stab else 1.0

        # Base power
        power = max(1, move.base_power)

        # Base damage formula
        base_dmg = math.floor(
            ((2 * level / 5 + 2) * power * off_stat / def_stat) / 50 + 2
        )

        # Apply item damage modifier
        item_mult = attacker_mods.get('damage_mult', 1.0)

        # Full damage before roll
        full_dmg = base_dmg * stab_mult * type_eff * item_mult

        # 16 discrete rolls
        defender_hp = defender_profile.max_hp
        rolls = []
        for roll_factor in DAMAGE_ROLLS:
            dmg = max(1, math.floor(full_dmg * roll_factor))
            rolls.append(dmg)

        min_dmg = min(rolls)
        max_dmg = max(rolls)
        avg_dmg = sum(rolls) / len(rolls)

        # TTK for each roll
        ttks = []
        for dmg in rolls:
            if dmg <= 0:
                ttks.append(0)
            else:
                ttks.append(math.ceil(defender_hp / dmg))

        min_ttk = min(ttks) if ttks else 0
        max_ttk = max(ttks) if ttks else 0
        avg_ttk = sum(ttks) / len(ttks) if ttks else 0

        return MoveEvaluation(
            move_id=move_id,
            move_name=move.name,
            move_type=getattr(move, 'type', ''),
            move_category=move.category,
            base_power=power,
            priority=getattr(move, 'priority', 0),
            min_damage=min_dmg,
            max_damage=max_dmg,
            avg_damage=avg_dmg,
            min_ttk=min_ttk,
            max_ttk=max_ttk,
            avg_ttk=avg_ttk,
            type_effectiveness=type_eff,
            stab=stab,
            is_immune=False,
        )

    def _compute_move_weights(self, moves: list[MoveEvaluation], defender_hp: int) -> list[MoveEvaluation]:
        """Assign viability weights to each move based on effectiveness.

        Weight is based on average damage as % of defender HP and TTK.
        Best move gets weight 1.0, others are proportional.
        Immune moves get weight 0.
        """
        if not moves:
            return moves

        # Filter out immune moves
        viable = [m for m in moves if not m.is_immune and m.avg_ttk > 0]

        if not viable:
            for m in moves:
                m.weight = 0.0
            return moves

        # Score each move: lower avg_ttk is better, higher avg damage is better
        # Use inverse TTK as the raw score
        best_inv_ttk = 0
        for m in viable:
            inv_ttk = 1.0 / m.avg_ttk if m.avg_ttk > 0 else 0
            if inv_ttk > best_inv_ttk:
                best_inv_ttk = inv_ttk

        for m in moves:
            if m.is_immune or m.avg_ttk <= 0:
                m.weight = 0.0
            elif best_inv_ttk > 0:
                inv_ttk = 1.0 / m.avg_ttk
                m.weight = inv_ttk / best_inv_ttk
            else:
                m.weight = 0.0

        return moves

    def simulate(
        self,
        our_profile: SpeciesProfile,
        their_profile: SpeciesProfile,
    ) -> SpeciesMatchupResult:
        """Simulate a full matchup between two species profiles.

        Evaluates all moves from both sides, computes weighted TTK,
        and produces a decimal MCTS score.
        """
        result = SpeciesMatchupResult(
            our_id=our_profile.pokemon_id,
            their_id=their_profile.pokemon_id,
            our_name=our_profile.pokemon_name,
            their_name=their_profile.pokemon_name,
            our_hp=our_profile.max_hp,
            their_hp=their_profile.max_hp,
        )

        # Get attribute modifiers
        our_mods = self._get_attribute_modifiers(our_profile)
        their_mods = self._get_attribute_modifiers(their_profile)

        # Evaluate all our moves against them
        our_move_evals = []
        for mid in our_profile.all_move_ids:
            ev = self._evaluate_move(mid, our_profile, their_profile, our_mods, their_mods)
            if ev:
                our_move_evals.append(ev)

        # Evaluate all their moves against us
        their_move_evals = []
        for mid in their_profile.all_move_ids:
            ev = self._evaluate_move(mid, their_profile, our_profile, their_mods, our_mods)
            if ev:
                their_move_evals.append(ev)

        # Compute move weights
        our_move_evals = self._compute_move_weights(our_move_evals, their_profile.max_hp)
        their_move_evals = self._compute_move_weights(their_move_evals, our_profile.max_hp)

        result.our_moves = our_move_evals
        result.their_moves = their_move_evals

        # Weighted effective TTK
        result.our_effective_ttk = self._weighted_ttk(our_move_evals)
        result.their_effective_ttk = self._weighted_ttk(their_move_evals)

        # Best moves
        our_viable = [m for m in our_move_evals if not m.is_immune and m.avg_ttk > 0]
        their_viable = [m for m in their_move_evals if not m.is_immune and m.avg_ttk > 0]

        if our_viable:
            best_our = min(our_viable, key=lambda m: m.avg_ttk)
            result.our_best_move = best_our.move_name
            result.our_best_damage = best_our.min_damage
            result.our_best_damage_max = best_our.max_damage
        else:
            result.our_best_move = "None"

        if their_viable:
            best_their = min(their_viable, key=lambda m: m.avg_ttk)
            result.their_best_move = best_their.move_name
            result.their_best_damage = best_their.min_damage
            result.their_best_damage_max = best_their.max_damage
        else:
            result.their_best_move = "None"

        # Speed comparison (with attribute modifiers)
        result.our_speed = int(our_profile.best_spe * our_mods.get('speed_mult', 1.0))
        result.their_speed = int(their_profile.best_spe * their_mods.get('speed_mult', 1.0))

        if result.our_speed > result.their_speed:
            result.speed_advantage = 'us'
        elif result.their_speed > result.our_speed:
            result.speed_advantage = 'them'
        else:
            result.speed_advantage = 'tie'

        # Compute MCTS score
        result.score = self._compute_score(result)
        result.category = self._categorize(result.score)
        result.eval_text = self._generate_eval_text(result)

        return result

    def simulate_by_id(self, our_pokemon_id: str, their_pokemon_id: str) -> SpeciesMatchupResult:
        """Convenience: simulate matchup by pokemon IDs."""
        our_profile = self.get_profile(our_pokemon_id)
        their_profile = self.get_profile(their_pokemon_id)
        return self.simulate(our_profile, their_profile)

    def _weighted_ttk(self, moves: list[MoveEvaluation]) -> float:
        """Compute weighted average TTK across all viable moves.

        Uses move weights to produce an effective TTK that accounts
        for the fact that a Pokémon can choose any of its moves.
        """
        viable = [m for m in moves if not m.is_immune and m.avg_ttk > 0 and m.weight > 0]
        if not viable:
            return 0.0

        total_weight = sum(m.weight for m in viable)
        if total_weight <= 0:
            return 0.0

        # Weighted average of avg_ttk
        weighted_sum = sum(m.avg_ttk * m.weight for m in viable)
        return weighted_sum / total_weight

    def _compute_score(self, result: SpeciesMatchupResult) -> float:
        """Compute MCTS score from the matchup result.

        Formula components:
        1. TTK differential (primary signal)
        2. Speed advantage (tiebreaker / priority consideration)
        3. Move pool depth (more viable moves = more flexibility)
        4. Damage roll variance (consistent damage > volatile damage)

        Returns a decimal value in [-1.0, +1.0].
        """
        our_ttk = result.our_effective_ttk
        their_ttk = result.their_effective_ttk

        # Hard cases: one side can't kill
        if our_ttk <= 0 and their_ttk <= 0:
            return 0.0  # mutual wall
        if our_ttk <= 0 and their_ttk > 0:
            return -1.0  # we can't kill, they can
        if our_ttk > 0 and their_ttk <= 0:
            return 1.0   # we can kill, they can't

        # TTK differential: positive = we kill faster
        ttk_diff = their_ttk - our_ttk

        # Primary score: tanh normalization of TTK diff
        # Scaling factor 2.5 means ±2.5 TTK diff ≈ ±0.76 score
        base_score = math.tanh(ttk_diff / 2.5)

        # Speed advantage modifier
        # If TTK is close, speed matters more (who strikes first)
        speed_bonus = 0.0
        if abs(ttk_diff) < 1.5:
            if result.speed_advantage == 'us':
                speed_bonus = 0.12
            elif result.speed_advantage == 'them':
                speed_bonus = -0.12

        # Move pool depth bonus (flexibility)
        our_viable = len([m for m in result.our_moves if not m.is_immune and m.avg_ttk > 0])
        their_viable = len([m for m in result.their_moves if not m.is_immune and m.avg_ttk > 0])
        depth_bonus = 0.0
        if our_viable > their_viable + 1:
            depth_bonus = 0.05
        elif their_viable > our_viable + 1:
            depth_bonus = -0.05

        # Priority move consideration
        our_has_priority = any(m.priority > 0 for m in result.our_moves if not m.is_immune)
        their_has_priority = any(m.priority > 0 for m in result.their_moves if not m.is_immune)
        priority_bonus = 0.0
        if our_has_priority and not their_has_priority:
            priority_bonus = 0.08
        elif their_has_priority and not our_has_priority:
            priority_bonus = -0.08

        score = base_score + speed_bonus + depth_bonus + priority_bonus
        return max(-1.0, min(1.0, score))

    def _categorize(self, score: float) -> str:
        """Categorize matchup based on score."""
        if score >= 0.6:
            return 'counter'
        elif score >= 0.2:
            return 'check'
        elif score >= -0.2:
            return 'neutral'
        elif score >= -0.6:
            return 'checked_by'
        else:
            return 'countered_by'

    def _generate_eval_text(self, result: SpeciesMatchupResult) -> str:
        """Generate human-readable evaluation text."""
        parts = []

        # TTK comparison
        if result.our_effective_ttk > 0:
            parts.append(f"~{result.our_effective_ttk:.1f} turns to KO them")
        else:
            parts.append("Cannot KO them")

        if result.their_effective_ttk > 0:
            parts.append(f"~{result.their_effective_ttk:.1f} turns to KO us")
        else:
            parts.append("They cannot KO us")

        # Best moves
        if result.our_best_move and result.our_best_move != "None":
            our_viable = [m for m in result.our_moves if not m.is_immune and m.avg_ttk > 0]
            best = min(our_viable, key=lambda m: m.avg_ttk) if our_viable else None
            if best:
                pct_lo = best.min_damage / result.their_hp * 100 if result.their_hp > 0 else 0
                pct_hi = best.max_damage / result.their_hp * 100 if result.their_hp > 0 else 0
                parts.append(f"Best: {best.move_name} ({pct_lo:.0f}-{pct_hi:.0f}%)")

        # Speed
        if result.speed_advantage == 'us':
            parts.append(f"Faster ({result.our_speed} vs {result.their_speed})")
        elif result.speed_advantage == 'them':
            parts.append(f"Slower ({result.our_speed} vs {result.their_speed})")

        # Move count
        our_viable = len([m for m in result.our_moves if not m.is_immune and m.avg_ttk > 0])
        their_viable = len([m for m in result.their_moves if not m.is_immune and m.avg_ttk > 0])
        if our_viable > 1:
            parts.append(f"{our_viable} viable moves")

        return " | ".join(parts)


# Backward compatibility: BattleOutcome alias
BattleOutcome = SpeciesMatchupResult
