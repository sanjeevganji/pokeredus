// Action space generator — produce legal {move, switch} actions per turn.
// Mirrors the action model in pokeredus/unified/__init__.py UnifiedAction.
import type { TurnState, Action, ActiveMon } from './state.js';
import type { PackIndex } from '../pack/index.js';

/**
 * Given a TurnState and the Knowledge Pack, emit all legal actions.
 * Respects: 0 PP, Taunt (blocks non-damaging moves), Choice item lock,
 * fainted bench members, and Terastallize availability.
 */
export function enumerateActions(state: TurnState, pack: PackIndex): Action[] {
  const actions: Action[] = [];

  // ── Move actions ──────────────────────────────────────────────────
  const active = state.myActive;
  const set = pack.getSet(active.setId);
  if (set && !active.fainted) {
    const choiceLocked = active.choiceLock !== undefined && active.choiceLock !== '';
    for (const moveId of set.moves) {
      const move = pack.getMove(moveId);
      // Choice lock: only the locked move is legal
      if (choiceLocked && moveId !== active.choiceLock) continue;

      // 0 PP moves are unusable
      const pp = active.pp[moveId] ?? 1; // default nonzero if not tracked
      if (pp <= 0) continue;

      // Taunt blocks non-damaging (Status) moves
      if (active.tauntTurns > 0 && move && move.category === 'Status') continue;

      actions.push({ type: 'move', moveId, tera: false });

      // Terastallize variant (if Tera hasn't been used)
      if (!state.teraUsed) {
        actions.push({ type: 'move', moveId, tera: true });
      }
    }
  }

  // ── Switch actions ───────────────────────────────────────────────
  for (let i = 0; i < state.myBench.length; i++) {
    const mon = state.myBench[i]!;
    if (mon.fainted) continue;
    actions.push({ type: 'switch', slot: i });
  }

  return actions;
}
