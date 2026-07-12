"""
damage_calc — Pokémon damage calculator with pluggable modifier system.

Implements the standard Gen 9 damage formula:
    Base = floor(((2*Level/5 + 2) * Power * A / D) / 50 + 2)
    Final = floor(Base * STAB * TypeEff * ModifierProduct)

Modifiers (items, abilities, weather, etc.) are registered as DamageModifier
instances. This makes it trivial to add new item/ability effects later:
    calc.register_modifier(ChoiceBandModifier())
    calc.register_modifier(LifeOrbModifier())

Usage:
    calc = DamageCalculator()
    result = calc.calculate(attacker_set, defender_set, move, kg)
    ttk = calc.turns_to_kill(attacker_set, defender_set, kg)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from pokeredus.classes.types import get_effectiveness

if TYPE_CHECKING:
    from pokeredus.classes import (
        SetClass, MoveClass, PokemonClass, KnowledgeGraph,
    )


# ── Damage Result ────────────────────────────────────────────────────

@dataclass
class DamageResult:
    """Result of a single damage calculation."""

    move_id: str
    move_name: str
    move_type: str
    move_category: str
    base_power: int
    offensive_stat: int        # A (attacker's Atk or SpA after modifiers)
    defensive_stat: int        # D (defender's Def or SpD after modifiers)
    base_damage: int           # before multipliers
    stab_mult: float           # 1.0 or 1.5
    type_effectiveness: float  # from type chart
    modifier_product: float    # product of all registered modifiers
    final_damage: int          # after all multipliers
    effective_hp: int          # defender's total HP
    turns_to_kill: int         # ceil(HP / final_damage)
    is_ohko: bool = False
    is_immune: bool = False    # type immunity (0x effectiveness)
    is_contact: bool = False
    hit_count: int = 1         # for multi-hit moves
    min_damage: int = 0        # worst-case roll (×0.85)
    max_damage: int = 0        # best-case roll  (×1.00)
    min_turns_to_kill: int = 0 # ceil(HP / max_damage) — fewest turns
    max_turns_to_kill: int = 0 # ceil(HP / min_damage) — most turns

    @property
    def damage_percent(self) -> float:
        """Damage as a percentage of defender's HP."""
        if self.effective_hp <= 0:
            return 0.0
        return (self.final_damage / self.effective_hp) * 100.0

    @property
    def min_damage_percent(self) -> float:
        """Worst-case damage as a percentage of defender's HP."""
        if self.effective_hp <= 0:
            return 0.0
        return (self.min_damage / self.effective_hp) * 100.0

    @property
    def max_damage_percent(self) -> float:
        """Best-case damage as a percentage of defender's HP."""
        if self.effective_hp <= 0:
            return 0.0
        return (self.max_damage / self.effective_hp) * 100.0

    @property
    def damage_range_str(self) -> str:
        """Human-readable damage range like '45.2 – 53.1%'."""
        if self.effective_hp <= 0 or self.min_damage <= 0:
            return "—"
        lo = self.min_damage_percent
        hi = self.max_damage_percent
        if abs(lo - hi) < 0.5:
            return f"{hi:.1f}%"
        return f"{lo:.1f} – {hi:.1f}%"

    @property
    def ttk_range_str(self) -> str:
        """Human-readable TTK range like '2-3HKO'."""
        if self.min_turns_to_kill <= 0:
            return "—"
        if self.min_turns_to_kill == self.max_turns_to_kill:
            return f"{self.min_turns_to_kill}HKO"
        return f"{self.min_turns_to_kill}-{self.max_turns_to_kill}HKO"


# ── Modifier System ──────────────────────────────────────────────────

class DamageModifierContext:
    """Context passed to modifiers during damage calculation."""

    def __init__(
        self,
        attacker_set: SetClass,
        defender_set: SetClass,
        attacker_pokemon: PokemonClass,
        defender_pokemon: PokemonClass,
        move: MoveClass,
        kg: KnowledgeGraph,
        level: int = 100,
    ):
        self.attacker_set = attacker_set
        self.defender_set = defender_set
        self.attacker_pokemon = attacker_pokemon
        self.defender_pokemon = defender_pokemon
        self.move = move
        self.kg = kg
        self.level = level


class DamageModifier:
    """Base class for damage modifiers (items, abilities, weather, etc.).

    Subclass this and override methods to implement specific effects.
    Register instances with DamageCalculator.register_modifier().

    Methods return the modified value. Order is controlled by `priority`
    (lower runs first).
    """

    name: str = "unnamed"
    priority: int = 100

    def modify_offense(
        self, stat_value: float, context: DamageModifierContext
    ) -> float:
        """Modify the attacker's offensive stat (Atk or SpA).

        Example: Choice Band multiplies Atk by 1.5.
        """
        return stat_value

    def modify_defense(
        self, stat_value: float, context: DamageModifierContext
    ) -> float:
        """Modify the defender's defensive stat (Def or SpD).

        Example: Chip Away ignores defense boosts.
        """
        return stat_value

    def modify_damage(
        self, base_damage: float, context: DamageModifierContext
    ) -> float:
        """Modify the final damage after base calculation.

        Example: Life Orb multiplies by 1.3.
        """
        return base_damage

    def modify_type_effectiveness(
        self, effectiveness: float, context: DamageModifierContext
    ) -> float:
        """Modify type effectiveness.

        Example: Tinted Lens doubles not-very-effective moves (0.5 → 1.0).
        """
        return effectiveness

    def modify_stab(self, stab: float, context: DamageModifierContext) -> float:
        """Modify STAB multiplier.

        Example: Adaptability makes STAB 2.0 instead of 1.5.
        """
        return stab

    def should_skip(self, context: DamageModifierContext) -> bool:
        """Return True to skip this move entirely (e.g., ability immunity).

        Example: Levitate makes Ground moves deal 0 damage.
        """
        return False


# ── Built-in Modifier Examples ───────────────────────────────────────
# These are placeholders showing how items/abilities would plug in.
# The user can add more by subclassing DamageModifier.

class ChoiceBandModifier(DamageModifier):
    """Choice Band: Physical moves deal 1.5x damage."""
    name = "choiceband"
    priority = 50

    def modify_offense(self, stat_value, context):
        if context.move.is_physical and context.attacker_set.item == "choiceband":
            return stat_value * 1.5
        return stat_value


class ChoiceSpecsModifier(DamageModifier):
    """Choice Specs: Special moves deal 1.5x damage."""
    name = "choicespecs"
    priority = 50

    def modify_offense(self, stat_value, context):
        if context.move.is_special and context.attacker_set.item == "choicespecs":
            return stat_value * 1.5
        return stat_value


class LifeOrbModifier(DamageModifier):
    """Life Orb: All moves deal 1.3x damage."""
    name = "lifeorb"
    priority = 80

    def modify_damage(self, base_damage, context):
        if context.attacker_set.item == "lifeorb":
            return base_damage * 1.3
        return base_damage


class EvioliteModifier(DamageModifier):
    """Eviolite: Boosts Def and SpD by 1.5x for NFE Pokémon."""
    name = "eviolite"
    priority = 50

    def modify_defense(self, stat_value, context):
        if context.defender_set.item == "eviolite":
            return stat_value * 1.5
        return stat_value


class AssaultVestModifier(DamageModifier):
    """Assault Vest: Boosts SpD by 1.5x."""
    name = "assaultvest"
    priority = 50

    def modify_defense(self, stat_value, context):
        if context.defender_set.item == "assaultvest" and context.move.is_special:
            return stat_value * 1.5
        return stat_value


# ── Damage Calculator ────────────────────────────────────────────────

class DamageCalculator:
    """Pokémon damage calculator with pluggable modifier system.

    Usage:
        calc = DamageCalculator()
        # Optionally register modifiers
        calc.register_modifier(LifeOrbModifier())
        result = calc.calculate(attacker_set, defender_set, move, kg)
        ttk = calc.turns_to_kill(attacker_set, defender_set, kg)
    """

    def __init__(self) -> None:
        self._modifiers: list[DamageModifier] = []
        self.level: int = 100  # default competitive level

    def register_modifier(self, modifier: DamageModifier) -> None:
        """Register a damage modifier. Modifiers are sorted by priority."""
        self._modifiers.append(modifier)
        self._modifiers.sort(key=lambda m: m.priority)

    def remove_modifier(self, name: str) -> None:
        """Remove a modifier by name."""
        self._modifiers = [m for m in self._modifiers if m.name != name]

    def clear_modifiers(self) -> None:
        """Remove all modifiers."""
        self._modifiers.clear()

    def _get_modifiers(self) -> list[DamageModifier]:
        return self._modifiers

    # ── Core Calculation ─────────────────────────────────────────────

    def calculate(
        self,
        attacker_set: SetClass,
        defender_set: SetClass,
        move: MoveClass,
        kg: KnowledgeGraph,
        level: int | None = None,
    ) -> DamageResult:
        """Calculate damage for one move.

        Returns a DamageResult with all intermediate values.
        """
        level = level or self.level
        attacker_pokemon = kg.get_pokemon(attacker_set.pokemon_id)
        defender_pokemon = kg.get_pokemon(defender_set.pokemon_id)

        if not attacker_pokemon or not defender_pokemon:
            return self._empty_result(move, defender_set, attacker_pokemon, kg, level)

        # Build modifier context
        ctx = DamageModifierContext(
            attacker_set, defender_set,
            attacker_pokemon, defender_pokemon,
            move, kg, level,
        )

        # Check if any modifier says to skip
        for mod in self._get_modifiers():
            if mod.should_skip(ctx):
                return DamageResult(
                    move_id=move.id, move_name=move.name,
                    move_type=move.type, move_category=move.category,
                    base_power=0, offensive_stat=0, defensive_stat=0,
                    base_damage=0, stab_mult=1.0, type_effectiveness=0.0,
                    modifier_product=1.0, final_damage=0,
                    effective_hp=0, turns_to_kill=0,
                    is_immune=True, is_contact=move.is_contact,
                )

        # Status moves don't deal damage
        if move.is_status:
            return DamageResult(
                move_id=move.id, move_name=move.name,
                move_type=move.type, move_category=move.category,
                base_power=0, offensive_stat=0, defensive_stat=0,
                base_damage=0, stab_mult=1.0, type_effectiveness=1.0,
                modifier_product=1.0, final_damage=0,
                effective_hp=self._compute_hp(defender_pokemon, defender_set, level),
                turns_to_kill=0, is_contact=move.is_contact,
            )

        # ── Offensive stat ───────────────────────────────────────────
        if move.is_physical:
            off_stat = attacker_set.effective_stat("atk", attacker_pokemon.base_stats, level)
        else:
            off_stat = attacker_set.effective_stat("spa", attacker_pokemon.base_stats, level)

        # Apply offensive modifiers
        for mod in self._get_modifiers():
            off_stat = mod.modify_offense(float(off_stat), ctx)
        off_stat = max(1, int(off_stat))

        # ── Defensive stat ───────────────────────────────────────────
        if move.is_physical:
            def_stat = defender_set.effective_stat("def", defender_pokemon.base_stats, level)
        else:
            def_stat = defender_set.effective_stat("spd", defender_pokemon.base_stats, level)

        # Apply defensive modifiers
        for mod in self._get_modifiers():
            def_stat = mod.modify_defense(float(def_stat), ctx)
        def_stat = max(1, int(def_stat))

        # ── Base damage (Gen 9 formula) ──────────────────────────────
        power = max(1, move.base_power)
        base_damage = math.floor(((2 * level / 5 + 2) * power * off_stat / def_stat) / 50 + 2)

        # ── STAB ─────────────────────────────────────────────────────
        stab = 1.0
        if move.type in attacker_pokemon.types:
            stab = 1.5
        for mod in self._get_modifiers():
            stab = mod.modify_stab(stab, ctx)

        # ── Type effectiveness ───────────────────────────────────────
        type_eff = get_effectiveness(move.type, defender_pokemon.types)
        for mod in self._get_modifiers():
            type_eff = mod.modify_type_effectiveness(type_eff, ctx)

        # ── Modifier product (items, abilities, etc.) ────────────────
        mod_product = 1.0
        damage_after_mults = float(base_damage)
        for mod in self._get_modifiers():
            damage_after_mults = mod.modify_damage(damage_after_mults, ctx)
        if base_damage > 0:
            mod_product = damage_after_mults / base_damage

        # ── Final damage ─────────────────────────────────────────────
        final_damage = math.floor(base_damage * stab * type_eff * mod_product)

        # ── Damage range (random factor 0.85 – 1.00) ────────────────
        roll_base = base_damage * stab * type_eff * mod_product
        min_dmg = math.floor(roll_base * 0.85)
        max_dmg = math.floor(roll_base * 1.00)

        # ── Defender HP ──────────────────────────────────────────────
        eff_hp = self._compute_hp(defender_pokemon, defender_set, level)

        # ── Turns to kill ────────────────────────────────────────────
        if final_damage <= 0:
            ttk = 0  # can't kill (immune or 0 power)
        else:
            ttk = math.ceil(eff_hp / final_damage)

        # ── TTK range ────────────────────────────────────────────────
        if max_dmg > 0:
            min_ttk = math.ceil(eff_hp / max_dmg)   # best case: fewer turns
            max_ttk = math.ceil(eff_hp / min_dmg) if min_dmg > 0 else min_ttk
        else:
            min_ttk = max_ttk = 0

        return DamageResult(
            move_id=move.id,
            move_name=move.name,
            move_type=move.type,
            move_category=move.category,
            base_power=power,
            offensive_stat=off_stat,
            defensive_stat=def_stat,
            base_damage=base_damage,
            stab_mult=stab,
            type_effectiveness=type_eff,
            modifier_product=round(mod_product, 4),
            final_damage=max(0, final_damage),
            effective_hp=eff_hp,
            turns_to_kill=ttk,
            is_ohko=(ttk == 1),
            is_immune=(type_eff == 0),
            is_contact=move.is_contact,
            min_damage=max(0, min_dmg),
            max_damage=max(0, max_dmg),
            min_turns_to_kill=min_ttk,
            max_turns_to_kill=max_ttk,
        )


    # ── State-Aware Calculation ─────────────────────────────────────────

    def calculate_with_state(
        self,
        attacker_set,
        defender_set,
        move,
        kg,
        attacker_state=None,
        defender_state=None,
        field_state=None,
        level=None,
    ):
        """Full damage calc with state modifiers.

        Applies:
        - Attacker's stat stage multiplier via attacker_state
        - Burn halving to Atk if attacker_state has burn (physical moves)
        - Defender's stat stage multiplier via defender_state
        - Screens (reflect/light screen) from field_state
        - Weather boosts from field_state
        - Critical hit chance (1/24 for most moves)
        - Min damage based on attacker's effective stat
        """
        level = level or self.level
        attacker_pokemon = kg.get_pokemon(attacker_set.pokemon_id)
        defender_pokemon = kg.get_pokemon(defender_set.pokemon_id)

        if not attacker_pokemon or not defender_pokemon:
            return self._empty_result(move, defender_set, attacker_pokemon, kg, level)

        # Build modifier context
        ctx = DamageModifierContext(
            attacker_set, defender_set,
            attacker_pokemon, defender_pokemon,
            move, kg, level,
        )

        # Check if any modifier says to skip
        for mod in self._get_modifiers():
            if mod.should_skip(ctx):
                return DamageResult(
                    move_id=move.id, move_name=move.name,
                    move_type=move.type, move_category=move.category,
                    base_power=0, offensive_stat=0, defensive_stat=0,
                    base_damage=0, stab_mult=1.0, type_effectiveness=0.0,
                    modifier_product=1.0, final_damage=0,
                    effective_hp=0, turns_to_kill=0,
                    is_immune=True, is_contact=move.is_contact,
                )

        # Status moves don't deal damage
        if move.is_status:
            return DamageResult(
                move_id=move.id, move_name=move.name,
                move_type=move.type, move_category=move.category,
                base_power=0, offensive_stat=0, defensive_stat=0,
                base_damage=0, stab_mult=1.0, type_effectiveness=1.0,
                modifier_product=1.0, final_damage=0,
                effective_hp=self._compute_hp(defender_pokemon, defender_set, level),
                turns_to_kill=0, is_contact=move.is_contact,
            )

        # ── Offensive stat ───────────────────────────────────────────
        if move.is_physical:
            off_stat = attacker_set.effective_stat("atk", attacker_pokemon.base_stats, level)
            # Apply attacker's stat stage multiplier
            if attacker_state is not None:
                off_stat = int(off_stat * attacker_state.get_stat_multiplier("atk"))
            # Apply burn halving for physical moves
            if attacker_state is not None and attacker_state.has_condition("burn"):
                off_stat = int(off_stat * 0.5)
        else:
            off_stat = attacker_set.effective_stat("spa", attacker_pokemon.base_stats, level)
            # Apply attacker's stat stage multiplier
            if attacker_state is not None:
                off_stat = int(off_stat * attacker_state.get_stat_multiplier("spa"))

        # Apply offensive modifiers
        for mod in self._get_modifiers():
            off_stat = mod.modify_offense(float(off_stat), ctx)
        off_stat = max(1, int(off_stat))

        # ── Defensive stat ───────────────────────────────────────────
        if move.is_physical:
            def_stat = defender_set.effective_stat("def", defender_pokemon.base_stats, level)
            # Apply defender's stat stage multiplier
            if defender_state is not None:
                def_stat = int(def_stat * defender_state.get_stat_multiplier("def"))
        else:
            def_stat = defender_set.effective_stat("spd", defender_pokemon.base_stats, level)
            # Apply defender's stat stage multiplier
            if defender_state is not None:
                def_stat = int(def_stat * defender_state.get_stat_multiplier("spd"))

        # Apply defensive modifiers
        for mod in self._get_modifiers():
            def_stat = mod.modify_defense(float(def_stat), ctx)
        def_stat = max(1, int(def_stat))

        # ── Screen halving ───────────────────────────────────────────
        screen_mult = 1.0
        if field_state is not None and defender_state is not None:
            # For simplicity, check both sides
            for side in ("a", "b"):
                if move.is_physical and field_state.has_screen("reflect", side):
                    screen_mult *= 0.5
                    break
                elif move.is_special and field_state.has_screen("light_screen", side):
                    screen_mult *= 0.5
                    break

        # ── Base damage (Gen 9 formula) ──────────────────────────────
        power = max(1, move.base_power)
        base_damage = math.floor(
            ((2 * level / 5 + 2) * power * off_stat / def_stat) / 50 + 2
        )

        # Apply screen halving
        base_damage = math.floor(base_damage * screen_mult)

        # ── STAB ─────────────────────────────────────────────────────
        stab = 1.0
        if move.type in attacker_pokemon.types:
            stab = 1.5
        for mod in self._get_modifiers():
            stab = mod.modify_stab(stab, ctx)

        # ── Type effectiveness ───────────────────────────────────────
        type_eff = get_effectiveness(move.type, defender_pokemon.types)
        for mod in self._get_modifiers():
            type_eff = mod.modify_type_effectiveness(type_eff, ctx)

        # ── Weather boost ────────────────────────────────────────────
        weather_mult = 1.0
        if field_state is not None:
            weather = field_state.get_weather()
            if weather:
                # Sun boosts Fire, weakens Water
                if weather == "sun" and move.type == "fire":
                    weather_mult *= 1.5
                elif weather == "sun" and move.type == "water":
                    weather_mult *= 0.5
                # Rain boosts Water, weakens Fire
                elif weather == "rain" and move.type == "water":
                    weather_mult *= 1.5
                elif weather == "rain" and move.type == "fire":
                    weather_mult *= 0.5

        # ── Modifier product (items, abilities, etc.) ────────────────
        mod_product = 1.0
        damage_after_mults = float(base_damage)
        for mod in self._get_modifiers():
            damage_after_mults = mod.modify_damage(damage_after_mults, ctx)
        if base_damage > 0:
            mod_product = damage_after_mults / base_damage

        # Apply weather boost
        mod_product *= weather_mult

        # ── Critical hit ─────────────────────────────────────────────
        # Gen 9: 1/24 chance for most moves, 1/16 for Splash/Struggle
        is_crit = False
        if move.id not in ("splash", "struggle"):
            import random
            is_crit = random.random() < (1/24)
        crit_mult = 1.5 if is_crit else 1.0

        # ── Final damage ─────────────────────────────────────────────
        final_damage = math.floor(base_damage * stab * type_eff * mod_product * crit_mult)

        # ── Damage range (random factor 0.85 – 1.00) ────────────────
        roll_base = base_damage * stab * type_eff * mod_product
        min_dmg = math.floor(roll_base * 0.85)
        max_dmg = math.floor(roll_base * 1.00)

        # ── Defender HP ──────────────────────────────────────────────
        eff_hp = self._compute_hp(defender_pokemon, defender_set, level)

        # ── Turns to kill ────────────────────────────────────────────
        if final_damage <= 0:
            ttk = 0
        else:
            ttk = math.ceil(eff_hp / final_damage)

        # ── TTK range ────────────────────────────────────────────────
        if max_dmg > 0:
            min_ttk = math.ceil(eff_hp / max_dmg)
            max_ttk = math.ceil(eff_hp / min_dmg) if min_dmg > 0 else min_ttk
        else:
            min_ttk = max_ttk = 0

        return DamageResult(
            move_id=move.id,
            move_name=move.name,
            move_type=move.type,
            move_category=move.category,
            base_power=power,
            offensive_stat=off_stat,
            defensive_stat=def_stat,
            base_damage=base_damage,
            stab_mult=stab,
            type_effectiveness=type_eff,
            modifier_product=round(mod_product, 4),
            final_damage=max(0, final_damage),
            effective_hp=eff_hp,
            turns_to_kill=ttk,
            is_ohko=(ttk == 1),
            is_immune=(type_eff == 0),
            is_contact=move.is_contact,
            min_damage=max(0, min_dmg),
            max_damage=max(0, max_dmg),
            min_turns_to_kill=min_ttk,
            max_turns_to_kill=max_ttk,
        )

    # ── Best Move / Turns to Kill ────────────────────────────────────

    def best_move(
        self,
        attacker_set: SetClass,
        defender_set: SetClass,
        kg: KnowledgeGraph,
        level: int | None = None,
    ) -> DamageResult | None:
        """Find the attacker's best damaging move against the defender.

        Returns the DamageResult with the lowest turns_to_kill.
        Returns None if the attacker has no damaging moves.
        """
        best: DamageResult | None = None
        for move_id in attacker_set.moves:
            move = kg.get_move(move_id)
            if not move or move.is_status:
                continue
            result = self.calculate(attacker_set, defender_set, move, kg, level)
            if result.is_immune:
                continue
            if result.final_damage <= 0:
                continue
            if best is None or result.turns_to_kill < best.turns_to_kill:
                best = result
            elif result.turns_to_kill == best.turns_to_kill and result.final_damage > best.final_damage:
                best = result  # prefer higher damage on tie
        return best

    def turns_to_kill(
        self,
        attacker_set: SetClass,
        defender_set: SetClass,
        kg: KnowledgeGraph,
        level: int | None = None,
    ) -> tuple[int, DamageResult | None]:
        """Compute minimum turns for attacker to KO defender.

        Returns (turns, best_damage_result).
        Returns (0, None) if attacker can't deal damage.
        """
        result = self.best_move(attacker_set, defender_set, kg, level)
        if result is None:
            return 0, None
        return result.turns_to_kill, result

    def full_matchup(
        self,
        set_a: SetClass,
        set_b: SetClass,
        kg: KnowledgeGraph,
        level: int | None = None,
    ) -> dict:
        """Compute the full TTK matchup between two sets.

        Returns a dict with:
        - ttk_a_to_b: turns for A to kill B
        - ttk_b_to_a: turns for B to kill A
        - speed_a: A's speed stat
        - speed_b: B's speed stat
        - speed_advantage: "a", "b", or "tie"
        - best_move_a: DamageResult for A's best move
        - best_move_b: DamageResult for B's best move
        - hp_a: A's effective HP
        - hp_b: B's effective HP
        """
        ttk_ab, result_ab = self.turns_to_kill(set_a, set_b, kg, level)
        ttk_ba, result_ba = self.turns_to_kill(set_b, set_a, kg, level)

        pa = kg.get_pokemon(set_a.pokemon_id)
        pb = kg.get_pokemon(set_b.pokemon_id)
        lv = level or self.level

        speed_a = set_a.effective_stat("spe", pa.base_stats, lv) if pa else 0
        speed_b = set_b.effective_stat("spe", pb.base_stats, lv) if pb else 0

        if speed_a > speed_b:
            speed_adv = "a"
        elif speed_b > speed_a:
            speed_adv = "b"
        else:
            speed_adv = "tie"

        hp_a = self._compute_hp(pa, set_a, lv) if pa else 0
        hp_b = self._compute_hp(pb, set_b, lv) if pb else 0

        return {
            "ttk_a_to_b": ttk_ab,
            "ttk_b_to_a": ttk_ba,
            "speed_a": speed_a,
            "speed_b": speed_b,
            "speed_advantage": speed_adv,
            "best_move_a": result_ab,
            "best_move_b": result_ba,
            "hp_a": hp_a,
            "hp_b": hp_b,
            "damage_a_to_b": result_ab.final_damage if result_ab else 0,
            "damage_b_to_a": result_ba.final_damage if result_ba else 0,
            "best_move_a_id": result_ab.move_id if result_ab else "",
            "best_move_b_id": result_ba.move_id if result_ba else "",
            # Damage range fields
            "min_damage_a_to_b": result_ab.min_damage if result_ab else 0,
            "max_damage_a_to_b": result_ab.max_damage if result_ab else 0,
            "min_damage_b_to_a": result_ba.min_damage if result_ba else 0,
            "max_damage_b_to_a": result_ba.max_damage if result_ba else 0,
            "min_ttk_a_to_b": result_ab.min_turns_to_kill if result_ab else 0,
            "max_ttk_a_to_b": result_ab.max_turns_to_kill if result_ab else 0,
            "min_ttk_b_to_a": result_ba.min_turns_to_kill if result_ba else 0,
            "max_ttk_b_to_a": result_ba.max_turns_to_kill if result_ba else 0,
            "damage_pct_a_to_b_lo": result_ab.min_damage_percent if result_ab else 0.0,
            "damage_pct_a_to_b_hi": result_ab.max_damage_percent if result_ab else 0.0,
            "damage_pct_b_to_a_lo": result_ba.min_damage_percent if result_ba else 0.0,
            "damage_pct_b_to_a_hi": result_ba.max_damage_percent if result_ba else 0.0,
        }

    # ── Simple Damage (for simulator page) ───────────────────────────

    def calculate_simple_damage(
        self,
        move_id: str,
        attacker_state: "PokemonState",
        defender_state: "PokemonState",
        kg: "KnowledgeGraph",
    ) -> int:
        """Simple damage calc for simulator page turn execution.

        Takes move_id + PokemonState objects (not SetClass), looks up
        the sets automatically, and returns average damage.

        Returns 0 for status moves or immunities.
        """
        move = kg.get_move(move_id)
        if not move or move.is_status:
            return 0

        attacker_set = kg.get_set(attacker_state.set_id)
        defender_set = kg.get_set(defender_state.set_id)

        if not attacker_set or not defender_set:
            return 0

        result = self.calculate_with_state(
            attacker_set, defender_set, move, kg,
            attacker_state=attacker_state,
            defender_state=defender_state,
            field_state=None,
        )

        if result.is_immune:
            return 0

        return int((result.min_damage + result.max_damage) / 2)

    # ── Helpers ──────────────────────────────────────────────────────

    @staticmethod
    def _compute_hp(
        pokemon: PokemonClass, set_obj: SetClass, level: int
    ) -> int:
        """Compute effective HP stat."""
        base = pokemon.base_stats.get("hp", 0)
        iv = set_obj.ivs.get("hp", 31)
        ev = set_obj.evs.get("hp")
        return int(((2 * base + iv + ev // 4) * level / 100) + level + 10)

    def _empty_result(
        self, move, defender_set, attacker_pokemon, kg, level
    ) -> DamageResult:
        """Return a zero-damage result for error cases."""
        return DamageResult(
            move_id=move.id, move_name=move.name,
            move_type=move.type, move_category=move.category,
            base_power=0, offensive_stat=0, defensive_stat=0,
            base_damage=0, stab_mult=1.0, type_effectiveness=1.0,
            modifier_product=1.0, final_damage=0,
            effective_hp=0, turns_to_kill=0,
            min_damage=0, max_damage=0,
            min_turns_to_kill=0, max_turns_to_kill=0,
        )



    # ── Module-level default calculator ──────────────────────────────────

_default_calc: DamageCalculator | None = None


def get_calculator() -> DamageCalculator:
    """Get or create the module-level default damage calculator.

    Pre-registered with common item modifiers.
    """
    global _default_calc
    if _default_calc is None:
        _default_calc = DamageCalculator()
        # Register built-in modifiers
        _default_calc.register_modifier(ChoiceBandModifier())
        _default_calc.register_modifier(ChoiceSpecsModifier())
        _default_calc.register_modifier(LifeOrbModifier())
        _default_calc.register_modifier(EvioliteModifier())
        _default_calc.register_modifier(AssaultVestModifier())
    return _default_calc


def calculate_damage(
    attacker_set: SetClass,
    defender_set: SetClass,
    move: MoveClass,
    kg: KnowledgeGraph,
    level: int = 100,
) -> DamageResult:
    """Convenience function: calculate damage using the default calculator."""
    return get_calculator().calculate(attacker_set, defender_set, move, kg, level)


def best_move_ttk(
    attacker_set: SetClass,
    defender_set: SetClass,
    kg: KnowledgeGraph,
    level: int = 100,
) -> tuple[int, DamageResult | None]:
    """Convenience function: get TTK using the default calculator."""
    return get_calculator().turns_to_kill(attacker_set, defender_set, kg, level)
