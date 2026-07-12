"""
Attribute — base class for dynamic game conditions and effects.

An Attribute represents any condition that can affect a Pokémon, the field,
or the battle as a whole. Attributes are:

- Reusable: Same attribute type can apply to multiple Pokémon
- Composable: Multiple attributes stack with defined conflict rules
- Data-driven: Specific effects defined in JSON, not hardcoded
- Self-evolving: Carry metrics for learning from battle feedback
- Queryable: Tags and categories enable efficient lookup

The attribute system is the foundation for:
- Status conditions (burn, paralysis, poison, sleep, freeze)
- Stat boosts (+2 Atk from Swords Dance, -1 Spe from Icy Wind)
- Field effects (weather, terrain, hazards, screens)
- Item/ability effects (Choice Scarf, Intimidate, Rough Skin)
- Event triggers (on_switch_in, on_faint, on_damage)

Attribute lifecycle:
1. CREATED — when the condition is applied
2. ACTIVE — while the condition persists (may tick down)
3. EXPIRED — when duration ends or condition is removed

Stacking rules:
- Same source, same target: OVERWRITE (newer wins)
- Different sources, compatible types: STACK (additive/multiplicative)
- Conflicting types (e.g., two weather): OVERWRITE (newer wins)
- Non-volatile status: MUTUALLY EXCLUSIVE (one at a time)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional


# ── Attribute Categories ────────────────────────────────────────────
# These are the recognized attribute types. The system is extensible:
# new types can be added by creating subclasses and registering them.
ATTRIBUTE_TYPES = (
    "stat_mod",       # Stat stage changes (+2 Atk, -1 Spe, etc.)
    "damage_mod",     # Damage multipliers (Life Orb, Expert Belt, burn)
    "speed_mod",      # Speed multipliers (Choice Scarf, paralysis, Tailwind)
    "condition",      # Status conditions (burn, paralysis, sleep, etc.)
    "field",          # Field effects (weather, terrain, hazards, screens)
    "event",          # Triggered effects (on_switch, on_faint, on_hit)
    "immunity",       # Type/move immunities (Levitate, Flash Fire)
    "recovery",       # HP recovery effects (Leftovers, Regenerator)
)


@dataclass
class Attribute:
    """Base class for all dynamic attributes/effects.

    An Attribute is a condition or modifier that can be applied to:
    - A Pokémon (status, boosts, item effects)
    - The field (weather, terrain, hazards)
    - The battle (Trick Room, Gravity)

    Identity:
    - attribute_type: Category (stat_mod, condition, field, event, etc.)
    - name: Unique identifier (e.g., "burn", "swords_dance", "sun")
    - source: What caused this attribute (move_id, ability_id, item_id, etc.)

    Lifecycle:
    - duration: Total turns (None = permanent until removed)
    - turns_remaining: Current remaining turns
    - applied_turn: Turn number when applied

    Metadata (for learning/feedback):
    - tags: Categorization labels for querying
    - metrics: Performance tracking (times_applied, win_rate, etc.)
    - params: Flexible parameter dict for any effect
    """

    attribute_type: str
    name: str
    source: str

    # Duration
    duration: Optional[int] = None
    turns_remaining: Optional[int] = None

    # Metadata
    applied_turn: int = 0
    removal_reason: str = ""
    priority: int = 0
    tags: list[str] = field(default_factory=list)
    params: dict[str, Any] = field(default_factory=dict)

    # Learning metrics (for self-evolution)
    metrics: dict[str, float] = field(default_factory=dict)

    def __post_init__(self):
        if self.turns_remaining is None and self.duration is not None:
            self.turns_remaining = self.duration

    # ── Lifecycle ───────────────────────────────────────────────────

    def tick(self) -> bool:
        """Advance one turn. Returns True if still active, False if expired."""
        if self.duration is None:
            return True  # permanent
        if self.turns_remaining is None:
            return True
        self.turns_remaining -= 1
        return self.turns_remaining > 0

    @property
    def is_expired(self) -> bool:
        """True if the attribute has expired."""
        if self.duration is None:
            return False
        return self.turns_remaining is not None and self.turns_remaining <= 0

    @property
    def is_permanent(self) -> bool:
        """True if the attribute has no duration limit."""
        return self.duration is None

    # ── Stacking Rules ──────────────────────────────────────────────

    def can_stack_with(self, other: Attribute) -> bool:
        """Check if this attribute can coexist with another.

        Default rule: same source cannot stack (overwrite).
        Override in subclasses for type-specific rules.
        """
        if self.attribute_type != other.attribute_type:
            return True  # different types always coexist
        return self.source != other.source

    def resolve_conflict(self, other: Attribute) -> Attribute:
        """Resolve conflict when stacking is not allowed.

        Default: higher priority wins; equal priority → newer wins.
        Override in subclasses for type-specific rules.
        """
        if self.priority > other.priority:
            return self
        elif other.priority > self.priority:
            return other
        return other  # newer wins on tie

    # ── Query Helpers ───────────────────────────────────────────────

    def has_tag(self, tag: str) -> bool:
        return tag in self.tags

    def has_any_tag(self, *tags: str) -> bool:
        return bool(set(tags) & set(self.tags))

    def has_all_tags(self, *tags: str) -> bool:
        return set(tags).issubset(set(self.tags))

    # ── Metrics (for learning) ──────────────────────────────────────

    def record_application(self) -> None:
        """Record that this attribute was applied in a battle."""
        self.metrics["times_applied"] = self.metrics.get("times_applied", 0) + 1

    def record_outcome(self, won: bool) -> None:
        """Record battle outcome for learning."""
        self.metrics["battles"] = self.metrics.get("battles", 0) + 1
        if won:
            self.metrics["wins"] = self.metrics.get("wins", 0) + 1
        self.metrics["win_rate"] = (
            self.metrics.get("wins", 0) / self.metrics["battles"]
        )

    # ── Serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "attribute_type": self.attribute_type,
            "name": self.name,
            "source": self.source,
            "duration": self.duration,
            "turns_remaining": self.turns_remaining,
            "applied_turn": self.applied_turn,
            "removal_reason": self.removal_reason,
            "priority": self.priority,
            "tags": list(self.tags),
            "params": dict(self.params),
            "metrics": dict(self.metrics),
        }

    @classmethod
    def from_dict(cls, data: dict) -> Attribute:
        # Dispatch to subclass based on attribute_type
        attr_type = data.get("attribute_type", "")
        subclass = _ATTRIBUTE_TYPE_MAP.get(attr_type, cls)
        return subclass(
            attribute_type=data["attribute_type"],
            name=data["name"],
            source=data["source"],
            duration=data.get("duration"),
            turns_remaining=data.get("turns_remaining"),
            applied_turn=data.get("applied_turn", 0),
            removal_reason=data.get("removal_reason", ""),
            priority=data.get("priority", 0),
            tags=data.get("tags", []),
            params=data.get("params", {}),
            metrics=data.get("metrics", {}),
        )

    def __repr__(self) -> str:
        dur = f", {self.turns_remaining}t" if self.turns_remaining else ""
        return f"{self.__class__.__name__}({self.name!r}, src={self.source!r}{dur})"


# ── Specialized Attribute Subclasses ────────────────────────────────


@dataclass
class StatModifierAttribute(Attribute):
    """Stat stage modifier (e.g., +2 Atk from Swords Dance).

    params:
        stat: "atk", "def", "spa", "spd", "spe", "accuracy", "evasion"
        stages: int (-6 to +6)
        target: "self" or "opponent" (default "self")
    """

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "stat_mod"

    @property
    def stat(self) -> str:
        return self.params.get("stat", "")

    @property
    def stages(self) -> int:
        return self.params.get("stages", 0)

    @property
    def target(self) -> str:
        return self.params.get("target", "self")

    def get_multiplier(self) -> float:
        """Convert stat stages to multiplier.

        Gen 9 formula: (2 + max(0, stages)) / (2 + max(0, -stages))
        +6 = 4.0x, +2 = 2.0x, +1 = 1.5x, 0 = 1.0x,
        -1 = 0.67x, -2 = 0.5x, -6 = 0.25x
        """
        stages = max(-6, min(6, self.stages))
        if stages >= 0:
            return (2 + stages) / 2
        else:
            return 2 / (2 - stages)

    def can_stack_with(self, other: Attribute) -> bool:
        """Stat mods from different sources stack additively (capped at ±6)."""
        if not isinstance(other, StatModifierAttribute):
            return True
        if self.stat != other.stat:
            return True  # different stats always coexist
        # Same stat, same source → overwrite
        return self.source != other.source

    def resolve_conflict(self, other: Attribute) -> Attribute:
        """Same source + same stat → overwrite (newer wins)."""
        return other  # newer always wins for stat mods


@dataclass
class DamageModifierAttribute(Attribute):
    """Damage multiplier (e.g., Life Orb 1.3x, burn 0.5x physical).

    params:
        multiplier: float (e.g., 1.3 for Life Orb, 0.5 for burn)
        applies_to: "all", "physical", "special" (default "all")
        move_type: Optional[str] (e.g., "Fire" for sun boost)
        condition: Optional[str] (e.g., "not_fully_evolved" for Eviolite)
    """

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "damage_mod"

    @property
    def multiplier(self) -> float:
        return self.params.get("multiplier", 1.0)

    @property
    def applies_to(self) -> str:
        return self.params.get("applies_to", "all")

    def applies_to_move(self, move) -> bool:
        """Check if this modifier applies to a specific move."""
        applies_to = self.applies_to
        if applies_to == "all":
            pass  # applies to everything
        elif applies_to == "physical":
            if hasattr(move, "is_physical") and not move.is_physical:
                return False
        elif applies_to == "special":
            if hasattr(move, "is_special") and not move.is_special:
                return False

        move_type = self.params.get("move_type")
        if move_type and hasattr(move, "type"):
            if move.type != move_type:
                return False

        return True


@dataclass
class SpeedModifierAttribute(Attribute):
    """Speed multiplier (e.g., Choice Scarf 1.5x, paralysis 0.5x).

    params:
        multiplier: float (e.g., 1.5 for scarf, 0.5 for paralysis)
    """

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "speed_mod"

    @property
    def multiplier(self) -> float:
        return self.params.get("multiplier", 1.0)

    def can_stack_with(self, other: Attribute) -> bool:
        """Speed mods stack multiplicatively, but same source doesn't stack."""
        if isinstance(other, SpeedModifierAttribute) and self.source == other.source:
            return False
        return True


@dataclass
class ConditionAttribute(Attribute):
    """Status condition (burn, paralysis, poison, sleep, freeze, etc.).

    params:
        condition: str (condition name)
        volatile: bool (True for confusion/flinch, False for burn/para/etc.)
        damage_per_turn: Optional[float] (e.g., 1/16 for burn)
        physical_damage_mult: Optional[float] (e.g., 0.5 for burn)
        speed_mult: Optional[float] (e.g., 0.5 for paralysis)
        move_fail_chance: Optional[float] (e.g., 0.25 for full paralysis)
    """

    # Non-volatile statuses are mutually exclusive
    NON_VOLATILE = frozenset({
        "burn", "paralysis", "poison", "toxic", "sleep", "freeze",
    })

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "condition"

    @property
    def condition(self) -> str:
        return self.params.get("condition", "")

    @property
    def is_volatile(self) -> bool:
        return self.params.get("volatile", False)

    @property
    def damage_per_turn(self) -> float:
        return self.params.get("damage_per_turn", 0.0)

    @property
    def physical_damage_mult(self) -> float:
        return self.params.get("physical_damage_mult", 1.0)

    @property
    def speed_mult(self) -> float:
        return self.params.get("speed_mult", 1.0)

    @property
    def move_fail_chance(self) -> float:
        return self.params.get("move_fail_chance", 0.0)

    def can_stack_with(self, other: Attribute) -> bool:
        """Same condition doesn't stack. Non-volatile statuses are exclusive."""
        if not isinstance(other, ConditionAttribute):
            return True
        if self.condition == other.condition:
            return False  # same condition, no stack
        # Non-volatile statuses are mutually exclusive
        if self.condition in self.NON_VOLATILE and other.condition in self.NON_VOLATILE:
            return False
        return True

    def resolve_conflict(self, other: Attribute) -> Attribute:
        """For conflicting conditions, existing wins (can't apply new status)."""
        return self  # keep existing status, reject new one


@dataclass
class FieldAttribute(Attribute):
    """Field effect (weather, terrain, hazards, screens).

    params:
        field: str (field effect name)
        side: "global", "side_a", "side_b" (default "global")
        type_boosts: Optional[dict] (e.g., {"Fire": 1.5, "Water": 0.5})
        damage_per_turn: Optional[float] (e.g., 1/16 for sand)
        layers: Optional[int] (for Spikes: 1-3)
    """

    # Weather types overwrite each other
    WEATHER_TYPES = frozenset({"sun", "rain", "sand", "hail", "snow"})
    # Terrain types overwrite each other
    TERRAIN_TYPES = frozenset({
        "electric_terrain", "grassy_terrain",
        "misty_terrain", "psychic_terrain",
    })

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "field"

    @property
    def field(self) -> str:
        return self.params.get("field", "")

    @property
    def side(self) -> str:
        return self.params.get("side", "global")

    @property
    def layers(self) -> int:
        return self.params.get("layers", 1)

    def can_stack_with(self, other: Attribute) -> bool:
        """Same field doesn't stack. Weather/terrain groups are exclusive."""
        if not isinstance(other, FieldAttribute):
            return True
        if self.field == other.field:
            # Same hazard type: go through conflict resolution to merge layers
            return False
        # Weather types are mutually exclusive
        if self.field in self.WEATHER_TYPES and other.field in self.WEATHER_TYPES:
            return False
        # Terrain types are mutually exclusive
        if self.field in self.TERRAIN_TYPES and other.field in self.TERRAIN_TYPES:
            return False
        return True

    def resolve_conflict(self, other: Attribute) -> Attribute:
        """For weather/terrain conflicts, newer wins. For hazards, merge layers."""
        if not isinstance(other, FieldAttribute):
            return other
        if self.field == "spikes" and other.field == "spikes":
            merged_layers = min(3, self.layers + other.layers)
            other.params["layers"] = merged_layers
            return other
        if self.field == "toxic_spikes" and other.field == "toxic_spikes":
            merged_layers = min(2, self.layers + other.layers)
            other.params["layers"] = merged_layers
            return other
        return other  # newer wins


@dataclass
class EventAttribute(Attribute):
    """Event-triggered effect (on_switch_in, on_faint, on_hit, etc.).

    params:
        event: str (event type)
        effect_type: str (what happens: "damage", "heal", "apply_attribute", etc.)
        effect_params: dict (parameters for the effect)
        chance: float (activation probability, 0.0-1.0, default 1.0)
        target: "self", "opponent", "all" (default depends on event)
    """

    VALID_EVENTS = frozenset({
        "on_switch_in", "on_switch_out",
        "on_turn_start", "on_turn_end",
        "on_before_move", "on_after_move",
        "on_damage", "on_hit", "on_faint",
        "on_critical_hit",
    })

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "event"

    @property
    def event(self) -> str:
        return self.params.get("event", "")

    @property
    def effect_type(self) -> str:
        return self.params.get("effect_type", "")

    @property
    def effect_params(self) -> dict:
        return self.params.get("effect_params", {})

    @property
    def chance(self) -> float:
        return self.params.get("chance", 1.0)

    @property
    def target(self) -> str:
        return self.params.get("target", "self")


@dataclass
class ImmunityAttribute(Attribute):
    """Type or move immunity (Levitate, Flash Fire, Volt Absorb).

    params:
        immune_to: str or list[str] (type names or move IDs)
        on_absorb: Optional[str] (effect when absorbing: "heal", "boost", "status_cure")
        absorb_params: Optional[dict] (parameters for absorb effect)
    """

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "immunity"

    @property
    def immune_to(self) -> list[str]:
        val = self.params.get("immune_to", [])
        if isinstance(val, str):
            return [val]
        return val

    @property
    def on_absorb(self) -> str:
        return self.params.get("on_absorb", "")

    def blocks(self, move_type: str = "", move_id: str = "") -> bool:
        """Check if this immunity blocks a given move."""
        for target in self.immune_to:
            if target == move_type or target == move_id:
                return True
        return False


@dataclass
class RecoveryAttribute(Attribute):
    """HP recovery effect (Leftovers, Regenerator, draining moves).

    params:
        amount_fraction: float (fraction of max HP recovered, e.g., 1/16)
        trigger: str ("turn_end", "switch_out", "on_hit", etc.)
        condition: Optional[str] (e.g., "hp_below_50" for Sitrus Berry)
    """

    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "recovery"

    @property
    def amount_fraction(self) -> float:
        return self.params.get("amount_fraction", 0.0)

    @property
    def trigger(self) -> str:
        return self.params.get("trigger", "turn_end")


# ── Type Registry ───────────────────────────────────────────────────
# Maps attribute_type strings to their classes for deserialization.

_ATTRIBUTE_TYPE_MAP: dict[str, type] = {
    "stat_mod": StatModifierAttribute,
    "damage_mod": DamageModifierAttribute,
    "speed_mod": SpeedModifierAttribute,
    "condition": ConditionAttribute,
    "field": FieldAttribute,
    "event": EventAttribute,
    "immunity": ImmunityAttribute,
    "recovery": RecoveryAttribute,
}


def register_attribute_type(type_name: str, cls: type) -> None:
    """Register a new attribute type for deserialization."""
    _ATTRIBUTE_TYPE_MAP[type_name] = cls


def get_attribute_class(type_name: str) -> type:
    """Get the class for an attribute type name."""
    return _ATTRIBUTE_TYPE_MAP.get(type_name, Attribute)
