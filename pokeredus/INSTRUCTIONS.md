# Phase 7 Implementation Instructions

## Goal
Implement a generalized, class-based attribute/effect system that can represent dynamic game conditions (status, boosts, weather, terrain, abilities, items) and enable intelligent matchup prediction with complex state interactions.

**Key Principle**: The system must be **data-driven** and **self-evolving** — no hardcoded Pokémon-specific logic. All effects are defined as reusable Attribute classes that can be composed, learned, and refined through feedback.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Battle State Layer                        │
│  GameState | TeamState | PokemonState | FieldState          │
│  (tracks: HP, status, boosts, weather, terrain, hazards)    │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                   Attribute System                           │
│  Attribute (base class)                                      │
│  ├─ StatModifierAttribute (boosts, burns, choice items)     │
│  ├─ DamageModifierAttribute (life orb, expertise, crits)    │
│  ├─ SpeedModifierAttribute (paralysis, scarf, tailwind)     │
│  ├─ ConditionAttribute (status, volatile, trapping)         │
│  ├─ FieldAttribute (weather, terrain, hazards)              │
│  └─ EventAttribute (on_switch, on_damage, on_faint)         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                    Effect Engine                             │
│  AttributeRegistry | EffectResolver | EventHandler          │
│  (applies attributes to state, resolves conflicts)          │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────────┐
│                 Enhanced Damage Calculator                   │
│  Considers: boosts, status, weather, terrain, abilities     │
│  Uses: AttributeResolver for dynamic modifiers              │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1: Define Attribute Base Class

Create `pokeredus/classes/attributes.py`:

```python
"""
Attribute — base class for dynamic game conditions and effects.

Attributes represent any condition that can affect a Pokémon, the field,
or the battle as a whole. They are:
- Reusable: Same attribute can apply to multiple Pokémon
- Composable: Multiple attributes can stack (with rules)
- Data-driven: Defined by parameters, not hardcoded logic
- Self-evolving: Can be learned from battle feedback

Examples:
- StatModifierAttribute(stat="atk", multiplier=1.5, source="swords_dance")
- ConditionAttribute(condition="burn", damage_per_turn=1/16, physical_damage_mult=0.5)
- FieldAttribute(field="sun", fire_mult=1.5, water_mult=0.5, duration=5)
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class Attribute:
    """Base class for all dynamic attributes/effects.
    
    An Attribute is a condition or modifier that can be applied to:
    - A Pokémon (status, boosts, item effects)
    - The field (weather, terrain, hazards)
    - The battle (trick room, gravity)
    
    Attributes are identified by:
    - attribute_type: Category (stat_mod, condition, field, event, etc.)
    - name: Unique identifier (e.g., "burn", "swords_dance", "sun")
    - source: What caused this attribute (move, ability, item, etc.)
    
    Lifecycle:
    - created: When the condition is applied
    - active: While the condition persists
    - expired: When duration ends or condition is removed
    """
    
    attribute_type: str  # "stat_mod", "damage_mod", "speed_mod", "condition", "field", "event"
    name: str            # unique identifier
    source: str          # what caused this (move_id, ability_id, item_id, "weather", etc.)
    
    # Duration (None = permanent until removed)
    duration: Optional[int] = None
    turns_remaining: Optional[int] = None
    
    # Metadata for learning/feedback
    applied_turn: int = 0
    removal_reason: str = ""  # "expired", "cured", "switched", "overwritten"
    
    # Priority for stacking/conflict resolution (higher = applied later)
    priority: int = 0
    
    # Tags for categorization and querying
    tags: list[str] = field(default_factory=list)
    
    # Custom parameters (flexible for any effect)
    params: dict[str, Any] = field(default_factory=dict)
    
    def __post_init__(self):
        if self.turns_remaining is None and self.duration is not None:
            self.turns_remaining = self.duration
    
    def tick(self) -> bool:
        """Advance one turn. Returns True if still active, False if expired."""
        if self.duration is None:
            return True  # permanent
        if self.turns_remaining is None:
            return True
        self.turns_remaining -= 1
        return self.turns_remaining > 0
    
    def can_stack_with(self, other: 'Attribute') -> bool:
        """Check if this attribute can stack with another.
        
        Override in subclasses for specific stacking rules.
        Default: same source cannot stack (e.g., two Swords Dance)
        """
        return self.source != other.source
    
    def resolve_conflict(self, other: 'Attribute') -> 'Attribute':
        """Resolve conflict when stacking is not allowed.
        
        Override in subclasses. Default: keep the one with higher priority,
        or the newer one if priorities are equal.
        """
        if self.priority > other.priority:
            return self
        elif other.priority > self.priority:
            return other
        else:
            return other  # newer wins
    
    def to_dict(self) -> dict:
        return {
            "attribute_type": self.attribute_type,
            "name": self.name,
            "source": self.source,
            "duration": self.duration,
            "turns_remaining": self.turns_remaining,
            "applied_turn": self.applied_turn,
            "priority": self.priority,
            "tags": list(self.tags),
            "params": dict(self.params),
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'Attribute':
        return cls(
            attribute_type=data["attribute_type"],
            name=data["name"],
            source=data["source"],
            duration=data.get("duration"),
            turns_remaining=data.get("turns_remaining"),
            applied_turn=data.get("applied_turn", 0),
            priority=data.get("priority", 0),
            tags=data.get("tags", []),
            params=data.get("params", {}),
        )
    
    def __repr__(self) -> str:
        dur = f", {self.turns_remaining}t" if self.turns_remaining else ""
        return f"Attribute({self.name!r}, src={self.source!r}{dur})"
```

**Key Design Decisions**:
- `params` dict allows any effect to be represented without subclassing
- `tags` enable querying (e.g., "all burn effects", "all weather")
- `priority` and conflict resolution handle stacking rules
- `tick()` method for turn-based expiration

---

## Step 2: Define Specialized Attribute Subclasses

Add specialized subclasses for common attribute types:

```python
# In pokeredus/classes/attributes.py

@dataclass
class StatModifierAttribute(Attribute):
    """Stat stage modifier (e.g., +2 Atk from Swords Dance, -1 Spe from Icy Wind).
    
    params:
        stat: "atk", "def", "spa", "spd", "spe", "accuracy", "evasion"
        stages: int (-6 to +6)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "stat_mod"
        if "stat" not in self.params:
            raise ValueError("StatModifierAttribute requires 'stat' in params")
        if "stages" not in self.params:
            raise ValueError("StatModifierAttribute requires 'stages' in params")
    
    @property
    def stat(self) -> str:
        return self.params["stat"]
    
    @property
    def stages(self) -> int:
        return self.params["stages"]
    
    def get_multiplier(self) -> float:
        """Convert stat stages to multiplier.
        
        Formula: (2 + max(0, stages)) / (2 + max(0, -stages))
        +1 = 1.5x, +2 = 2.0x, -1 = 0.67x, -2 = 0.5x, etc.
        """
        stages = max(-6, min(6, self.stages))
        if stages >= 0:
            return (2 + stages) / 2
        else:
            return 2 / (2 - stages)
    
    def can_stack_with(self, other: Attribute) -> bool:
        """Stat mods stack additively (up to ±6)."""
        if not isinstance(other, StatModifierAttribute):
            return True
        # Same stat from same source doesn't stack (overwrite)
        if self.stat == other.stat and self.source == other.source:
            return False
        # Same stat from different sources stacks (up to ±6)
        return True
    
    def resolve_conflict(self, other: Attribute) -> Attribute:
        """For same source, overwrite (keep newer)."""
        if isinstance(other, StatModifierAttribute) and self.stat == other.stat:
            if self.source == other.source:
                return other  # newer overwrites
        return super().resolve_conflict(other)


@dataclass
class DamageModifierAttribute(Attribute):
    """Damage multiplier (e.g., Life Orb 1.3x, burn 0.5x physical).
    
    params:
        multiplier: float (e.g., 1.3 for Life Orb)
        applies_to: "all", "physical", "special", "status" (default "all")
        move_type: Optional[str] (e.g., "Fire" for sun boost)
        category: Optional[str] (e.g., "Physical" for burn)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "damage_mod"
        if "multiplier" not in self.params:
            raise ValueError("DamageModifierAttribute requires 'multiplier' in params")
    
    @property
    def multiplier(self) -> float:
        return self.params["multiplier"]
    
    def applies_to_move(self, move) -> bool:
        """Check if this modifier applies to a specific move."""
        applies_to = self.params.get("applies_to", "all")
        if applies_to == "all":
            return True
        if applies_to == "physical" and hasattr(move, "is_physical"):
            return move.is_physical
        if applies_to == "special" and hasattr(move, "is_special"):
            return move.is_special
        if applies_to == "status" and hasattr(move, "is_status"):
            return move.is_status
        
        move_type = self.params.get("move_type")
        if move_type and hasattr(move, "type"):
            return move.type == move_type
        
        return False


@dataclass
class SpeedModifierAttribute(Attribute):
    """Speed multiplier (e.g., Choice Scarf 1.5x, paralysis 0.5x).
    
    params:
        multiplier: float (e.g., 1.5 for scarf, 0.5 for paralysis)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "speed_mod"
        if "multiplier" not in self.params:
            raise ValueError("SpeedModifierAttribute requires 'multiplier' in params")
    
    @property
    def multiplier(self) -> float:
        return self.params["multiplier"]
    
    def can_stack_with(self, other: Attribute) -> bool:
        """Speed mods stack multiplicatively, but same source doesn't stack."""
        if isinstance(other, SpeedModifierAttribute) and self.source == other.source:
            return False
        return True


@dataclass
class ConditionAttribute(Attribute):
    """Status condition or volatile condition (e.g., burn, paralysis, confusion).
    
    params:
        condition: "burn", "paralysis", "poison", "toxic", "sleep", "freeze",
                   "confusion", "flinch", "trapped", etc.
        damage_per_turn: Optional[float] (e.g., 1/16 for burn)
        physical_damage_mult: Optional[float] (e.g., 0.5 for burn)
        speed_mult: Optional[float] (e.g., 0.5 for paralysis)
        move_chance: Optional[float] (e.g., 0.25 for full paralysis, 0.33 for confusion)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "condition"
        if "condition" not in self.params:
            raise ValueError("ConditionAttribute requires 'condition' in params")
    
    @property
    def condition(self) -> str:
        return self.params["condition"]
    
    def can_stack_with(self, other: Attribute) -> bool:
        """Same condition doesn't stack. Different conditions can coexist (with rules)."""
        if isinstance(other, ConditionAttribute):
            # Same condition type doesn't stack
            if self.condition == other.condition:
                return False
            # Non-volatile status (burn, paralysis, poison, toxic, sleep, freeze) are mutually exclusive
            non_volatile = {"burn", "paralysis", "poison", "toxic", "sleep", "freeze"}
            if self.condition in non_volatile and other.condition in non_volatile:
                return False
        return True


@dataclass
class FieldAttribute(Attribute):
    """Field effect (weather, terrain, hazards, screens).
    
    params:
        field: "sun", "rain", "sand", "hail", "snow",
               "electric_terrain", "grassy_terrain", "misty_terrain", "psychic_terrain",
               "stealth_rock", "spikes", "toxic_spikes", "sticky_web",
               "reflect", "light_screen", "aurora_veil", "tailwind"
        duration: int (typically 5 for weather/terrain, 8 for screens)
        type_boosts: Optional[dict] (e.g., {"Fire": 1.5, "Water": 0.5} for sun)
        damage_per_turn: Optional[float] (e.g., 1/16 for sand/hail)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "field"
        if "field" not in self.params:
            raise ValueError("FieldAttribute requires 'field' in params")
    
    @property
    def field(self) -> str:
        return self.params["field"]
    
    def can_stack_with(self, other: Attribute) -> bool:
        """Same field doesn't stack (overwrite). Different fields can coexist."""
        if isinstance(other, FieldAttribute) and self.field == other.field:
            return False
        return True
    
    def resolve_conflict(self, other: Attribute) -> Attribute:
        """For same field, overwrite (keep newer)."""
        if isinstance(other, FieldAttribute) and self.field == other.field:
            return other  # newer weather/terrain overwrites
        return super().resolve_conflict(other)


@dataclass
class EventAttribute(Attribute):
    """Event-triggered effect (on_switch_in, on_damage, on_faint, etc.).
    
    params:
        event: "on_switch_in", "on_turn_start", "on_turn_end", "on_damage",
               "on_faint", "on_move", "on_hit"
        effect_type: "damage", "heal", "apply_attribute", "remove_attribute", "stat_change"
        effect_params: dict (parameters for the effect)
        chance: Optional[float] (e.g., 0.3 for 30% activation)
    """
    
    def __post_init__(self):
        super().__post_init__()
        self.attribute_type = "event"
        if "event" not in self.params:
            raise ValueError("EventAttribute requires 'event' in params")
        if "effect_type" not in self.params:
            raise ValueError("EventAttribute requires 'effect_type' in params")
    
    @property
    def event(self) -> str:
        return self.params["event"]
    
    @property
    def effect_type(self) -> str:
        return self.params["effect_type"]
    
    def should_trigger(self, context: dict) -> bool:
        """Check if this event should trigger given the context.
        
        Override for complex conditions. Default: always trigger.
        """
        import random
        chance = self.params.get("chance", 1.0)
        return random.random() < chance
```

**Key Design Decisions**:
- Specialized subclasses provide type safety and helper methods
- `params` dict remains flexible for custom effects
- Stacking rules are defined per subclass (not hardcoded globally)
- Event system allows trigger-based effects

---

## Step 3: Create AttributeRegistry

Create `pokeredus/graph/attribute_registry.py`:

```python
"""
AttributeRegistry — manages active attributes and resolves conflicts.

The registry tracks all active attributes for a Pokémon, the field, or the battle.
It handles:
- Adding new attributes (with conflict resolution)
- Removing attributes (by name, source, or condition)
- Ticking attributes (decrement duration)
- Querying attributes (by type, tag, or condition)
"""

from typing import Optional
from pokeredus.classes.attributes import (
    Attribute, StatModifierAttribute, DamageModifierAttribute,
    SpeedModifierAttribute, ConditionAttribute, FieldAttribute, EventAttribute,
)


class AttributeRegistry:
    """Registry for managing active attributes.
    
    Can be used for:
    - A single Pokémon's attributes (status, boosts, item effects)
    - Field attributes (weather, terrain, hazards)
    - Battle-wide attributes (trick room, gravity)
    """
    
    def __init__(self):
        self._attributes: list[Attribute] = []
    
    def add(self, attribute: Attribute) -> None:
        """Add an attribute, resolving conflicts with existing ones."""
        # Check for conflicts
        for i, existing in enumerate(self._attributes):
            if not attribute.can_stack_with(existing):
                # Resolve conflict
                winner = existing.resolve_conflict(attribute)
                if winner is existing:
                    # Existing wins, don't add new
                    return
                elif winner is attribute:
                    # New wins, remove existing
                    self._attributes.pop(i)
                    break
        
        # Add the new attribute
        self._attributes.append(attribute)
    
    def remove(self, name: str = None, source: str = None, 
               attribute_type: str = None, tag: str = None) -> int:
        """Remove attributes matching the criteria.
        
        Returns the number of attributes removed.
        """
        to_remove = []
        for i, attr in enumerate(self._attributes):
            if name and attr.name == name:
                to_remove.append(i)
            elif source and attr.source == source:
                to_remove.append(i)
            elif attribute_type and attr.attribute_type == attribute_type:
                to_remove.append(i)
            elif tag and tag in attr.tags:
                to_remove.append(i)
        
        # Remove in reverse order to preserve indices
        for i in reversed(to_remove):
            self._attributes.pop(i)
        
        return len(to_remove)
    
    def tick(self) -> list[Attribute]:
        """Advance all attributes by one turn.
        
        Returns list of expired attributes (for logging/feedback).
        """
        expired = []
        active = []
        for attr in self._attributes:
            if attr.tick():
                active.append(attr)
            else:
                attr.removal_reason = "expired"
                expired.append(attr)
        self._attributes = active
        return expired
    
    def get(self, attribute_type: str = None, name: str = None,
            source: str = None, tag: str = None) -> list[Attribute]:
        """Query attributes matching the criteria."""
        results = []
        for attr in self._attributes:
            if attribute_type and attr.attribute_type != attribute_type:
                continue
            if name and attr.name != name:
                continue
            if source and attr.source != source:
                continue
            if tag and tag not in attr.tags:
                continue
            results.append(attr)
        return results
    
    def has(self, name: str = None, condition: str = None, 
            field: str = None) -> bool:
        """Check if an attribute exists."""
        for attr in self._attributes:
            if name and attr.name == name:
                return True
            if condition and isinstance(attr, ConditionAttribute) and attr.condition == condition:
                return True
            if field and isinstance(attr, FieldAttribute) and attr.field == field:
                return True
        return False
    
    def clear(self) -> None:
        """Remove all attributes."""
        self._attributes.clear()
    
    def get_stat_modifier(self, stat: str) -> float:
        """Get the combined stat multiplier for a stat.
        
        Stacks all StatModifierAttribute for the given stat multiplicatively.
        """
        multiplier = 1.0
        for attr in self.get(attribute_type="stat_mod"):
            if isinstance(attr, StatModifierAttribute) and attr.stat == stat:
                multiplier *= attr.get_multiplier()
        return multiplier
    
    def get_damage_multiplier(self, move=None) -> float:
        """Get the combined damage multiplier.
        
        Stacks all applicable DamageModifierAttribute multiplicatively.
        """
        multiplier = 1.0
        for attr in self.get(attribute_type="damage_mod"):
            if isinstance(attr, DamageModifierAttribute):
                if move is None or attr.applies_to_move(move):
                    multiplier *= attr.multiplier
        return multiplier
    
    def get_speed_multiplier(self) -> float:
        """Get the combined speed multiplier.
        
        Stacks all SpeedModifierAttribute multiplicatively.
        """
        multiplier = 1.0
        for attr in self.get(attribute_type="speed_mod"):
            if isinstance(attr, SpeedModifierAttribute):
                multiplier *= attr.multiplier
        return multiplier
    
    def get_conditions(self) -> list[ConditionAttribute]:
        """Get all active conditions."""
        return [attr for attr in self.get(attribute_type="condition")
                if isinstance(attr, ConditionAttribute)]
    
    def get_fields(self) -> list[FieldAttribute]:
        """Get all active field effects."""
        return [attr for attr in self.get(attribute_type="field")
                if isinstance(attr, FieldAttribute)]
    
    def get_events(self, event: str) -> list[EventAttribute]:
        """Get all event attributes for a specific event type."""
        return [attr for attr in self.get(attribute_type="event")
                if isinstance(attr, EventAttribute) and attr.event == event]
    
    @property
    def count(self) -> int:
        return len(self._attributes)
    
    def to_dict(self) -> dict:
        return {
            "attributes": [attr.to_dict() for attr in self._attributes],
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'AttributeRegistry':
        registry = cls()
        for attr_data in data.get("attributes", []):
            # Determine subclass based on attribute_type
            attr_type = attr_data.get("attribute_type")
            if attr_type == "stat_mod":
                attr = StatModifierAttribute.from_dict(attr_data)
            elif attr_type == "damage_mod":
                attr = DamageModifierAttribute.from_dict(attr_data)
            elif attr_type == "speed_mod":
                attr = SpeedModifierAttribute.from_dict(attr_data)
            elif attr_type == "condition":
                attr = ConditionAttribute.from_dict(attr_data)
            elif attr_type == "field":
                attr = FieldAttribute.from_dict(attr_data)
            elif attr_type == "event":
                attr = EventAttribute.from_dict(attr_data)
            else:
                attr = Attribute.from_dict(attr_data)
            registry.add(attr)
        return registry
    
    def __repr__(self) -> str:
        return f"AttributeRegistry({self.count} attributes)"
```

---

## Step 4: Create GameState Classes

Create `pokeredus/graph/game_state.py`:

```python
"""
GameState — represents the dynamic state of a battle.

Tracks:
- Team state (6 Pokémon with HP, status, boosts)
- Field state (weather, terrain, hazards, screens)
- Battle state (turn count, trick room, gravity)

This is the context for attribute application and damage calculation.
"""

from dataclasses import dataclass, field
from typing import Optional
from pokeredus.classes.attributes import Attribute
from pokeredus.graph.attribute_registry import AttributeRegistry


@dataclass
class PokemonState:
    """Dynamic state of a single Pokémon in battle.
    
    Tracks:
    - Current HP
    - Active attributes (status, boosts, item effects)
    - Move usage (PP, disabled moves)
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
    
    # Battle state
    is_active: bool = False
    turns_active: int = 0
    
    def __post_init__(self):
        if self.max_hp == 0:
            # Will be set from SetClass.effective_stat("hp", ...)
            pass
    
    @property
    def hp_percent(self) -> float:
        if self.max_hp == 0:
            return 0.0
        return (self.current_hp / self.max_hp) * 100.0
    
    @property
    def is_fainted(self) -> bool:
        return self.current_hp <= 0
    
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
    
    def tick(self) -> list[Attribute]:
        """Advance one turn, return expired attributes."""
        self.turns_active += 1
        return self.attributes.tick()
    
    def to_dict(self) -> dict:
        return {
            "pokemon_id": self.pokemon_id,
            "set_id": self.set_id,
            "current_hp": self.current_hp,
            "max_hp": self.max_hp,
            "attributes": self.attributes.to_dict(),
            "moves_used": dict(self.moves_used),
            "disabled_moves": list(self.disabled_moves),
            "is_active": self.is_active,
            "turns_active": self.turns_active,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'PokemonState':
        return cls(
            pokemon_id=data["pokemon_id"],
            set_id=data["set_id"],
            current_hp=data.get("current_hp", 0),
            max_hp=data.get("max_hp", 0),
            attributes=AttributeRegistry.from_dict(data.get("attributes", {"attributes": []})),
            moves_used=data.get("moves_used", {}),
            disabled_moves=set(data.get("disabled_moves", [])),
            is_active=data.get("is_active", False),
            turns_active=data.get("turns_active", 0),
        )


@dataclass
class FieldState:
    """Dynamic state of the battlefield.
    
    Tracks:
    - Weather, terrain
    - Hazards (stealth rock, spikes, toxic spikes, sticky web)
    - Screens (reflect, light screen, aurora veil)
    - Other field effects (tailwind, trick room, gravity)
    """
    
    # Separate registries for each side
    side_a_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)
    side_b_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)
    
    # Global field attributes (weather, terrain)
    global_attributes: AttributeRegistry = field(default_factory=AttributeRegistry)
    
    def get_side_attributes(self, side: str) -> AttributeRegistry:
        """Get attributes for a specific side ('a' or 'b')."""
        if side == "a":
            return self.side_a_attributes
        elif side == "b":
            return self.side_b_attributes
        else:
            raise ValueError(f"Invalid side: {side}")
    
    def tick(self) -> list[Attribute]:
        """Advance one turn, return expired attributes."""
        expired = []
        expired.extend(self.side_a_attributes.tick())
        expired.extend(self.side_b_attributes.tick())
        expired.extend(self.global_attributes.tick())
        return expired
    
    def to_dict(self) -> dict:
        return {
            "side_a_attributes": self.side_a_attributes.to_dict(),
            "side_b_attributes": self.side_b_attributes.to_dict(),
            "global_attributes": self.global_attributes.to_dict(),
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'FieldState':
        return cls(
            side_a_attributes=AttributeRegistry.from_dict(data.get("side_a_attributes", {"attributes": []})),
            side_b_attributes=AttributeRegistry.from_dict(data.get("side_b_attributes", {"attributes": []})),
            global_attributes=AttributeRegistry.from_dict(data.get("global_attributes", {"attributes": []})),
        )


@dataclass
class GameState:
    """Complete battle state.
    
    Tracks:
    - Two teams (6 Pokémon each)
    - Field state
    - Turn count
    - Active Pokémon indices
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
    
    def get_active_pokemon(self, side: str) -> Optional[PokemonState]:
        """Get the active Pokémon for a side."""
        if side == "a":
            if 0 <= self.active_a < len(self.team_a):
                return self.team_a[self.active_a]
        elif side == "b":
            if 0 <= self.active_b < len(self.team_b):
                return self.team_b[self.active_b]
        return None
    
    def switch_pokemon(self, side: str, index: int) -> bool:
        """Switch active Pokémon. Returns True if successful."""
        if side == "a":
            if 0 <= index < len(self.team_a) and not self.team_a[index].is_fainted:
                if self.active_a < len(self.team_a):
                    self.team_a[self.active_a].is_active = False
                self.active_a = index
                self.team_a[index].is_active = True
                self.team_a[index].turns_active = 0
                return True
        elif side == "b":
            if 0 <= index < len(self.team_b) and not self.team_b[index].is_fainted:
                if self.active_b < len(self.team_b):
                    self.team_b[self.active_b].is_active = False
                self.active_b = index
                self.team_b[index].is_active = True
                self.team_b[index].turns_active = 0
                return True
        return False
    
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
        
        return expired
    
    def to_dict(self) -> dict:
        return {
            "team_a": [p.to_dict() for p in self.team_a],
            "team_b": [p.to_dict() for p in self.team_b],
            "field": self.field.to_dict(),
            "turn": self.turn,
            "active_a": self.active_a,
            "active_b": self.active_b,
        }
    
    @classmethod
    def from_dict(cls, data: dict) -> 'GameState':
        return cls(
            team_a=[PokemonState.from_dict(p) for p in data.get("team_a", [])],
            team_b=[PokemonState.from_dict(p) for p in data.get("team_b", [])],
            field=FieldState.from_dict(data.get("field", {})),
            turn=data.get("turn", 0),
            active_a=data.get("active_a", 0),
            active_b=data.get("active_b", 0),
        )
    
    def __repr__(self) -> str:
        return f"GameState(turn={self.turn}, team_a={len(self.team_a)}, team_b={len(self.team_b)})"
```

---

## Step 5: Update DamageCalculator

Modify `pokeredus/graph/damage_calc.py` to use attributes:

```python
# Add to DamageCalculator class:

def calculate_with_state(
    self,
    attacker_set: SetClass,
    defender_set: SetClass,
    move: MoveClass,
    kg: KnowledgeGraph,
    attacker_state: PokemonState,
    defender_state: PokemonState,
    field_state: FieldState,
    level: int | None = None,
) -> DamageResult:
    """Calculate damage considering dynamic game state.
    
    This extends the base calculate() method to apply:
    - Stat stage modifiers (from boosts)
    - Status condition effects (burn halves physical damage)
    - Weather/terrain modifiers
    - Item/ability effects (from attributes)
    """
    level = level or self.level
    attacker_pokemon = kg.get_pokemon(attacker_set.pokemon_id)
    defender_pokemon = kg.get_pokemon(defender_set.pokemon_id)
    
    if not attacker_pokemon or not defender_pokemon:
        return self._empty_result(move, defender_set, attacker_pokemon, kg, level)
    
    # Build modifier context (include state)
    ctx = DamageModifierContext(
        attacker_set, defender_set,
        attacker_pokemon, defender_pokemon,
        move, kg, level,
    )
    # Add state to context
    ctx.attacker_state = attacker_state
    ctx.defender_state = defender_state
    ctx.field_state = field_state
    
    # ... rest of calculation, but use state modifiers ...
    
    # Example: Apply stat stage modifiers
    if move.is_physical:
        off_stat = attacker_set.effective_stat("atk", attacker_pokemon.base_stats, level)
        off_stat *= attacker_state.attributes.get_stat_modifier("atk")
    else:
        off_stat = attacker_set.effective_stat("spa", attacker_pokemon.base_stats, level)
        off_stat *= attacker_state.attributes.get_stat_modifier("spa")
    
    # Apply damage modifiers from attributes
    damage_mult = attacker_state.attributes.get_damage_multiplier(move)
    damage_mult *= defender_state.attributes.get_damage_multiplier(move)
    damage_mult *= field_state.global_attributes.get_damage_multiplier(move)
    
    # ... continue with base damage calculation ...
```

---

## Step 6: Create AttributeFactory

Create `pokeredus/graph/attribute_factory.py`:

```python
"""
AttributeFactory — creates Attribute instances from game data.

This factory converts move effects, ability effects, item effects, etc.
into Attribute instances. It's data-driven: effects are defined in JSON/YAML
and loaded at runtime, not hardcoded.

Example:
    factory = AttributeFactory()
    factory.load_effects("data/effects/items.json")
    
    life_orb_attr = factory.create_from_item("lifeorb")
    # Returns: DamageModifierAttribute(name="life_orb", multiplier=1.3, ...)
"""

import json
from pathlib import Path
from pokeredus.classes.attributes import (
    Attribute, StatModifierAttribute, DamageModifierAttribute,
    SpeedModifierAttribute, ConditionAttribute, FieldAttribute, EventAttribute,
)


class AttributeFactory:
    """Factory for creating Attribute instances from effect definitions."""
    
    def __init__(self):
        self._item_effects: dict[str, dict] = {}
        self._ability_effects: dict[str, dict] = {}
        self._move_effects: dict[str, dict] = {}
    
    def load_effects(self, path: str | Path) -> None:
        """Load effect definitions from JSON file.
        
        Expected format:
        {
            "items": {
                "lifeorb": {
                    "attribute_type": "damage_mod",
                    "name": "life_orb",
                    "params": {"multiplier": 1.3, "recoil": 0.1}
                },
                "choicescarf": {
                    "attribute_type": "speed_mod",
                    "name": "choice_scarf",
                    "params": {"multiplier": 1.5, "locks_moves": true}
                }
            },
            "abilities": { ... },
            "moves": { ... }
        }
        """
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        
        self._item_effects = data.get("items", {})
        self._ability_effects = data.get("abilities", {})
        self._move_effects = data.get("moves", {})
    
    def create_from_item(self, item_id: str) -> Attribute | None:
        """Create an Attribute from an item effect definition."""
        effect = self._item_effects.get(item_id)
        if not effect:
            return None
        return self._create_attribute(effect, source=item_id)
    
    def create_from_ability(self, ability_id: str) -> Attribute | None:
        """Create an Attribute from an ability effect definition."""
        effect = self._ability_effects.get(ability_id)
        if not effect:
            return None
        return self._create_attribute(effect, source=ability_id)
    
    def create_from_move(self, move_id: str, **kwargs) -> list[Attribute]:
        """Create Attributes from a move's effects.
        
        Returns a list because moves can have multiple effects
        (e.g., damage + burn chance).
        """
        effect = self._move_effects.get(move_id)
        if not effect:
            return []
        
        # Handle multiple effects
        if "effects" in effect:
            return [self._create_attribute(e, source=move_id) for e in effect["effects"]]
        else:
            return [self._create_attribute(effect, source=move_id)]
    
    def _create_attribute(self, effect: dict, source: str) -> Attribute:
        """Create an Attribute from an effect definition dict."""
        attr_type = effect.get("attribute_type", "generic")
        name = effect.get("name", source)
        params = effect.get("params", {})
        duration = effect.get("duration")
        priority = effect.get("priority", 0)
        tags = effect.get("tags", [])
        
        if attr_type == "stat_mod":
            return StatModifierAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        elif attr_type == "damage_mod":
            return DamageModifierAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        elif attr_type == "speed_mod":
            return SpeedModifierAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        elif attr_type == "condition":
            return ConditionAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        elif attr_type == "field":
            return FieldAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        elif attr_type == "event":
            return EventAttribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        else:
            return Attribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
```

---

## Step 7: Create Effect Definitions

Create `data/effects/items.json`:

```json
{
  "items": {
    "lifeorb": {
      "attribute_type": "damage_mod",
      "name": "life_orb",
      "params": {
        "multiplier": 1.3,
        "applies_to": "all",
        "recoil": 0.1
      },
      "tags": ["item", "damage_boost", "recoil"]
    },
    "choiceband": {
      "attribute_type": "damage_mod",
      "name": "choice_band",
      "params": {
        "multiplier": 1.5,
        "applies_to": "physical",
        "locks_moves": true
      },
      "tags": ["item", "choice", "physical_boost"]
    },
    "choicespecs": {
      "attribute_type": "damage_mod",
      "name": "choice_specs",
      "params": {
        "multiplier": 1.5,
        "applies_to": "special",
        "locks_moves": true
      },
      "tags": ["item", "choice", "special_boost"]
    },
    "choicescarf": {
      "attribute_type": "speed_mod",
      "name": "choice_scarf",
      "params": {
        "multiplier": 1.5,
        "locks_moves": true
      },
      "tags": ["item", "choice", "speed_boost"]
    },
    "eviolite": {
      "attribute_type": "damage_mod",
      "name": "eviolite",
      "params": {
        "multiplier": 0.67,
        "applies_to": "all",
        "condition": "not_fully_evolved"
      },
      "tags": ["item", "defense_boost"]
    },
    "leftovers": {
      "attribute_type": "event",
      "name": "leftovers",
      "params": {
        "event": "on_turn_end",
        "effect_type": "heal",
        "effect_params": {
          "amount_fraction": 0.0625
        }
      },
      "tags": ["item", "recovery"]
    }
  }
}
```

Create `data/effects/abilities.json`:

```json
{
  "abilities": {
    "intimidate": {
      "attribute_type": "stat_mod",
      "name": "intimidate",
      "params": {
        "stat": "atk",
        "stages": -1,
        "target": "opponent"
      },
      "tags": ["ability", "on_switch_in", "stat_drop"]
    },
    "levitate": {
      "attribute_type": "event",
      "name": "levitate",
      "params": {
        "event": "on_damage",
        "effect_type": "immunity",
        "effect_params": {
          "move_type": "Ground"
        }
      },
      "tags": ["ability", "immunity"]
    },
    "roughskin": {
      "attribute_type": "event",
      "name": "rough_skin",
      "params": {
        "event": "on_hit",
        "effect_type": "damage",
        "effect_params": {
          "amount_fraction": 0.125,
          "condition": "contact"
        },
        "chance": 1.0
      },
      "tags": ["ability", "on_contact", "recoil"]
    },
    "drizzle": {
      "attribute_type": "field",
      "name": "rain",
      "params": {
        "field": "rain",
        "duration": 5,
        "type_boosts": {
          "Water": 1.5,
          "Fire": 0.5
        }
      },
      "tags": ["ability", "weather", "on_switch_in"]
    }
  }
}
```

Create `data/effects/moves.json`:

```json
{
  "moves": {
    "swordsdance": {
      "attribute_type": "stat_mod",
      "name": "swords_dance",
      "params": {
        "stat": "atk",
        "stages": 2,
        "target": "self"
      },
      "tags": ["move", "setup", "stat_boost"]
    },
    "willowisp": {
      "effects": [
        {
          "attribute_type": "condition",
          "name": "burn",
          "params": {
            "condition": "burn",
            "damage_per_turn": 0.0625,
            "physical_damage_mult": 0.5
          },
          "duration": null
        }
      ],
      "tags": ["move", "status", "burn"]
    },
    "thunderwave": {
      "attribute_type": "condition",
      "name": "paralysis",
      "params": {
        "condition": "paralysis",
        "speed_mult": 0.5,
        "move_chance": 0.25
      },
      "duration": null,
      "tags": ["move", "status", "paralysis"]
    },
    "stealthrock": {
      "attribute_type": "field",
      "name": "stealth_rock",
      "params": {
        "field": "stealth_rock",
        "target": "opponent_side",
        "damage_on_switch": "type_effectiveness",
        "base_damage_fraction": 0.125
      },
      "duration": null,
      "tags": ["move", "hazard", "entry_hazard"]
    },
    "raindance": {
      "attribute_type": "field",
      "name": "rain",
      "params": {
        "field": "rain",
        "duration": 5,
        "type_boosts": {
          "Water": 1.5,
          "Fire": 0.5
        },
        "accuracy_boosts": {
          "thunder": 1.0,
          "hurricane": 1.0
        }
      },
      "tags": ["move", "weather"]
    }
  }
}
```

---

## Step 8: Integrate with MatchupEngine

Update `pokeredus/graph/matchup_engine.py` to consider state:

```python
def compute_matchup_with_state(
    set_a: SetClass,
    set_b: SetClass,
    kg: KnowledgeGraph,
    state_a: PokemonState,
    state_b: PokemonState,
    field: FieldState,
    calc: DamageCalculator | None = None,
) -> MatchupRelation:
    """Compute matchup considering dynamic game state.
    
    This extends compute_matchup() to apply:
    - Current HP (not just max HP)
    - Active status conditions
    - Stat boosts
    - Field effects
    """
    # ... similar to compute_matchup, but pass state to damage calculator ...
    
    # Example: Consider current HP
    hp_a = state_a.current_hp if state_a.current_hp > 0 else state_a.max_hp
    hp_b = state_b.current_hp if state_b.current_hp > 0 else state_b.max_hp
    
    # Use calculate_with_state instead of calculate
    result_ab = calc.calculate_with_state(
        set_a, set_b, best_move, kg,
        state_a, state_b, field
    )
    
    # ... rest of scoring logic ...
```

---

## Step 9: Create Tests

Create `tests/test_attributes.py`:

```python
"""Tests for the attribute system."""

import pytest
from pokeredus.classes.attributes import (
    Attribute, StatModifierAttribute, DamageModifierAttribute,
    SpeedModifierAttribute, ConditionAttribute, FieldAttribute,
)
from pokeredus.graph.attribute_registry import AttributeRegistry


def test_stat_modifier_attribute():
    """Test stat stage multiplier calculation."""
    attr = StatModifierAttribute(
        attribute_type="stat_mod",
        name="swords_dance",
        source="swordsdance",
        params={"stat": "atk", "stages": 2},
    )
    assert attr.get_multiplier() == 2.0
    
    attr_minus_1 = StatModifierAttribute(
        attribute_type="stat_mod",
        name="intimidate",
        source="intimidate",
        params={"stat": "atk", "stages": -1},
    )
    assert attr_minus_1.get_multiplier() == 2 / 3


def test_attribute_stacking():
    """Test attribute stacking rules."""
    registry = AttributeRegistry()
    
    # Add Swords Dance (+2 Atk)
    sd = StatModifierAttribute(
        attribute_type="stat_mod",
        name="swords_dance",
        source="swordsdance",
        params={"stat": "atk", "stages": 2},
    )
    registry.add(sd)
    
    # Add another Swords Dance (should not stack, overwrite)
    sd2 = StatModifierAttribute(
        attribute_type="stat_mod",
        name="swords_dance",
        source="swordsdance",
        params={"stat": "atk", "stages": 2},
    )
    registry.add(sd2)
    
    # Should still be +2, not +4
    assert registry.get_stat_modifier("atk") == 2.0
    
    # Add Dragon Dance (+1 Atk, +1 Spe) from different source
    dd = StatModifierAttribute(
        attribute_type="stat_mod",
        name="dragon_dance",
        source="dragondance",
        params={"stat": "atk", "stages": 1},
    )
    registry.add(dd)
    
    # Should stack: +2 from SD + +1 from DD = +3 = 2.5x
    assert registry.get_stat_modifier("atk") == 2.5


def test_condition_mutual_exclusion():
    """Test that non-volatile status conditions are mutually exclusive."""
    registry = AttributeRegistry()
    
    # Add burn
    burn = ConditionAttribute(
        attribute_type="condition",
        name="burn",
        source="willowisp",
        params={"condition": "burn", "damage_per_turn": 0.0625},
    )
    registry.add(burn)
    
    # Try to add paralysis (should fail)
    paralysis = ConditionAttribute(
        attribute_type="condition",
        name="paralysis",
        source="thunderwave",
        params={"condition": "paralysis", "speed_mult": 0.5},
    )
    registry.add(paralysis)
    
    # Should only have burn
    assert registry.has(condition="burn")
    assert not registry.has(condition="paralysis")


def test_field_overwrite():
    """Test that weather/terrain overwrite when reapplied."""
    registry = AttributeRegistry()
    
    # Add rain (5 turns)
    rain1 = FieldAttribute(
        attribute_type="field",
        name="rain",
        source="raindance",
        duration=5,
        params={"field": "rain"},
    )
    registry.add(rain1)
    
    # Tick 3 turns
    for _ in range(3):
        registry.tick()
    
    # Should have 2 turns remaining
    rain_attrs = registry.get(attribute_type="field")
    assert len(rain_attrs) == 1
    assert rain_attrs[0].turns_remaining == 2
    
    # Reapply rain (should reset to 5 turns)
    rain2 = FieldAttribute(
        attribute_type="field",
        name="rain",
        source="raindance",
        duration=5,
        params={"field": "rain"},
    )
    registry.add(rain2)
    
    rain_attrs = registry.get(attribute_type="field")
    assert len(rain_attrs) == 1
    assert rain_attrs[0].turns_remaining == 5


def test_attribute_serialization():
    """Test attribute round-trip serialization."""
    attr = StatModifierAttribute(
        attribute_type="stat_mod",
        name="swords_dance",
        source="swordsdance",
        duration=None,
        params={"stat": "atk", "stages": 2},
        tags=["setup", "stat_boost"],
    )
    
    data = attr.to_dict()
    restored = StatModifierAttribute.from_dict(data)
    
    assert restored.name == attr.name
    assert restored.source == attr.source
    assert restored.params == attr.params
    assert restored.tags == attr.tags


def test_registry_serialization():
    """Test registry round-trip serialization."""
    registry = AttributeRegistry()
    
    registry.add(StatModifierAttribute(
        attribute_type="stat_mod",
        name="swords_dance",
        source="swordsdance",
        params={"stat": "atk", "stages": 2},
    ))
    
    registry.add(ConditionAttribute(
        attribute_type="condition",
        name="burn",
        source="willowisp",
        params={"condition": "burn", "damage_per_turn": 0.0625},
    ))
    
    data = registry.to_dict()
    restored = AttributeRegistry.from_dict(data)
    
    assert restored.count == 2
    assert restored.has(name="swords_dance")
    assert restored.has(condition="burn")
```

---

## Step 10: Update Exports

Update `pokeredus/classes/__init__.py`:

```python
from pokeredus.classes.attributes import (
    Attribute, StatModifierAttribute, DamageModifierAttribute,
    SpeedModifierAttribute, ConditionAttribute, FieldAttribute, EventAttribute,
)

__all__ = [
    # ... existing exports ...
    "Attribute", "StatModifierAttribute", "DamageModifierAttribute",
    "SpeedModifierAttribute", "ConditionAttribute", "FieldAttribute", "EventAttribute",
]
```

Update `pokeredus/graph/__init__.py`:

```python
from pokeredus.graph.attribute_registry import AttributeRegistry
from pokeredus.graph.attribute_factory import AttributeFactory
from pokeredus.graph.game_state import GameState, PokemonState, FieldState

__all__ = [
    # ... existing exports ...
    "AttributeRegistry", "AttributeFactory",
    "GameState", "PokemonState", "FieldState",
]
```

---

## Implementation Order

1. **Create attribute classes** (`attributes.py`)
2. **Create attribute registry** (`attribute_registry.py`)
3. **Create game state classes** (`game_state.py`)
4. **Create attribute factory** (`attribute_factory.py`)
5. **Create effect definition files** (JSON in `data/effects/`)
6. **Update damage calculator** to use state
7. **Update matchup engine** to use state
8. **Create tests** for attributes and state
9. **Update exports** in `__init__.py` files
10. **Update documentation** (README, ARCHITECTURE)

---

## Key Design Principles

1. **Data-driven**: Effects are defined in JSON, not hardcoded in Python
2. **Composable**: Multiple attributes can stack with defined rules
3. **Self-evolving**: Attributes can be learned from battle feedback
4. **Type-safe**: Specialized subclasses for common attribute types
5. **Flexible**: `params` dict allows any effect without subclassing
6. **Serializable**: All classes support round-trip JSON serialization
7. **Testable**: Each component has unit tests

---

## Future Enhancements

### Learning System
- Track attribute effectiveness in battles
- Adjust attribute parameters based on outcomes
- Discover new attribute interactions

### Embedding Vectors
- Learn embeddings for attributes
- Use embeddings for similarity and prediction

### Event System
- Trigger-based effects (on_switch_in, on_faint, etc.)
- Conditional effects (if HP < 50%, activate)

### MCTS Integration
- Use GameState for MCTS nodes
- Simulate attribute effects in rollouts
