"""
AttributeRegistry — manages active attributes with conflict resolution.

The registry tracks all active attributes for a Pokémon, the field, or the battle.
It handles:
- Adding new attributes (with stacking/conflict resolution)
- Removing attributes (by name, source, type, or tag)
- Ticking attributes (decrement duration each turn)
- Querying attributes (by type, tag, or condition)
- Computing combined modifiers (stat stages, damage multipliers, speed)

The registry is optimized for:
- Fast lookup (indexed by attribute type)
- Efficient stacking (conflict resolution at add time)
- Quick modifier computation (cached until attributes change)
"""

from __future__ import annotations

from typing import Optional

from pokeredus.classes.attributes import (
    Attribute,
    StatModifierAttribute,
    DamageModifierAttribute,
    SpeedModifierAttribute,
    ConditionAttribute,
    FieldAttribute,
    EventAttribute,
    ImmunityAttribute,
    RecoveryAttribute,
)


class AttributeRegistry:
    """Registry for managing active attributes.

    Can be used for:
    - A single Pokémon's attributes (status, boosts, item effects)
    - Field attributes (weather, terrain, hazards)
    - Battle-wide attributes (Trick Room, Gravity)

    Thread safety: Not thread-safe. Use external locking if needed.
    """

    def __init__(self):
        self._attributes: list[Attribute] = []
        # Indexes for fast lookup
        self._by_type: dict[str, list[Attribute]] = {}
        self._by_name: dict[str, Attribute] = {}
        self._by_source: dict[str, list[Attribute]] = {}
        # Modifier cache (invalidated on change)
        self._stat_cache: dict[str, float] = {}
        self._damage_cache: dict[str, float] = {}  # keyed by move category
        self._speed_cache: Optional[float] = None

    # ── Add / Remove ────────────────────────────────────────────────

    def add(self, attribute: Attribute) -> None:
        """Add an attribute, resolving conflicts with existing ones.

        Stacking rules are defined by Attribute.can_stack_with().
        Conflict resolution is defined by Attribute.resolve_conflict().
        """
        # Check for conflicts
        conflicts = []
        for i, existing in enumerate(self._attributes):
            if not attribute.can_stack_with(existing):
                conflicts.append((i, existing))

        # Resolve conflicts
        for i, existing in reversed(conflicts):
            winner = existing.resolve_conflict(attribute)
            if winner is existing:
                # Existing wins, don't add new
                return
            elif winner is attribute:
                # New wins, remove existing
                self._remove_at_index(i)

        # Add the new attribute
        self._attributes.append(attribute)
        self._index_attribute(attribute)
        self._invalidate_cache()

    def remove(
        self,
        name: str = None,
        source: str = None,
        attribute_type: str = None,
        tag: str = None,
    ) -> int:
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
            self._remove_at_index(i)

        if to_remove:
            self._invalidate_cache()

        return len(to_remove)

    def _remove_at_index(self, i: int) -> None:
        """Remove attribute at index i from all indexes."""
        attr = self._attributes[i]
        self._attributes.pop(i)
        # Remove from indexes
        if attr.name in self._by_name:
            del self._by_name[attr.name]
        if attr.attribute_type in self._by_type:
            if attr in self._by_type[attr.attribute_type]:
                self._by_type[attr.attribute_type].remove(attr)
        if attr.source in self._by_source:
            if attr in self._by_source[attr.source]:
                self._by_source[attr.source].remove(attr)

    def _index_attribute(self, attr: Attribute) -> None:
        """Add attribute to indexes."""
        # By name
        self._by_name[attr.name] = attr
        # By type
        if attr.attribute_type not in self._by_type:
            self._by_type[attr.attribute_type] = []
        self._by_type[attr.attribute_type].append(attr)
        # By source
        if attr.source not in self._by_source:
            self._by_source[attr.source] = []
        self._by_source[attr.source].append(attr)

    def _invalidate_cache(self) -> None:
        """Clear modifier caches."""
        self._stat_cache.clear()
        self._damage_cache.clear()
        self._speed_cache = None

    # ── Tick (Advance Turn) ─────────────────────────────────────────

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

        if expired:
            # Rebuild from active list
            self._attributes = active
            self._rebuild_indexes()
            self._invalidate_cache()

        return expired

    def _rebuild_indexes(self) -> None:
        """Rebuild all indexes from _attributes list."""
        self._by_type.clear()
        self._by_name.clear()
        self._by_source.clear()
        for attr in self._attributes:
            self._index_attribute(attr)

    # ── Query ───────────────────────────────────────────────────────

    def get(
        self,
        attribute_type: str = None,
        name: str = None,
        source: str = None,
        tag: str = None,
    ) -> list[Attribute]:
        """Query attributes matching the criteria."""
        # Use indexes when possible
        if name and name in self._by_name:
            return [self._by_name[name]]
        if attribute_type and attribute_type in self._by_type:
            results = self._by_type[attribute_type]
            if source:
                results = [a for a in results if a.source == source]
            if tag:
                results = [a for a in results if tag in a.tags]
            return results
        if source and source in self._by_source:
            results = self._by_source[source]
            if tag:
                results = [a for a in results if tag in a.tags]
            return results

        # Fallback: linear scan
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

    def has(
        self,
        name: str = None,
        condition: str = None,
        field: str = None,
    ) -> bool:
        """Check if an attribute exists."""
        if name:
            return name in self._by_name
        if condition:
            for attr in self.get(attribute_type="condition"):
                if isinstance(attr, ConditionAttribute) and attr.condition == condition:
                    return True
            return False
        if field:
            for attr in self.get(attribute_type="field"):
                if isinstance(attr, FieldAttribute) and attr.field == field:
                    return True
            return False
        return False

    def clear(self) -> None:
        """Remove all attributes."""
        self._attributes.clear()
        self._by_type.clear()
        self._by_name.clear()
        self._by_source.clear()
        self._invalidate_cache()

    # ── Modifier Computation ────────────────────────────────────────

    def get_stat_modifier(self, stat: str) -> float:
        """Get the combined stat multiplier for a stat.

        Stacks all StatModifierAttribute for the given stat.
        Result is cached until attributes change.
        """
        if stat in self._stat_cache:
            return self._stat_cache[stat]

        # Sum all stages for this stat
        total_stages = 0
        for attr in self.get(attribute_type="stat_mod"):
            if isinstance(attr, StatModifierAttribute) and attr.stat == stat:
                total_stages += attr.stages

        # Convert stages to multiplier
        stages = max(-6, min(6, total_stages))
        if stages >= 0:
            multiplier = (2 + stages) / 2
        else:
            multiplier = 2 / (2 - stages)

        self._stat_cache[stat] = multiplier
        return multiplier

    def get_damage_multiplier(self, move=None) -> float:
        """Get the combined damage multiplier.

        Stacks all applicable DamageModifierAttribute multiplicatively.
        Result is cached by move category until attributes change.
        """
        # Determine cache key
        if move is None:
            cache_key = "all"
        elif hasattr(move, "category"):
            cache_key = move.category
        else:
            cache_key = "all"

        if cache_key in self._damage_cache:
            return self._damage_cache[cache_key]

        multiplier = 1.0
        for attr in self.get(attribute_type="damage_mod"):
            if isinstance(attr, DamageModifierAttribute):
                if move is None or attr.applies_to_move(move):
                    multiplier *= attr.multiplier

        self._damage_cache[cache_key] = multiplier
        return multiplier

    def get_speed_multiplier(self) -> float:
        """Get the combined speed multiplier.

        Stacks all SpeedModifierAttribute multiplicatively.
        Result is cached until attributes change.
        """
        if self._speed_cache is not None:
            return self._speed_cache

        multiplier = 1.0
        for attr in self.get(attribute_type="speed_mod"):
            if isinstance(attr, SpeedModifierAttribute):
                multiplier *= attr.multiplier

        self._speed_cache = multiplier
        return multiplier

    def get_conditions(self) -> list[ConditionAttribute]:
        """Get all active conditions."""
        return [
            attr
            for attr in self.get(attribute_type="condition")
            if isinstance(attr, ConditionAttribute)
        ]

    def get_fields(self) -> list[FieldAttribute]:
        """Get all active field effects."""
        return [
            attr
            for attr in self.get(attribute_type="field")
            if isinstance(attr, FieldAttribute)
        ]

    def get_events(self, event: str) -> list[EventAttribute]:
        """Get all event attributes for a specific event type."""
        return [
            attr
            for attr in self.get(attribute_type="event")
            if isinstance(attr, EventAttribute) and attr.event == event
        ]

    def get_immunities(self) -> list[ImmunityAttribute]:
        """Get all immunity attributes."""
        return [
            attr
            for attr in self.get(attribute_type="immunity")
            if isinstance(attr, ImmunityAttribute)
        ]

    def get_recovery(self, trigger: str = None) -> list[RecoveryAttribute]:
        """Get all recovery attributes, optionally filtered by trigger."""
        results = [
            attr
            for attr in self.get(attribute_type="recovery")
            if isinstance(attr, RecoveryAttribute)
        ]
        if trigger:
            results = [r for r in results if r.trigger == trigger]
        return results

    # ── Properties ──────────────────────────────────────────────────

    @property
    def count(self) -> int:
        """Number of active attributes."""
        return len(self._attributes)

    @property
    def is_empty(self) -> bool:
        """True if no attributes are active."""
        return len(self._attributes) == 0

    def __len__(self) -> int:
        return self.count

    def __iter__(self):
        return iter(self._attributes)

    # ── Serialization ───────────────────────────────────────────────

    def to_dict(self) -> dict:
        return {
            "attributes": [attr.to_dict() for attr in self._attributes],
        }

    @classmethod
    def from_dict(cls, data: dict) -> AttributeRegistry:
        registry = cls()
        for attr_data in data.get("attributes", []):
            attr = Attribute.from_dict(attr_data)
            registry.add(attr)
        return registry

    def __repr__(self) -> str:
        return f"AttributeRegistry({self.count} attributes)"
