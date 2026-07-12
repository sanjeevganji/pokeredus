"""
Attribute manager for items, abilities, and moves.

Loads, saves, and manages attribute definitions that modify battle calculations.
Persists attributes to JSON files for permanent storage.
"""
import json
from pathlib import Path
from typing import Optional, Dict, List, Any
from dataclasses import dataclass, field, asdict

from pokeredus.config import DATA_DIR


@dataclass
class AttributeDefinition:
    """Definition of an attribute that modifies battle behavior."""
    id: str  # unique identifier
    name: str  # display name
    type: str  # stat_mod, damage_mod, speed_mod, condition, field, event, immunity, recovery
    description: str = ""
    params: Dict[str, Any] = field(default_factory=dict)
    tags: List[str] = field(default_factory=list)
    
    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> 'AttributeDefinition':
        return cls(**data)


class AttributeManager:
    """Manages attribute definitions for items, abilities, and moves."""
    
    def __init__(self, data_dir: Path = DATA_DIR):
        self.data_dir = Path(data_dir)
        self.effects_dir = self.data_dir / "effects"
        self.effects_dir.mkdir(parents=True, exist_ok=True)
        
        # Separate registries for each type
        self.item_attributes: Dict[str, List[AttributeDefinition]] = {}
        self.ability_attributes: Dict[str, List[AttributeDefinition]] = {}
        self.move_attributes: Dict[str, List[AttributeDefinition]] = {}
        
        # Load existing attributes
        self._load_all()
    
    def _load_all(self):
        """Load all attribute definitions from disk."""
        self._load_attributes("items", self.item_attributes)
        self._load_attributes("abilities", self.ability_attributes)
        self._load_attributes("moves", self.move_attributes)
    
    def _load_attributes(self, category: str, registry: Dict[str, List[AttributeDefinition]]):
        """Load attributes for a specific category from JSON."""
        file_path = self.effects_dir / f"{category}_attributes.json"
        if not file_path.exists():
            return
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            for entity_id, attrs_data in data.items():
                registry[entity_id] = [
                    AttributeDefinition.from_dict(attr) for attr in attrs_data
                ]
        except (json.JSONDecodeError, KeyError, TypeError) as e:
            print(f"Warning: Failed to load {category} attributes: {e}")
    
    def _save_attributes(self, category: str, registry: Dict[str, List[AttributeDefinition]]):
        """Save attributes for a specific category to JSON."""
        file_path = self.effects_dir / f"{category}_attributes.json"
        
        data = {
            entity_id: [attr.to_dict() for attr in attrs]
            for entity_id, attrs in registry.items()
        }
        
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    
    # Item attributes
    def get_item_attributes(self, item_id: str) -> List[AttributeDefinition]:
        """Get all attributes for an item."""
        return self.item_attributes.get(item_id, [])
    
    def set_item_attributes(self, item_id: str, attributes: List[AttributeDefinition]):
        """Set attributes for an item and save to disk."""
        if attributes:
            self.item_attributes[item_id] = attributes
        else:
            self.item_attributes.pop(item_id, None)
        self._save_attributes("items", self.item_attributes)
    
    def add_item_attribute(self, item_id: str, attribute: AttributeDefinition):
        """Add an attribute to an item."""
        if item_id not in self.item_attributes:
            self.item_attributes[item_id] = []
        self.item_attributes[item_id].append(attribute)
        self._save_attributes("items", self.item_attributes)
    
    def remove_item_attribute(self, item_id: str, attribute_id: str):
        """Remove an attribute from an item."""
        if item_id in self.item_attributes:
            self.item_attributes[item_id] = [
                attr for attr in self.item_attributes[item_id]
                if attr.id != attribute_id
            ]
            if not self.item_attributes[item_id]:
                del self.item_attributes[item_id]
            self._save_attributes("items", self.item_attributes)
    
    # Ability attributes
    def get_ability_attributes(self, ability_id: str) -> List[AttributeDefinition]:
        """Get all attributes for an ability."""
        return self.ability_attributes.get(ability_id, [])
    
    def set_ability_attributes(self, ability_id: str, attributes: List[AttributeDefinition]):
        """Set attributes for an ability and save to disk."""
        if attributes:
            self.ability_attributes[ability_id] = attributes
        else:
            self.ability_attributes.pop(ability_id, None)
        self._save_attributes("abilities", self.ability_attributes)
    
    def add_ability_attribute(self, ability_id: str, attribute: AttributeDefinition):
        """Add an attribute to an ability."""
        if ability_id not in self.ability_attributes:
            self.ability_attributes[ability_id] = []
        self.ability_attributes[ability_id].append(attribute)
        self._save_attributes("abilities", self.ability_attributes)
    
    def remove_ability_attribute(self, ability_id: str, attribute_id: str):
        """Remove an attribute from an ability."""
        if ability_id in self.ability_attributes:
            self.ability_attributes[ability_id] = [
                attr for attr in self.ability_attributes[ability_id]
                if attr.id != attribute_id
            ]
            if not self.ability_attributes[ability_id]:
                del self.ability_attributes[ability_id]
            self._save_attributes("abilities", self.ability_attributes)
    
    # Move attributes
    def get_move_attributes(self, move_id: str) -> List[AttributeDefinition]:
        """Get all attributes for a move."""
        return self.move_attributes.get(move_id, [])
    
    def set_move_attributes(self, move_id: str, attributes: List[AttributeDefinition]):
        """Set attributes for a move and save to disk."""
        if attributes:
            self.move_attributes[move_id] = attributes
        else:
            self.move_attributes.pop(move_id, None)
        self._save_attributes("moves", self.move_attributes)
    
    def add_move_attribute(self, move_id: str, attribute: AttributeDefinition):
        """Add an attribute to a move."""
        if move_id not in self.move_attributes:
            self.move_attributes[move_id] = []
        self.move_attributes[move_id].append(attribute)
        self._save_attributes("moves", self.move_attributes)
    
    def remove_move_attribute(self, move_id: str, attribute_id: str):
        """Remove an attribute from a move."""
        if move_id in self.move_attributes:
            self.move_attributes[move_id] = [
                attr for attr in self.move_attributes[move_id]
                if attr.id != attribute_id
            ]
            if not self.move_attributes[move_id]:
                del self.move_attributes[move_id]
            self._save_attributes("moves", self.move_attributes)
    
    # Utility methods
    def get_all_items_with_attributes(self) -> List[str]:
        """Get all item IDs that have attributes."""
        return list(self.item_attributes.keys())
    
    def get_all_abilities_with_attributes(self) -> List[str]:
        """Get all ability IDs that have attributes."""
        return list(self.ability_attributes.keys())
    
    def get_all_moves_with_attributes(self) -> List[str]:
        """Get all move IDs that have attributes."""
        return list(self.move_attributes.keys())
    
    def clear_all(self):
        """Clear all attributes (use with caution)."""
        self.item_attributes.clear()
        self.ability_attributes.clear()
        self.move_attributes.clear()
        self._save_attributes("items", self.item_attributes)
        self._save_attributes("abilities", self.ability_attributes)
        self._save_attributes("moves", self.move_attributes)
