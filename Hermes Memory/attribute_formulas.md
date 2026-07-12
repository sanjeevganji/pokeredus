# Attribute Dynamic Formulas
# ============================
# Each sector is calculated using a formula based on raw Pokemon/Set data.
# Variable names available:
# - Stats: hp, atk, def, spa, spd, spe (base or effective)
# - Set: moves (list of IDs), item, ability
# - Pokemon: weight, bst, is_legendary, etc.

# Formula format:
# sector_name:
#   formula: "expression"
#   vars:
#     var_name: { lower: 0, upper: 100 }  # Used to normalize the var to 0-1 before formula
#   scale: { lower: 0, upper: 100 }       # Final result clamped and scaled to this range

attack:
  formula: "(eff_atk * 0.6 + eff_spa * 0.4)"
  vars:
    eff_atk: { lower: 50, upper: 400 }
    eff_spa: { lower: 50, upper: 400 }
  scale: { lower: 0, upper: 100 }

utility:
  formula: "(eff_hp * 0.3 + (support_moves * 20))"
  vars:
    eff_hp: { lower: 100, upper: 400 }
    support_moves: { lower: 0, upper: 4 }
  scale: { lower: 0, upper: 100 }

defense:
  formula: "(eff_def * 0.5 + eff_spd * 0.5)"
  vars:
    eff_def: { lower: 50, upper: 400 }
    eff_spd: { lower: 50, upper: 400 }
  scale: { lower: 0, upper: 100 }

speed:
  formula: "eff_spe"
  vars:
    eff_spe: { lower: 50, upper: 400 }
  scale: { lower: 0, upper: 100 }

threat:
  formula: "(eff_atk * 0.7 + eff_spe * 0.3 + (boost_moves * 15))"
  vars:
    eff_atk: { lower: 50, upper: 400 }
    eff_spe: { lower: 50, upper: 400 }
    boost_moves: { lower: 0, upper: 2 }
  scale: { lower: 0, upper: 100 }

punish:
  formula: "(eff_spe * 0.6 + (pivot_moves * 25))"
  vars:
    eff_spe: { lower: 50, upper: 400 }
    pivot_moves: { lower: 0, upper: 3 }
  scale: { lower: 0, upper: 100 }

sponge:
  formula: "(eff_hp * 0.5 + eff_def * 0.2 + eff_spd * 0.2 + (recovery_moves * 20))"
  vars:
    eff_hp: { lower: 100, upper: 400 }
    eff_def: { lower: 50, upper: 400 }
    eff_spd: { lower: 50, upper: 400 }
    recovery_moves: { lower: 0, upper: 2 }
  scale: { lower: 0, upper: 100 }

counter:
  formula: "(eff_def * 0.4 + eff_spd * 0.3 + (priority_moves * 30))"
  vars:
    eff_def: { lower: 50, upper: 400 }
    eff_spd: { lower: 50, upper: 400 }
    priority_moves: { lower: 0, upper: 3 }
  scale: { lower: 0, upper: 100 }
