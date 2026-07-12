"""
AttributeFactory — creates Attribute instances from effect definitions.

This factory converts move effects, ability effects, item effects, etc.
into Attribute instances. It is data-driven: effects are defined in JSON
and loaded at runtime, not hardcoded in Python.

The factory supports:
- Loading effect definitions from JSON files
- Creating attributes from items, abilities, moves
- Discovering synergies (multiple Pokémon enabling the same field condition)
- Caching created attributes for reuse

Effect definition format (JSON):
{
    "items": {
        "lifeorb": {
            "attribute_type": "damage_mod",
            "name": "life_orb",
            "params": {"multiplier": 1.3, "applies_to": "all"}
        }
    },
    "abilities": { ... },
    "moves": { ... }
}
"""

from __future__ import annotations

import json
from pathlib import Path
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
    get_attribute_class,
)


class AttributeFactory:
    """Factory for creating Attribute instances from effect definitions.

    Usage:
        factory = AttributeFactory()
        factory.load_effects("data/effects/items.json")
        factory.load_effects("data/effects/abilities.json")
        factory.load_effects("data/effects/moves.json")

        # Create attributes from game entities
        life_orb_attr = factory.create_from_item("lifeorb")
        intimidate = factory.create_from_ability("intimidate")
        sd_effects = factory.create_from_move("swordsdance")
    """

    def __init__(self):
        self._item_effects: dict[str, dict] = {}
        self._ability_effects: dict[str, dict] = {}
        self._move_effects: dict[str, dict] = {}
        # Cache for created attributes
        self._item_cache: dict[str, list[Attribute]] = {}
        self._ability_cache: dict[str, list[Attribute]] = {}
        self._move_cache: dict[str, list[Attribute]] = {}

    # ── Loading ─────────────────────────────────────────────────────

    def load_effects(self, path: str | Path) -> int:
        """Load effect definitions from a JSON file.

        Returns the number of effects loaded.
        """
        path = Path(path)
        if not path.exists():
            return 0

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        count = 0
        if "items" in data:
            self._item_effects.update(data["items"])
            count += len(data["items"])
        if "abilities" in data:
            self._ability_effects.update(data["abilities"])
            count += len(data["abilities"])
        if "moves" in data:
            self._move_effects.update(data["moves"])
            count += len(data["moves"])

        # Invalidate caches
        self._item_cache.clear()
        self._ability_cache.clear()
        self._move_cache.clear()

        return count

    def load_effects_dict(self, data: dict) -> int:
        """Load effect definitions from a dict (for testing)."""
        count = 0
        if "items" in data:
            self._item_effects.update(data["items"])
            count += len(data["items"])
        if "abilities" in data:
            self._ability_effects.update(data["abilities"])
            count += len(data["abilities"])
        if "moves" in data:
            self._move_effects.update(data["moves"])
            count += len(data["moves"])
        self._item_cache.clear()
        self._ability_cache.clear()
        self._move_cache.clear()
        return count

    # ── Creation ────────────────────────────────────────────────────

    def create_from_item(self, item_id: str) -> list[Attribute]:
        """Create Attribute(s) from an item effect definition.

        Returns a list because some items have multiple effects
        (e.g., Life Orb: damage boost + recoil).
        """
        if item_id in self._item_cache:
            return self._item_cache[item_id]

        effect = self._item_effects.get(item_id)
        if not effect:
            return []

        attrs = self._create_from_effect(effect, source=item_id, category="item")
        self._item_cache[item_id] = attrs
        return attrs

    def create_from_ability(self, ability_id: str) -> list[Attribute]:
        """Create Attribute(s) from an ability effect definition."""
        if ability_id in self._ability_cache:
            return self._ability_cache[ability_id]

        effect = self._ability_effects.get(ability_id)
        if not effect:
            return []

        attrs = self._create_from_effect(effect, source=ability_id, category="ability")
        self._ability_cache[ability_id] = attrs
        return attrs

    def create_from_move(self, move_id: str) -> list[Attribute]:
        """Create Attribute(s) from a move's effect definition.

        Returns a list because moves can have multiple effects
        (e.g., Scald: damage + burn chance).
        """
        if move_id in self._move_cache:
            return self._move_cache[move_id]

        effect = self._move_effects.get(move_id)
        if not effect:
            return []

        attrs = self._create_from_effect(effect, source=move_id, category="move")
        self._move_cache[move_id] = attrs
        return attrs

    def _create_from_effect(
        self, effect: dict, source: str, category: str
    ) -> list[Attribute]:
        """Create Attribute(s) from a single effect definition."""
        # Handle multiple effects
        if "effects" in effect:
            attrs = []
            for sub_effect in effect["effects"]:
                attrs.extend(
                    self._create_from_effect(sub_effect, source, category)
                )
            return attrs

        attr = self._create_single_attribute(effect, source, category)
        return [attr] if attr else []

    def _create_single_attribute(
        self, effect: dict, source: str, category: str
    ) -> Optional[Attribute]:
        """Create a single Attribute from an effect definition."""
        attr_type = effect.get("attribute_type", "")
        name = effect.get("name", source)
        params = dict(effect.get("params", {}))
        duration = effect.get("duration")
        priority = effect.get("priority", 0)
        tags = list(effect.get("tags", []))

        # Add category tag
        if category not in tags:
            tags.append(category)

        cls = get_attribute_class(attr_type)
        try:
            return cls(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )
        except (ValueError, TypeError):
            # Fallback to base Attribute if subclass fails
            return Attribute(
                attribute_type=attr_type,
                name=name,
                source=source,
                duration=duration,
                priority=priority,
                tags=tags,
                params=params,
            )

    # ── Discovery ───────────────────────────────────────────────────

    def get_defined_items(self) -> list[str]:
        """Return all item IDs with defined effects."""
        return list(self._item_effects.keys())

    def get_defined_abilities(self) -> list[str]:
        """Return all ability IDs with defined effects."""
        return list(self._ability_effects.keys())

    def get_defined_moves(self) -> list[str]:
        """Return all move IDs with defined effects."""
        return list(self._move_effects.keys())

    def get_field_creating_moves(self) -> dict[str, list[str]]:
        """Find moves that create field effects (for synergy detection).

        Returns: {field_name: [move_ids that create it]}
        """
        result: dict[str, list[str]] = {}
        for move_id, effect in self._move_effects.items():
            fields = self._extract_fields_from_effect(effect)
            for field_name in fields:
                if field_name not in result:
                    result[field_name] = []
                result[field_name].append(move_id)
        return result

    def get_field_creating_abilities(self) -> dict[str, list[str]]:
        """Find abilities that create field effects (for synergy detection).

        Returns: {field_name: [ability_ids that create it]}
        """
        result: dict[str, list[str]] = {}
        for ability_id, effect in self._ability_effects.items():
            fields = self._extract_fields_from_effect(effect)
            for field_name in fields:
                if field_name not in result:
                    result[field_name] = []
                result[field_name].append(ability_id)
        return result

    def _extract_fields_from_effect(self, effect: dict) -> list[str]:
        """Extract field names from an effect definition."""
        fields = []
        if effect.get("attribute_type") == "field":
            field_name = effect.get("params", {}).get("field", "")
            if field_name:
                fields.append(field_name)
        if "effects" in effect:
            for sub in effect["effects"]:
                fields.extend(self._extract_fields_from_effect(sub))
        return fields

    # ── Stats ───────────────────────────────────────────────────────

    @property
    def item_count(self) -> int:
        return len(self._item_effects)

    @property
    def ability_count(self) -> int:
        return len(self._ability_effects)

    @property
    def move_count(self) -> int:
        return len(self._move_effects)

    @property
    def total_count(self) -> int:
        return self.item_count + self.ability_count + self.move_count

    def summary(self) -> str:
        return (
            f"AttributeFactory: {self.item_count} items, "
            f"{self.ability_count} abilities, {self.move_count} moves"
        )

    def __repr__(self) -> str:
        return self.summary()
