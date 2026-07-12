// decide.ts — wire the runtime engine to the bridge.
//
// On each `|request|` the CLI builds a TurnState (via BattleTracker) and calls
// `decideAndAct`. It scores the turn, logs the top-3 actions with reasoning
// (the human-tuning audit trail), and posts the chosen move back over the
// client — unless `biases.dry_run` is set, in which case it only logs.
import type { TurnState, Action } from '../engine/state.js';
import type { PackIndex } from '../pack/index.js';
import type { Biases } from '../biases/schema.js';
import { scoreTurn, type ScoredAction } from '../engine/scorer.js';

/** Minimal client surface decide.ts needs (satisfied by ShowdownClient). */
export interface DecideClient {
  send(msg: string): void;
}

/**
 * Score the turn and act on it. Returns the full ranked list. When
 * `biases.dry_run` is true, the chosen command is logged but not sent.
 */
export function decideAndAct(client: DecideClient, state: TurnState, pack: PackIndex, biases: Biases): ScoredAction[] {
  const scored = scoreTurn(state, pack, biases);

  const top = scored.slice(0, 3);
  for (let i = 0; i < top.length; i++) {
    const a = top[i]!;
    const label = formatAction(a.action);
    const reason = a.reasoning.slice(0, 4).join(', ');
    console.log(`[#${i + 1}] ${label}  score=${a.score.toFixed(2)}  (${reason})`);
  }

  const best = scored[0];
  if (!best) {
    console.warn('[pokelink] no legal actions this turn');
    return scored;
  }

  const cmd = formatChoice(best.action);
  if (biases.dry_run) {
    console.log(`[dry-run] would send: ${cmd}`);
  } else {
    client.send(cmd);
  }
  return scored;
}

function formatAction(a: Action): string {
  if (a.type === 'move') return `move:${a.moveId}${a.tera ? ' (tera)' : ''}`;
  if (a.type === 'switch') return `switch:${a.slot! + 1}`;
  return a.type;
}

/** Format a Showdown `|/choose` command for an action. */
export function formatChoice(a: Action): string {
  if (a.type === 'move') return `|/choose move ${a.moveId}${a.tera ? ' tera' : ''}`;
  if (a.type === 'switch') return `|/choose switch ${(a.slot ?? 0) + 1}`;
  return `|/choose ${a.type} ${a.moveId ?? a.slot}`;
}
