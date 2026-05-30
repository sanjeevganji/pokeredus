"""Tests for PokemonClass dataclass, focusing on serialization round-trip."""
from pokeredus.classes.pokemon import PokemonClass


class TestPokemonClassPrimarySetId:
    """Verify primary_set_id field behavior."""

    def test_default_value_is_empty_string(self):
        """Newly created PokemonClass should have primary_set_id == ''."""
        p = PokemonClass(id="garchomp", name="Garchomp")
        assert p.primary_set_id == ""

    def test_round_trip_preserves_primary_set_id(self):
        """Setting primary_set_id survives to_dict -> from_dict round-trip."""
        p = PokemonClass(id="garchomp", name="Garchomp")
        p.primary_set_id = "garchomp-scarf-offense"
        d = p.to_dict()
        assert d["primary_set_id"] == "garchomp-scarf-offense"
        p2 = PokemonClass.from_dict(d)
        assert p2.primary_set_id == "garchomp-scarf-offense"

    def test_round_trip_default_empty_string(self):
        """Default empty string also survives round-trip."""
        p = PokemonClass(id="toxapex", name="Toxapex")
        d = p.to_dict()
        p2 = PokemonClass.from_dict(d)
        assert p2.primary_set_id == ""

    def test_from_dict_without_key_uses_default(self):
        """Legacy data without primary_set_id key should default to ''."""
        legacy = {"id": "dragapult", "name": "Dragapult"}
        p = PokemonClass.from_dict(legacy)
        assert p.primary_set_id == ""
