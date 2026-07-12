"""
GameState — represents the dynamic state of a turn-based battle.

Tracks:
- Team state (6 Pokémon each with HP, status, boosts)
- Field state (weather, terrain, hazards, screens)
- Battle state (turn count, active Pokémon, trick room)

This is the context for attribute application and damage calculation.
The system models a turn-based game where:
- Two Pokémon are on the field (one per side)
- Each turn, each player chooses: use a move OR switch Pokémon
- Attacking moves deal damage (physical or special)
- Status moves apply conditions or modify stats
- Switching consumes the turn but changes the active Pokémon

GameState is optimized for:
- Fast attribute lookup (via AttributeRegistry indexes)
- Efficient turn simulation (minimal object creation)
- Easy state cloning (for MCTS rollouts)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from pokeredus.classes.attributes import (
    Attribute,
    ConditionAttribute,
    FieldAttribute,
    EventAttribute,
)
from pokeredus.graph.attribute_registry import AttributeRegistry


@dataclass
class PokemonState:
    """Dynamic state of a single Pokémon in battle.

    Tracks:
    - Current HP (not just max HP)
    - Active attributes (status, boosts, item effects)
    - Move usage (PP tracking, disabled moves)
    - Battle state (is active, turns on field)

    Attributes are managed via AttributeRegistry for:
    - Efficient stacking/conflict resolution
    - Cached modifier computation
    - Fast querying by type/tag
    """

    pokemon_id: str
    set_id: str

    # HP tracking
    current_hp: int = 0
    max_hp: int = 0

    # Attribute registry (status, boosts, item effects)
    attributes: AttributeRegistry = field(default_factory=AttributeRegistry)

    # Move state
    moves_used: dict[str, int] = field(default_factory=dict)  # move_id → times used
    disabled_moves: set[str] = field(default_factory=set)
    pp_remaining: dict[str, int] = field(default_factory=dict)  # move_id → PP left

    # Battle state
    is_active: bool = False
    turns_active: int = 0
    last_move_used: str = ""

    def __post_init__(self):
        if self.max_hp == 0:
            # Will be set from SetClass.effective_stat("hp", ...)
            pass

    # ── HP Management ───────────────────────────────────────────────

    @property
    def hp_percent(self) -> float:
        """Current HP as percentage of max HP."""
        if self.max_hp == 0:
            return 0.0
        return (self.current_hp / self.max_hp) * 100.0

    @property
    def is_fainted(self) -> bool:
        """True if HP is 0 or below."""
        return self.current_hp <= 0

    @property
    def is_healthy(self) -> bool:
        """True if at full HP with no status conditions."""
        return self.current_hp == self.max_hp and not self.has_status()

    def take_damage(self, damage: int) -> int:
        """Apply damage, return actual damage dealt."""
        actual = min(damage, self.current_hp)
        self.current_hp -= actual
        return actual

    def heal(self, amount: int) -> int:
        """Heal HP, return actual amount healed."""
        actual = min(amount, self.max_hp - self.current_hp)
        self.current_hp += actual
        return actual

    def heal_fraction(self, fraction: float) -> int:
        """Heal a fraction of max HP (e.g., 1/16 for Leftovers)."""
        amount = int(self.max_hp * fraction)
        return self.heal(amount)

    # ── Status Checks ───────────────────────────────────────────────

    def has_status(self) -> bool:
        """True if has any non-volatile status condition."""
        return self.attributes.has(condition="burn") or \
               self.attributes.has(condition="paralysis") or \
               self.attributes.has(condition="poison") or \
               self.attributes.has(condition="toxic") or \
               self.attributes.has(condition="sleep") or \
               self.attributes.has(condition="freeze")

    def has_condition(self, condition: str) -> bool:
        """Check for a specific condition."""
        return self.attributes.has(condition=condition)

    def is_burned(self) -> bool:
        return self.has_condition("burn")

    def is_paralyzed(self) -> bool:
        return self.has_condition("paralysis")

    def is_poisoned(self) -> bool:
        return self.has_condition("poison") or self.has_condition("toxic")

    def is_asleep(self) -> bool:
        return self.has_condition("sleep")

    def is_frozen(self) -> bool:
        return self.has_condition("freeze")

    # ── Stat Stage Helpers (Gen 9 multipliers) ─────────────────────────

    @staticmethod
    def _stage_multiplier(stages: int) -> float:
        """Gen 9 stage multipliers: -6 to +6 stages.

        at +6: 4.0x, at +3: 2.0x, at 0: 1.0x, at -3: 0.5x, at -6: 0.25x
        """
        if stages >= 0:
            return (2 + stages) / 2
        else:
            return 2 / (2 - stages)

    def get_attack_multiplier(self) -> float:
        """Atk multiplier including burn and stat stages."""
        mult = self.get_stat_multiplier("atk")
        if self.has_condition("burn"):
            mult *= 0.5
        return mult

    def get_defense_multiplier(self) -> float:
        """Def multiplier (screens handled in damage calc)."""
        return self.get_stat_multiplier("def")

    def get_speed(self, base_speed: int) -> int:
        """Effective speed with all modifiers applied."""
        # 1. Stat stage multiplier
        speed_mult = self.get_stat_multiplier("spe")
        # 2. Paralysis: 0.5x speed
        if self.has_condition("paralysis"):
            speed_mult *= 0.5
        # 3. Weather speed drops (handled at field level)
        # 4. Item/ability speed mods handled by attribute system
        speed_mult *= self.attributes.get_speed_multiplier()
        return int(max(1, base_speed * speed_mult))

    @property
    def effective_speed(self) -> int:
        """Effective speed (requires base speed lookup from context)."""
        # Placeholder - actual speed must be computed with base_speed
        # Use get_speed(base_speed) instead when base_speed is known
        return 0

    # ── Status Application/Removal ─────────────────────────────────────

    def apply_status(self, condition: str) -> bool:
        """Apply a status condition. Returns False if already has one."""
        if self.has_status():
            return False
        damage_per_turn_map = {
            "burn": 1/16, "poison": 1/8, "toxic": 1/16,
            "sleep": 0, "paralysis": 0, "freeze": 0,
        }
        attr = ConditionAttribute(
            attribute_type="condition",
            name=condition,
            source="manual",
            params={"condition": condition, "damage_per_turn": damage_per_turn_map.get(condition, 0)},
            tags=["status", condition],
        )
        self.attributes.add(attr)
        return True

    def clear_status(self):
        """Remove all non-volatile status conditions."""
        for c in ["burn", "poison", "toxic", "sleep", "paralysis", "freeze"]:
            self.attributes.remove(condition=c)

    # ── Volatile Status Handling ───────────────────────────────────────

    def has_volatile(self, name: str) -> bool:
        """Check for a volatile status condition."""
        return self.attributes.has(tag=f"volatile_{name}")

    def add_volatile(self, name: str, source: str = "move"):
        """Add a volatile status condition."""
        attr = Attribute(
            attribute_type="volatile",
            name=name,
            source=source,
            tags=["volatile", f"volatile_{name}"],
        )
        self.attributes.add(attr)

    def remove_volatile(self, name: str):
        """Remove a volatile status condition."""
        self.attributes.remove(tag=f"volatile_{name}")

    # ── Stat Modifiers ──────────────────────────────────────────────

    def get_stat_multiplier(self, stat: str) -> float:
        """Get combined stat stage multiplier for a stat.

        Computes directly from stored attributes (bypasses the registry's
        StatModifierAttribute isinstance check, so it works with both
        StatModifierAttribute instances and plain Attribute params).
        """
        total_stages = 0
        for attr in self.attributes:
            if attr.attribute_type == "stat_mod":
                # Check if it's a StatModifierAttribute with a direct .stat field
                attr_stat = getattr(attr, "stat", None)
                attr_stages = getattr(attr, "stages", None)
                if attr_stat == stat and attr_stages is not None:
                    total_stages += attr_stages
                # Also handle plain Attribute with stat/stages in params
                elif attr.params.get("stat") == stat:
                    total_stages += attr.params.get("stages", 0)

        stages = max(-6, min(6, total_stages))
        if stages >= 0:
            return (2 + stages) / 2
        else:
            return 2 / (2 - stages)

    def get_effective_speed(self, base_speed: int) -> int:
        """Get effective speed considering boosts and conditions."""
        # Apply stat stage multiplier
        speed_mult = self.get_stat_multiplier("spe")
        # Apply speed modifiers (Choice Scarf, paralysis, etc.)
        speed_mult *= self.attributes.get_speed_multiplier()
        return int(base_speed * speed_mult)

    # ── Turn Processing ─────────────────────────────────────────────

    def tick(self) -> list[Attribute]:
        """Advance one turn, return expired attributes."""
        self.turns_active += 1
        expired = self.attributes.tick()

        # Apply end-of-turn effects
        for cond in self.attributes.get_conditions():
            if cond.damage_per_turn > 0:
                damage = int(self.max_hp * cond.damage_per_turn)
                self.take_damage(damage)

        return expired

    def switch_in(self) -> None:
        """Called when this Pokémon switches into battle."""
        self.is_active = True
        self.turns_active = 0
        # Clear volatile conditions on switch
        self.attributes.remove(tag="volatile")

    def switch_out(self) -> None:
        """Called when this Pokémon switches out of battle."""
        self.is_active = False
        # Clear volatile conditions and stat boosts on switch
        self.attributes.remove(tag="volatile")
        self.attributes.remove(attribute_type="stat_mod")

    # ── Move Tracking ───────────────────────────────────────────────

    def use_move(self, move_id: str) -> None:
        """Record that a move was used."""
        self.moves_used[move_id] = self.moves_used.get(move_id, 0) + 1
        self.last_move_used = move_id
        if move_id in self.pp_remaining:
            self.pp_remaining[move_id] -= 1

    def can_use_move(self, move_id: str) -> bool:
        """Check if a move can be used (not disabled, has PP)."""
        if move_id in self.disabled_moves:
            return False
        if move_id in self.pp_remaining and self.pp_remaining[move_id] <= 0:
            return False
        return True

    # ── Serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "pokemon_id": self.pokemon_id,
            "set_id": self.set_id,
            "current_hp": self.current_hp,
            "max_hp": self.max_hp,
            "attributes": self.attributes.to_dict(),
            "moves_used": dict(self.moves_used),
            "disabled_moves": list(self.disabled_moves),
            "pp_remaining": dict(self.pp_remaining),
            "is_active": self.is_active,
            "turns_active": self.turns_active,
            "last_move_used": self.last_move_used,
        }

    @classmethod
    def from_dict(cls, data: dict) -> PokemonState:
        return cls(
            pokemon_id=data["pokemon_id"],
            set_id=data["set_id"],
            current_hp=data.get("current_hp", 0),
            max_hp=data.get("max_hp", 0),
            attributes=AttributeRegistry.from_dict(
                data.get("attributes", {"attributes": []})
            ),
            moves_used=data.get("moves_used", {}),
            disabled_moves=set(data.get("disabled_moves", [])),
            pp_remaining=data.get("pp_remaining", {}),
            is_active=data.get("is_active", False),
            turns_active=data.get("turns_active", 0),
            last_move_used=data.get("last_move_used", ""),
        )

    def clone(self) -> PokemonState:
        """Create a deep copy of this state (for MCTS rollouts)."""
        return PokemonState.from_dict(self.to_dict())


@dataclass
class FieldState:
    """Dynamic state of the battlefield.

    Tracks:
    - Global effects (weather, terrain)
    - Side-specific effects (hazards, screens, tailwind)

    Field attributes are organized by side:
    - global_attributes: Weather, terrain (affect both sides)
    - side_a_attributes: Hazards/screens on side A
    - side_b_attributes: Hazards/screens on side B
    """

    # Separate registries for each side
    side_a_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)
    side_b_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)

    # Global field attributes (weather, terrain)
    global_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)

    # ── Side Access ─────────────────────────────────────────────────

    def get_side_attributes(self, side: str) -> AttributeRegistry:
        """Get attributes for a specific side ('a' or 'b')."""
        if side == "a":
            return self.side_a_attributes
        elif side == "b":
            return self.side_b_attributes
        else:
            raise ValueError(f"Invalid side: {side}")

    def has_hazard(self, hazard: str, side: str) -> bool:
        """Check if a side has a specific hazard."""
        registry = self.get_side_attributes(side)
        return registry.has(field=hazard)

    def has_screen(self, screen: str, side: str) -> bool:
        """Check if a side has a specific screen."""
        registry = self.get_side_attributes(side)
        return registry.has(field=screen)

    # ── Weather/Terrain ─────────────────────────────────────────────

    def get_weather(self) -> Optional[str]:
        """Get current weather, or None if no weather."""
        for attr in self.global_attributes.get(attribute_type="field"):
            if isinstance(attr, FieldAttribute) and attr.field in FieldAttribute.WEATHER_TYPES:
                return attr.field
        return None

    def get_terrain(self) -> Optional[str]:
        """Get current terrain, or None if no terrain."""
        for attr in self.global_attributes.get(attribute_type="field"):
            if isinstance(attr, FieldAttribute) and attr.field in FieldAttribute.TERRAIN_TYPES:
                return attr.field
        return None

    # ── Turn Processing ─────────────────────────────────────────────

    def tick(self) -> list[Attribute]:
        """Advance one turn, return expired attributes."""
        expired = []
        expired.extend(self.side_a_attributes.tick())
        expired.extend(self.side_b_attributes.tick())
        expired.extend(self.global_attributes.tick())
        return expired

    # ── Serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "side_a_attributes": self.side_a_attributes.to_dict(),
            "side_b_attributes": self.side_b_attributes.to_dict(),
            "global_attributes": self.global_attributes.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict) -> FieldState:
        return cls(
            side_a_attributes=AttributeRegistry.from_dict(
                data.get("side_a_attributes", {"attributes": []})
            ),
            side_b_attributes=AttributeRegistry.from_dict(
                data.get("side_b_attributes", {"attributes": []})
            ),
            global_attributes=AttributeRegistry.from_dict(
                data.get("global_attributes", {"attributes": []})
            ),
        )

    def clone(self) -> FieldState:
        """Create a deep copy of this state."""
        return FieldState.from_dict(self.to_dict())


@dataclass
class GameState:
    """Complete battle state for a turn-based Pokémon battle.

    Tracks:
    - Two teams (6 Pokémon each)
    - Field state (weather, terrain, hazards)
    - Turn count
    - Active Pokémon indices

    Turn structure:
    1. Both players choose action (move or switch)
    2. Speed determines order (or priority moves override)
    3. Actions execute in order
    4. End-of-turn effects apply (status damage, Leftovers, weather)
    5. Check for faints and forced switches

    GameState is the root context for:
    - Damage calculation (via DamageCalculator.calculate_with_state)
    - Matchup prediction (via compute_matchup_with_state)
    - MCTS simulation (via state cloning and action application)
    """

    # Teams
    team_a: list[PokemonState] = field(default_factory=list)
    team_b: list[PokemonState] = field(default_factory=list)

    # Field
    field: FieldState = field(default_factory=FieldState)

    # Battle state
    turn: int = 0
    active_a: int = 0  # Index of active Pokémon in team_a
    active_b: int = 0  # Index of active Pokémon in team_b

    # Battle flags
    trick_room: bool = False  # Reverses speed order

    # ── Active Pokémon Access ───────────────────────────────────────

    def get_active_pokemon(self, side: str) -> Optional[PokemonState]:
        """Get the active Pokémon for a side."""
        if side == "a":
            if 0 <= self.active_a < len(self.team_a):
                return self.team_a[self.active_a]
        elif side == "b":
            if 0 <= self.active_b < len(self.team_b):
                return self.team_b[self.active_b]
        return None

    def get_opponent(self, side: str) -> Optional[PokemonState]:
        """Get the opponent's active Pokémon."""
        if side == "a":
            return self.get_active_pokemon("b")
        elif side == "b":
            return self.get_active_pokemon("a")
        return None

    # ── Turn Order ─────────────────────────────────────────────────────

    def get_turn_order(
        self,
        base_speeds: dict[str, int] | None = None,
    ) -> list[tuple[str, int]]:
        """Returns [(side, speed), ...] sorted by speed (Trick Room reverses).

        Args:
            base_speeds: Optional dict mapping 'a'/'b' to base speed values.
                         If not provided, uses effective_speed property (which
                         may be 0 if base speed wasn't computed).
        """
        order = []
        for side in ("a", "b"):
            active = self.get_active_pokemon(side)
            if active and not active.is_fainted:
                if base_speeds and side in base_speeds:
                    speed = active.get_speed(base_speeds[side])
                else:
                    speed = active.effective_speed
                order.append((side, speed))
            else:
                order.append((side, -1))  # fainted = last
        if self.trick_room:
            order.sort(key=lambda x: x[1])  # lowest speed first
        else:
            order.sort(key=lambda x: -x[1])  # highest speed first
        return order

    # ── Switching ───────────────────────────────────────────────────

    def switch_pokemon(self, side: str, index: int) -> bool:
        """Switch active Pokémon. Returns True if successful."""
        team = self.team_a if side == "a" else self.team_b
        active_idx = self.active_a if side == "a" else self.active_b

        if not (0 <= index < len(team)):
            return False
        if team[index].is_fainted:
            return False

        # Switch out current Pokémon
        if 0 <= active_idx < len(team):
            team[active_idx].switch_out()

        # Switch in new Pokémon
        if side == "a":
            self.active_a = index
        else:
            self.active_b = index

        team[index].switch_in()

        # Apply entry hazards
        self._apply_entry_hazards(side, team[index])

        return True

    def _apply_entry_hazards(self, side: str, pokemon: PokemonState) -> None:
        """Apply entry hazards when a Pokémon switches in."""
        registry = self.field.get_side_attributes(side)

        # Stealth Rock: damage based on type effectiveness vs Rock
        if registry.has(field="stealth_rock"):
            # Simplified: assume neutral damage (1/8 max HP)
            # Full implementation would check type effectiveness
            damage = int(pokemon.max_hp / 8)
            pokemon.take_damage(damage)

        # Spikes: damage based on layers
        spikes = registry.get(attribute_type="field")
        for attr in spikes:
            if isinstance(attr, FieldAttribute) and attr.field == "spikes":
                layers = attr.layers
                damage_fraction = {1: 1/8, 2: 1/6, 3: 1/4}.get(layers, 1/8)
                damage = int(pokemon.max_hp * damage_fraction)
                pokemon.take_damage(damage)

        # Toxic Spikes: apply poison/toxic
        for attr in spikes:
            if isinstance(attr, FieldAttribute) and attr.field == "toxic_spikes":
                if attr.layers >= 2:
                    # Toxic (badly poisoned)
                    from pokeredus.classes.attributes import ConditionAttribute
                    toxic = ConditionAttribute(
                        attribute_type="condition",
                        name="toxic",
                        source="toxic_spikes",
                        params={"condition": "toxic", "damage_per_turn": 1/16},
                    )
                    pokemon.attributes.add(toxic)
                else:
                    # Regular poison
                    from pokeredus.classes.attributes import ConditionAttribute
                    poison = ConditionAttribute(
                        attribute_type="condition",
                        name="poison",
                        source="toxic_spikes",
                        params={"condition": "poison", "damage_per_turn": 1/8},
                    )
                    pokemon.attributes.add(poison)

    # ── Turn Processing ─────────────────────────────────────────────

    def tick(self) -> dict:
        """Advance one turn. Returns dict of expired attributes by category."""
        self.turn += 1

        expired = {
            "team_a": [],
            "team_b": [],
            "field": [],
        }

        # Tick all Pokémon
        for pokemon in self.team_a:
            if not pokemon.is_fainted:
                expired["team_a"].extend(pokemon.tick())

        for pokemon in self.team_b:
            if not pokemon.is_fainted:
                expired["team_b"].extend(pokemon.tick())

        # Tick field
        expired["field"].extend(self.field.tick())

        # Check for Trick Room expiration
        if self.trick_room:
            # Trick Room lasts 5 turns
            if self.turn % 5 == 0:
                self.trick_room = False

        return expired

    # ── Battle End Detection ────────────────────────────────────────

    def is_battle_over(self) -> tuple[bool, Optional[str]]:
        """Check if battle is over. Returns (is_over, winner_side)."""
        team_a_alive = any(not p.is_fainted for p in self.team_a)
        team_b_alive = any(not p.is_fainted for p in self.team_b)

        if not team_a_alive and not team_b_alive:
            return True, None  # Draw
        elif not team_a_alive:
            return True, "b"
        elif not team_b_alive:
            return True, "a"
        return False, None

    def count_alive(self, side: str) -> int:
        """Count alive Pokémon on a side."""
        team = self.team_a if side == "a" else self.team_b
        return sum(1 for p in team if not p.is_fainted)

    # ── State Cloning (for MCTS) ────────────────────────────────────

    def clone(self) -> GameState:
        """Create a deep copy of this state for simulation."""
        return GameState.from_dict(self.to_dict())

    # ── Serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "team_a": [p.to_dict() for p in self.team_a],
            "team_b": [p.to_dict() for p in self.team_b],
            "field": self.field.to_dict(),
            "turn": self.turn,
            "active_a": self.active_a,
            "active_b": self.active_b,
            "trick_room": self.trick_room,
        }

    @classmethod
    def from_dict(cls, data: dict) -> GameState:
        return cls(
            team_a=[PokemonState.from_dict(p) for p in data.get("team_a", [])],
            team_b=[PokemonState.from_dict(p) for p in data.get("team_b", [])],
            field=FieldState.from_dict(data.get("field", {})),
            turn=data.get("turn", 0),
            active_a=data.get("active_a", 0),
            active_b=data.get("active_b", 0),
            trick_room=data.get("trick_room", False),
        )

    def __repr__(self) -> str:
        alive_a = self.count_alive("a")
        alive_b = self.count_alive("b")
        return f"GameState(turn={self.turn}, team_a={alive_a}/6, team_b={alive_b}/6)"
