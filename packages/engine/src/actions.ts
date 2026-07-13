import type { TurnState, Action } from './state.js';
import type { PackIndex } from '@pokeredus/pack';

export function enumerateActions(state: TurnState, pack: PackIndex): Action[] {
  const actions: Action[] = [];
  const active = state.myActive;
  const set = pack.getSet(active.setId);
  if (set && !active.fainted) {
    const choiceLocked = active.choiceLock !== undefined && active.choiceLock !== '';
    for (const moveId of set.moves) {
      const move = pack.getMove(moveId);
      if (choiceLocked && moveId !== active.choiceLock) continue;
      const pp = active.pp[moveId] ?? 1;
      if (pp <= 0) continue;
      if (active.tauntTurns > 0 && move && move.category === 'Status') continue;
      actions.push({ type: 'move', moveId, tera: false });
      if (!state.teraUsed) {
        actions.push({ type: 'move', moveId, tera: true });
      }
    }
  }
  for (let i = 0; i < state.myBench.length; i++) {
    const mon = state.myBench[i]!;
    if (mon.fainted) continue;
    actions.push({ type: 'switch', slot: i });
  }
  return actions;
}
