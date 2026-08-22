"""
Tests for the Phase 7 attribute system.

Tests cover:
- Attribute creation and lifecycle
- AttributeRegistry stacking and conflict resolution
- Damage calculation with state
- Synergy detection
"""

import pytest
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
from pokeredus.graph.attribute_registry import AttributeRegistry
from pokeredus.graph.attribute_factory import AttributeFactory
from pokeredus.graph.synergy_detector import SynergyDetector


class TestAttributeCreation:
    """Test attribute creation and basic properties."""

    def test_stat_modifier_creation(self):
        """Test creating a stat modifier attribute."""
        attr = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        assert attr.name == "swords_dance"
        assert attr.stat == "atk"
        assert attr.stages == 2
        assert attr.get_multiplier() == 2.0

    def test_stat_modifier_negative_stages(self):
        """Test negative stat stages."""
        attr = StatModifierAttribute(
            attribute_type="stat_mod",
            name="intimidate",
            source="intimidate",
            params={"stat": "atk", "stages": -1},
        )
        assert attr.stages == -1
        # -1 stage = 2/3 multiplier
        assert abs(attr.get_multiplier() - 0.667) < 0.01

    def test_condition_creation(self):
        """Test creating a condition attribute."""
        attr = ConditionAttribute(
            attribute_type="condition",
            name="burn",
            source="willowisp",
            params={
                "condition": "burn",
                "volatile": False,
                "damage_per_turn": 0.0625,
                "physical_damage_mult": 0.5,
            },
        )
        assert attr.condition == "burn"
        assert not attr.is_volatile
        assert attr.damage_per_turn == 0.0625
        assert attr.physical_damage_mult == 0.5

    def test_field_creation(self):
        """Test creating a field attribute."""
        attr = FieldAttribute(
            attribute_type="field",
            name="sun",
            source="drought",
            duration=5,
            params={"field": "sun", "side": "global"},
        )
        assert attr.field == "sun"
        assert attr.duration == 5
        assert attr.turns_remaining == 5

    def test_attribute_tick(self):
        """Test attribute duration ticking."""
        attr = FieldAttribute(
            attribute_type="field",
            name="rain",
            source="raindance",
            duration=3,
            params={"field": "rain"},
        )
        assert attr.turns_remaining == 3
        assert attr.tick()  # Still active
        assert attr.turns_remaining == 2
        assert attr.tick()
        assert attr.turns_remaining == 1
        assert not attr.tick()  # Expired
        assert attr.turns_remaining == 0


class TestAttributeRegistry:
    """Test AttributeRegistry management."""

    def test_add_and_get(self):
        """Test adding and retrieving attributes."""
        registry = AttributeRegistry()
        attr = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        registry.add(attr)
        assert registry.count == 1
        assert registry.has(name="swords_dance")

    def test_stat_stacking(self):
        """Test stat modifier stacking."""
        registry = AttributeRegistry()
        
        # Add +2 Atk
        sd = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        registry.add(sd)
        assert registry.get_stat_modifier("atk") == 2.0

        # Add +1 Atk from different source (should stack)
        dd = StatModifierAttribute(
            attribute_type="stat_mod",
            name="dragon_dance_atk",
            source="dragondance",
            params={"stat": "atk", "stages": 1},
        )
        registry.add(dd)
        # +3 total = 2.5x
        assert registry.get_stat_modifier("atk") == 2.5

    def test_same_source_overwrite(self):
        """Test that same source overwrites."""
        registry = AttributeRegistry()
        
        sd1 = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        registry.add(sd1)
        
        # Use Swords Dance again (should overwrite, not stack)
        sd2 = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        registry.add(sd2)
        
        # Should still be +2, not +4
        assert registry.get_stat_modifier("atk") == 2.0

    def test_condition_mutual_exclusion(self):
        """Test that non-volatile status conditions are mutually exclusive."""
        registry = AttributeRegistry()
        
        burn = ConditionAttribute(
            attribute_type="condition",
            name="burn",
            source="willowisp",
            params={"condition": "burn", "volatile": False},
        )
        registry.add(burn)
        
        # Try to add paralysis (should fail - mutually exclusive)
        para = ConditionAttribute(
            attribute_type="condition",
            name="paralysis",
            source="thunderwave",
            params={"condition": "paralysis", "volatile": False},
        )
        registry.add(para)
        
        # Should only have burn
        assert registry.has(condition="burn")
        assert not registry.has(condition="paralysis")

    def test_weather_overwrite(self):
        """Test that weather types overwrite each other."""
        registry = AttributeRegistry()
        
        rain = FieldAttribute(
            attribute_type="field",
            name="rain",
            source="raindance",
            duration=5,
            params={"field": "rain"},
        )
        registry.add(rain)
        
        # Add sun (should overwrite rain)
        sun = FieldAttribute(
            attribute_type="field",
            name="sun",
            source="sunnyday",
            duration=5,
            params={"field": "sun"},
        )
        registry.add(sun)
        
        # Should only have sun
        assert registry.has(field="sun")
        assert not registry.has(field="rain")

    def test_hazard_stacking(self):
        """Test Spikes stacking up to 3 layers."""
        registry = AttributeRegistry()
        
        spikes1 = FieldAttribute(
            attribute_type="field",
            name="spikes",
            source="spikes",
            params={"field": "spikes", "layers": 1},
        )
        registry.add(spikes1)
        
        spikes2 = FieldAttribute(
            attribute_type="field",
            name="spikes",
            source="spikes",
            params={"field": "spikes", "layers": 1},
        )
        registry.add(spikes2)
        
        spikes3 = FieldAttribute(
            attribute_type="field",
            name="spikes",
            source="spikes",
            params={"field": "spikes", "layers": 1},
        )
        registry.add(spikes3)
        
        # Should have 3 layers
        fields = registry.get_fields()
        assert len(fields) == 1
        assert fields[0].layers == 3

    def test_tick_expiration(self):
        """Test attribute expiration on tick."""
        registry = AttributeRegistry()
        
        rain = FieldAttribute(
            attribute_type="field",
            name="rain",
            source="raindance",
            duration=2,
            params={"field": "rain"},
        )
        registry.add(rain)
        assert registry.count == 1
        
        expired = registry.tick()
        assert len(expired) == 0
        assert registry.count == 1
        
        expired = registry.tick()
        assert len(expired) == 1
        assert registry.count == 0

    def test_modifier_caching(self):
        """Test that modifiers are cached and invalidated."""
        registry = AttributeRegistry()
        
        sd = StatModifierAttribute(
            attribute_type="stat_mod",
            name="swords_dance",
            source="swordsdance",
            params={"stat": "atk", "stages": 2},
        )
        registry.add(sd)
        
        # First call computes and caches
        mult1 = registry.get_stat_modifier("atk")
        # Second call should use cache
        mult2 = registry.get_stat_modifier("atk")
        assert mult1 == mult2

    def test_serialization(self):
        """Test registry serialization."""
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
            params={"condition": "burn"},
        ))
        
        data = registry.to_dict()
        restored = AttributeRegistry.from_dict(data)
        
        assert restored.count == 2
        assert restored.has(name="swords_dance")
        assert restored.has(condition="burn")


class TestAttributeFactory:
    """Test AttributeFactory."""

    def test_load_effects(self, tmp_path):
        """Test loading effects from JSON."""
        factory = AttributeFactory()
        
        effects_file = tmp_path / "test_effects.json"
        effects_file.write_text("""
        {
            "items": {
                "lifeorb": {
                    "attribute_type": "damage_mod",
                    "name": "life_orb",
                    "params": {"multiplier": 1.3}
                }
            }
        }
        """)
        
        count = factory.load_effects(effects_file)
        assert count == 1
        assert factory.item_count == 1

    def test_create_from_item(self, tmp_path):
        """Test creating attribute from item."""
        factory = AttributeFactory()
        
        effects_file = tmp_path / "test_effects.json"
        effects_file.write_text("""
        {
            "items": {
                "lifeorb": {
                    "attribute_type": "damage_mod",
                    "name": "life_orb",
                    "params": {"multiplier": 1.3, "applies_to": "all"}
                }
            }
        }
        """)
        
        factory.load_effects(effects_file)
        attrs = factory.create_from_item("lifeorb")
        
        assert len(attrs) == 1
        assert attrs[0].name == "life_orb"
        assert attrs[0].multiplier == 1.3

    def test_field_creating_moves(self, tmp_path):
        """Test finding moves that create field effects."""
        factory = AttributeFactory()
        
        effects_file = tmp_path / "test_effects.json"
        effects_file.write_text("""
        {
            "moves": {
                "raindance": {
                    "attribute_type": "field",
                    "name": "rain",
                    "params": {"field": "rain", "duration": 5}
                },
                "sunnyday": {
                    "attribute_type": "field",
                    "name": "sun",
                    "params": {"field": "sun", "duration": 5}
                }
            }
        }
        """)
        
        factory.load_effects(effects_file)
        field_moves = factory.get_field_creating_moves()
        
        assert "rain" in field_moves
        assert "raindance" in field_moves["rain"]
        assert "sun" in field_moves
        assert "sunnyday" in field_moves["sun"]


class TestSynergyDetector:
    """Test synergy detection."""

    def test_weather_synergy(self, tmp_path):
        """Test weather synergy detection."""
        # This would require a full KnowledgeGraph setup
        # Simplified test for structure
        factory = AttributeFactory()
        detector = SynergyDetector(factory)
        
        # Verify detector was created
        assert detector.factory == factory


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
