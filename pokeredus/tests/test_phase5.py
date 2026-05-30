"""Test script for Phase 5: Matchup Analytics & Enhanced Stats."""
import sys, os
sys.path.insert(0, '.')

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, NatureClass, EVSpreadClass,
    AbilityClass, ItemClass, MatchupRelation,
)
from pokeredus.classes.natures import STANDARD_NATURES
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.damage_calc import DamageCalculator
from pokeredus.graph.matchup_engine import compute_matchup, compute_all_matchups
from pokeredus.graph.analytics import (
    compute_set_stats, aggregate_matchups_by_species, rank_sets,
)

# Create test data
kg = KnowledgeGraph()

# Add some test Pokemon
garchomp = PokemonClass(
    id='garchomp', name='Garchomp', types=['Dragon', 'Ground'],
    base_stats={'hp': 108, 'atk': 130, 'def': 95, 'spa': 80, 'spd': 85, 'spe': 102},
    abilities=['sandveil', 'roughskin'], tier='OU',
)
toxapex = PokemonClass(
    id='toxapex', name='Toxapex', types=['Poison', 'Water'],
    base_stats={'hp': 50, 'atk': 63, 'def': 152, 'spa': 53, 'spd': 142, 'spe': 35},
    abilities=['merciless', 'limber'], tier='OU',
)
dragapult = PokemonClass(
    id='dragapult', name='Dragapult', types=['Dragon', 'Ghost'],
    base_stats={'hp': 88, 'atk': 120, 'def': 75, 'spa': 100, 'spd': 75, 'spe': 142},
    abilities=['clearbody', 'infiltrator'], tier='OU',
)

kg.add_pokemon(garchomp)
kg.add_pokemon(toxapex)
kg.add_pokemon(dragapult)

# Add moves
moves = [
    MoveClass(id='earthquake', name='Earthquake', type='Ground', category='Physical', base_power=100, accuracy=100),
    MoveClass(id='swordsdance', name='Swords Dance', type='Normal', category='Status'),
    MoveClass(id='scale_shot', name='Scale Shot', type='Dragon', category='Physical', base_power=25, accuracy=90),
    MoveClass(id='outrage', name='Outrage', type='Dragon', category='Physical', base_power=120, accuracy=100),
    MoveClass(id='shadow_ball', name='Shadow Ball', type='Ghost', category='Special', base_power=80, accuracy=100),
    MoveClass(id='sludge_wave', name='Sludge Wave', type='Poison', category='Special', base_power=95, accuracy=100),
    MoveClass(id='scald', name='Scald', type='Water', category='Special', base_power=80, accuracy=100),
    MoveClass(id='draco_meteor', name='Draco Meteor', type='Dragon', category='Special', base_power=130, accuracy=90),
]
for m in moves:
    kg.add_move(m)

# Add abilities and items
for aid, name in [('sandveil', 'Sand Veil'), ('roughskin', 'Rough Skin'),
                   ('merciless', 'Merciless'), ('limber', 'Limber'),
                   ('clearbody', 'Clear Body'), ('infiltrator', 'Infiltrator')]:
    kg.add_ability(AbilityClass(id=aid, name=name, description=''))

for iid, name in [('loadeddice', 'Loaded Dice'), ('leftovers', 'Leftovers'),
                   ('choicespecs', 'Choice Specs'), ('choicescarf', 'Choice Scarf')]:
    kg.add_item(ItemClass(id=iid, name=name, description=''))

# Add natures
for n in STANDARD_NATURES:
    kg.add_nature(n)

# Create sets
jolly = next(n for n in STANDARD_NATURES if n.name == 'Jolly')
adamant = next(n for n in STANDARD_NATURES if n.name == 'Adamant')
timid = next(n for n in STANDARD_NATURES if n.name == 'Timid')
calm = next(n for n in STANDARD_NATURES if n.name == 'Calm')

garchomp_sd = SetClass(
    id='garchomp_swords_dance', pokemon_id='garchomp', set_name='Swords Dance',
    ability='roughskin', item='loadeddice', nature=jolly,
    evs=EVSpreadClass(atk=252, spd=4, spe=252),
    moves=['swordsdance', 'scale_shot', 'earthquake', 'outrage'],
    role='setup_sweeper',
)
garchomp_scarf = SetClass(
    id='garchomp_choice_scarf', pokemon_id='garchomp', set_name='Choice Scarf',
    ability='roughskin', item='choicescarf', nature=adamant,
    evs=EVSpreadClass(atk=252, spd=4, spe=252),
    moves=['earthquake', 'outrage', 'scale_shot', 'shadow_ball'],
    role='revenge_killer',
)

toxapex_spdef = SetClass(
    id='toxapex_spdef', pokemon_id='toxapex', set_name='Specially Defensive',
    ability='merciless', item='leftovers', nature=calm,
    evs=EVSpreadClass(hp=252, spa=4, spd=252),
    moves=['scald', 'sludge_wave', 'scald', 'scald'],
    role='wall',
)

dragapult_specs = SetClass(
    id='dragapult_choice_specs', pokemon_id='dragapult', set_name='Choice Specs',
    ability='infiltrator', item='choicespecs', nature=timid,
    evs=EVSpreadClass(spa=252, spd=4, spe=252),
    moves=['shadow_ball', 'shadow_ball', 'draco_meteor', 'shadow_ball'],
    role='sweeper',
)

for s in [garchomp_sd, garchomp_scarf, toxapex_spdef, dragapult_specs]:
    kg.add_set(s)

print(f'Graph: {kg.summary()}')
print()

# Test stat computation
stats = compute_set_stats(kg, garchomp_sd, level=100)
print(f'Garchomp SD stats at Lv.100:')
print(f'  HP:{stats.hp} Atk:{stats.atk} Def:{stats.def_} SpA:{stats.spa} SpD:{stats.spd} Spe:{stats.spe}')
print(f'  BST: {stats.bst}')
print()

# Test damage calculator
calc = DamageCalculator()
result = calc.calculate(garchomp_sd, toxapex_spdef, kg.get_move('earthquake'), kg, level=100)
print(f'Garchomp SD Earthquake vs Toxapex:')
print(f'  Damage: {result.final_damage} (base:{result.base_damage}, stab:{result.stab_mult}, eff:{result.type_effectiveness})')
print(f'  Toxapex HP: {result.effective_hp}')
print(f'  TTK: {result.turns_to_kill}')
print()

# Test matchup computation
mu = compute_matchup(garchomp_sd, toxapex_spdef, kg, calc)
print(f'Garchomp SD vs Toxapex SpDef:')
print(f'  Score: {mu.score:+.4f}  Category: {mu.category}')
print(f'  TTK A->B: {mu.turns_to_kill_a}  TTK B->A: {mu.turns_to_kill_b}')
print(f'  Speed: {mu.speed_advantage}  Tags: {mu.tags}')
print(f'  Best move A: {mu.best_move_a_id}  Best move B: {mu.best_move_b_id}')
print(f'  Damage A->B: {mu.damage_a_to_b}  Damage B->A: {mu.damage_b_to_a}')
print()

# Compute all matchups
count = compute_all_matchups(kg, calc)
print(f'Computed {count} matchup edges')
print()

# Test analytics
print('Garchomp SD vs all species (offense):')
offense = aggregate_matchups_by_species(kg, 'garchomp_swords_dance', direction='offense')
for m in offense:
    print(f'  {m.pokemon_name} ({m.repr_set_name}): score={m.score:+.2f}, '
          f'TTK->{m.turns_to_kill_them} TTK<-{m.turns_to_kill_us}, '
          f'speed:{m.speed_advantage}, cat:{m.category}')

print()
print('Garchomp SD vs all species (defense):')
defense = aggregate_matchups_by_species(kg, 'garchomp_swords_dance', direction='defense')
for m in defense:
    print(f'  {m.pokemon_name} ({m.repr_set_name}): score={m.score:+.2f}, '
          f'TTK->{m.turns_to_kill_them} TTK<-{m.turns_to_kill_us}, '
          f'speed:{m.speed_advantage}, cat:{m.category}')

print()
rankings = rank_sets(kg, calc)
print('Set Rankings (MCTS-style):')
for r in rankings:
    print(f'  {r.pokemon_id}/{r.set_name}: score={r.composite_score:.4f}, '
          f'win_rate={r.win_rate:.2f}, avg_ttk_against={r.mean_ttk_against:.1f}, '
          f'speed_rate={r.speed_advantage_rate:.2f}')

# Test serialization round-trip
mu_dict = mu.to_dict()
mu_restored = MatchupRelation.from_dict(mu_dict)
assert mu_restored.turns_to_kill_a == mu.turns_to_kill_a
assert mu_restored.speed_advantage == mu.speed_advantage
assert mu_restored.best_move_a_id == mu.best_move_a_id
print()
print('OK: Serialization round-trip verified')

print()
print('ALL FUNCTIONAL TESTS PASSED')
