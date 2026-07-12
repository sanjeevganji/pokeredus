"""
Common attribute definitions for items, abilities, and moves.

These are pre-defined attributes that can be quickly applied to entities
via the GUI.
"""
from pokeredus.graph.attribute_manager import AttributeDefinition


# Common item attributes
COMMON_ITEM_ATTRIBUTES = {
    "choice_band": AttributeDefinition(
        id="choice_band",
        name="Choice Band",
        type="damage_mod",
        description="Boosts Attack by 1.5x but locks into first move used",
        params={"multiplier": 1.5, "applies_to": "physical", "locks_moves": True},
        tags=["item", "choice", "physical_boost"]
    ),
    "choice_specs": AttributeDefinition(
        id="choice_specs",
        name="Choice Specs",
        type="damage_mod",
        description="Boosts Special Attack by 1.5x but locks into first move used",
        params={"multiplier": 1.5, "applies_to": "special", "locks_moves": True},
        tags=["item", "choice", "special_boost"]
    ),
    "choice_scarf": AttributeDefinition(
        id="choice_scarf",
        name="Choice Scarf",
        type="speed_mod",
        description="Boosts Speed by 1.5x but locks into first move used",
        params={"multiplier": 1.5, "locks_moves": True},
        tags=["item", "choice", "speed_boost"]
    ),
    "life_orb": AttributeDefinition(
        id="life_orb",
        name="Life Orb",
        type="damage_mod",
        description="Boosts all damage by 1.3x but user takes 10% recoil",
        params={"multiplier": 1.3, "applies_to": "all", "recoil": 0.1},
        tags=["item", "damage_boost", "recoil"]
    ),
    "leftovers": AttributeDefinition(
        id="leftovers",
        name="Leftovers",
        type="recovery",
        description="Recovers 1/16 of max HP each turn",
        params={"amount_fraction": 1/16, "trigger": "turn_end"},
        tags=["item", "recovery"]
    ),
    "eviolite": AttributeDefinition(
        id="eviolite",
        name="Eviolite",
        type="damage_mod",
        description="Boosts Defense and Special Defense by 1.5x for NFE Pokémon",
        params={"multiplier": 0.67, "applies_to": "all", "target": "defender", "condition": "not_fully_evolved"},
        tags=["item", "defense_boost"]
    ),
    "assault_vest": AttributeDefinition(
        id="assault_vest",
        name="Assault Vest",
        type="damage_mod",
        description="Boosts Special Defense by 1.5x but prevents status moves",
        params={"multiplier": 0.67, "applies_to": "special", "target": "defender", "prevents_status": True},
        tags=["item", "special_defense_boost"]
    ),
    "rocky_helmet": AttributeDefinition(
        id="rocky_helmet",
        name="Rocky Helmet",
        type="event",
        description="Damages attacker by 1/6 max HP on contact",
        params={"event": "on_hit", "effect_type": "damage", "effect_params": {"amount_fraction": 1/6, "condition": "contact"}, "chance": 1.0, "target": "opponent"},
        tags=["item", "contact_punish"]
    ),
}


# Common ability attributes
COMMON_ABILITY_ATTRIBUTES = {
    "intimidate": AttributeDefinition(
        id="intimidate",
        name="Intimidate",
        type="stat_mod",
        description="Lowers opponent's Attack by 1 stage on switch-in",
        params={"stat": "atk", "stages": -1, "target": "opponent"},
        tags=["ability", "on_switch_in", "stat_drop"]
    ),
    "levitate": AttributeDefinition(
        id="levitate",
        name="Levitate",
        type="immunity",
        description="Immune to Ground-type moves",
        params={"immune_to": ["Ground"], "on_absorb": ""},
        tags=["ability", "immunity", "persistent"]
    ),
    "rough_skin": AttributeDefinition(
        id="rough_skin",
        name="Rough Skin",
        type="event",
        description="Damages attacker by 1/8 max HP on contact",
        params={"event": "on_hit", "effect_type": "damage", "effect_params": {"amount_fraction": 1/8, "condition": "contact"}, "chance": 1.0, "target": "opponent"},
        tags=["ability", "on_contact", "recoil"]
    ),
    "drizzle": AttributeDefinition(
        id="drizzle",
        name="Drizzle",
        type="field",
        description="Sets rain for 5 turns on switch-in",
        params={"field": "rain", "side": "global", "duration": 5, "type_boosts": {"Water": 1.5, "Fire": 0.5}},
        tags=["ability", "weather", "on_switch_in"]
    ),
    "drought": AttributeDefinition(
        id="drought",
        name="Drought",
        type="field",
        description="Sets sun for 5 turns on switch-in",
        params={"field": "sun", "side": "global", "duration": 5, "type_boosts": {"Fire": 1.5, "Water": 0.5}},
        tags=["ability", "weather", "on_switch_in"]
    ),
    "sand_stream": AttributeDefinition(
        id="sand_stream",
        name="Sand Stream",
        type="field",
        description="Sets sandstorm for 5 turns on switch-in",
        params={"field": "sand", "side": "global", "duration": 5, "damage_per_turn": 1/16},
        tags=["ability", "weather", "on_switch_in"]
    ),
    "snow_warning": AttributeDefinition(
        id="snow_warning",
        name="Snow Warning",
        type="field",
        description="Sets hail for 5 turns on switch-in",
        params={"field": "hail", "side": "global", "duration": 5, "damage_per_turn": 1/16},
        tags=["ability", "weather", "on_switch_in"]
    ),
    "adaptability": AttributeDefinition(
        id="adaptability",
        name="Adaptability",
        type="damage_mod",
        description="Boosts STAB multiplier from 1.5x to 2.0x",
        params={"multiplier": 1.33, "applies_to": "stab_only"},
        tags=["ability", "stab_boost"]
    ),
    "guts": AttributeDefinition(
        id="guts",
        name="Guts",
        type="damage_mod",
        description="Boosts Attack by 1.5x when statused",
        params={"multiplier": 1.5, "applies_to": "physical", "condition": "has_status"},
        tags=["ability", "status_exploit"]
    ),
    "chlorophyll": AttributeDefinition(
        id="chlorophyll",
        name="Chlorophyll",
        type="speed_mod",
        description="Doubles Speed in sun",
        params={"multiplier": 2.0, "condition": "weather_sun"},
        tags=["ability", "weather_speed"]
    ),
    "swift_swim": AttributeDefinition(
        id="swift_swim",
        name="Swift Swim",
        type="speed_mod",
        description="Doubles Speed in rain",
        params={"multiplier": 2.0, "condition": "weather_rain"},
        tags=["ability", "weather_speed"]
    ),
    "sand_rush": AttributeDefinition(
        id="sand_rush",
        name="Sand Rush",
        type="speed_mod",
        description="Doubles Speed in sandstorm",
        params={"multiplier": 2.0, "condition": "weather_sand"},
        tags=["ability", "weather_speed"]
    ),
    "slush_rush": AttributeDefinition(
        id="slush_rush",
        name="Slush Rush",
        type="speed_mod",
        description="Doubles Speed in hail",
        params={"multiplier": 2.0, "condition": "weather_hail"},
        tags=["ability", "weather_speed"]
    ),
    "regenerator": AttributeDefinition(
        id="regenerator",
        name="Regenerator",
        type="recovery",
        description="Recovers 1/3 max HP on switch-out",
        params={"amount_fraction": 1/3, "trigger": "switch_out"},
        tags=["ability", "recovery"]
    ),
}


# Common move attributes
COMMON_MOVE_ATTRIBUTES = {
    "swords_dance": AttributeDefinition(
        id="swords_dance",
        name="Swords Dance",
        type="stat_mod",
        description="Raises user's Attack by 2 stages",
        params={"stat": "atk", "stages": 2, "target": "self"},
        tags=["move", "setup", "stat_boost"]
    ),
    "dragon_dance": AttributeDefinition(
        id="dragon_dance",
        name="Dragon Dance",
        type="stat_mod",
        description="Raises user's Attack and Speed by 1 stage each",
        params={"effects": [
            {"stat": "atk", "stages": 1, "target": "self"},
            {"stat": "spe", "stages": 1, "target": "self"}
        ]},
        tags=["move", "setup", "stat_boost"]
    ),
    "nasty_plot": AttributeDefinition(
        id="nasty_plot",
        name="Nasty Plot",
        type="stat_mod",
        description="Raises user's Special Attack by 2 stages",
        params={"stat": "spa", "stages": 2, "target": "self"},
        tags=["move", "setup", "stat_boost"]
    ),
    "calm_mind": AttributeDefinition(
        id="calm_mind",
        name="Calm Mind",
        type="stat_mod",
        description="Raises user's Special Attack and Special Defense by 1 stage each",
        params={"effects": [
            {"stat": "spa", "stages": 1, "target": "self"},
            {"stat": "spd", "stages": 1, "target": "self"}
        ]},
        tags=["move", "setup", "stat_boost"]
    ),
    "will_o_wisp": AttributeDefinition(
        id="will_o_wisp",
        name="Will-O-Wisp",
        type="condition",
        description="Burns the target, dealing 1/16 HP per turn and halving physical damage",
        params={"condition": "burn", "volatile": False, "damage_per_turn": 1/16, "physical_damage_mult": 0.5},
        tags=["move", "status", "burn"]
    ),
    "thunder_wave": AttributeDefinition(
        id="thunder_wave",
        name="Thunder Wave",
        type="condition",
        description="Paralyzes the target, reducing Speed by 75% and causing 25% move failure",
        params={"condition": "paralysis", "volatile": False, "speed_mult": 0.25, "move_fail_chance": 0.25},
        tags=["move", "status", "paralysis"]
    ),
    "toxic": AttributeDefinition(
        id="toxic",
        name="Toxic",
        type="condition",
        description="Badly poisons the target, dealing escalating damage each turn",
        params={"condition": "toxic", "volatile": False, "damage_per_turn": 1/16, "escalating": True},
        tags=["move", "status", "poison"]
    ),
    "stealth_rock": AttributeDefinition(
        id="stealth_rock",
        name="Stealth Rock",
        type="field",
        description="Sets entry hazard that damages opponents on switch-in based on Rock effectiveness",
        params={"field": "stealth_rock", "side": "opponent", "damage_on_switch": "type_effectiveness", "base_damage_fraction": 1/8},
        tags=["move", "hazard", "entry_hazard"]
    ),
    "spikes": AttributeDefinition(
        id="spikes",
        name="Spikes",
        type="field",
        description="Sets entry hazard (up to 3 layers) that damages opponents on switch-in",
        params={"field": "spikes", "side": "opponent", "layers": 1, "max_layers": 3},
        tags=["move", "hazard", "entry_hazard"]
    ),
    "rapid_spin": AttributeDefinition(
        id="rapid_spin",
        name="Rapid Spin",
        type="event",
        description="Removes entry hazards from user's side",
        params={"event": "on_use", "effect_type": "remove_attribute", "effect_params": {"attribute_type": "field", "tag": "hazard", "target": "self_side"}},
        tags=["move", "hazard_removal"]
    ),
    "defog": AttributeDefinition(
        id="defog",
        name="Defog",
        type="event",
        description="Removes entry hazards from both sides",
        params={"event": "on_use", "effect_type": "remove_attribute", "effect_params": {"attribute_type": "field", "tag": "hazard", "target": "both_sides"}},
        tags=["move", "hazard_removal"]
    ),
    "u_turn": AttributeDefinition(
        id="u_turn",
        name="U-turn",
        type="event",
        description="Deals damage then switches user out",
        params={"event": "on_after_move", "effect_type": "switch", "effect_params": {"forced": True}},
        tags=["move", "pivot"]
    ),
    "volt_switch": AttributeDefinition(
        id="volt_switch",
        name="Volt Switch",
        type="event",
        description="Deals damage then switches user out",
        params={"event": "on_after_move", "effect_type": "switch", "effect_params": {"forced": True}},
        tags=["move", "pivot"]
    ),
}


def get_all_common_attributes():
    """Get all common attribute definitions organized by category."""
    return {
        "items": COMMON_ITEM_ATTRIBUTES,
        "abilities": COMMON_ABILITY_ATTRIBUTES,
        "moves": COMMON_MOVE_ATTRIBUTES,
    }
