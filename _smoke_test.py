import sys
sys.path.insert(0, 'd:/PokeRedus/pokeredus')
import tkinter as tk
from pokeredus.gui.simulator_page import SimulatorPage

class DummyKG:
    def get_set(self, sid): return None
    def get_pokemon(self, pid): return None
    def get_move(self, mid): return None

class DummySim:
    class calc:
        @staticmethod
        def calculate_with_state(*a, **kw): raise Exception('not used')

root = tk.Tk()
root.withdraw()
sim = SimulatorPage(root, kg=DummyKG(), matchup_cache=None, go_home=lambda: None, battle_simulator=DummySim())

phase_methods = [
    '_phase', '_initial_team_a_sets', '_initial_team_b_sets',
    '_update_start_battle_state', '_on_start_battle',
    '_refresh_setup_slots', '_build_setup_body', '_build_simulation_body',
    '_queue_ai_action', '_update_next_turn_button',
]
for m in phase_methods:
    print(f'{m}: exists={hasattr(sim, m)}')

sim._phase = 'simulation'
try:
    sim._build_main_body()
    print(f'After sim phase: _center_step_btn exists={hasattr(sim, "_center_step_btn")}')
    print(f'After sim phase: _queued_lbl exists={hasattr(sim, "_queued_lbl")}')
    if hasattr(sim, '_center_step_btn'):
        btn = sim._center_step_btn
        print(f'Center step btn state: {btn.cget("state")}')
        print(f'Center step btn text: {btn.cget("text")}')
    if hasattr(sim, '_queued_lbl'):
        lbl = sim._queued_lbl
        print(f'Queued lbl text: {lbl.cget("text")}')

    sim._queued_action_a = {"type": "move", "id": "tackle"}
    sim._queued_action_b = {"type": "move", "id": "scratch"}
    sim._update_next_turn_button()
    sim._update_queued_display()
    print(f'After queues: step btn state: {sim._center_step_btn.cget("state")}')
    print(f'After queues: step btn text fg: {sim._center_step_btn.cget("fg")}')
    print(f'After queues: lbl text: {sim._queued_lbl.cget("text")}')
    print(f'After queues: lbl fg: {sim._queued_lbl.cget("fg")}')

except Exception as e:
    import traceback; traceback.print_exc()

print('All checks done')
