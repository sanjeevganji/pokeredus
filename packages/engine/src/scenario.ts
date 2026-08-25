import type { BattleObservation, LegalAction, RoundEvaluation, SlotSnapshot } from './observation.js';
import { actionId, observationTera } from './observation.js';
import { sampleAction, type QuantumPolicyProcess } from './policy.js';
import { evaluateRound, theirActions, type EvaluateOptions } from './evaluate.js';
import { simulateRound } from './sim.js';

export function legalFromSlots(ours: SlotSnapshot[]): LegalAction[] {
  const active = ours.find((s) => s.active) ?? ours[0];
  const moves = (active?.knownMoves ?? []).map((moveId) => ({
    id: actionId({ type: 'move', moveId }),
    type: 'move' as const,
    moveId,
  }));
  const switches = ours
    .filter((s) => !s.active && !s.fainted && s.revealed)
    .map((s) => ({
      id: actionId({ type: 'switch', slot: s.slot + 1 }),
      type: 'switch' as const,
      slot: s.slot + 1,
    }));
  if (moves.length) return [...moves, ...switches];
  if (switches.length) return switches;
  return [{ id: 'move:splash', type: 'move', moveId: 'splash' }];
}

export function flipObservation(obs: BattleObservation): BattleObservation {
  const legal = theirActions(obs, obs.theirs.find((s) => s.active)?.set ?? obs.theirs.find((s) => s.active)?.hypotheses[0]?.set);
  const tera = observationTera(obs);
  return {
    ...obs,
    ourSide: obs.ourSide === 'p1' ? 'p2' : 'p1',
    ours: obs.theirs.map((s) => ({ ...s })),
    theirs: obs.ours.map((s) => ({ ...s })),
    legalActions: legal,
    teraUsedOurs: tera.theirs,
    teraUsedTheirs: tera.ours,
  };
}

function ended(ours: SlotSnapshot[], theirs: SlotSnapshot[]): 'win' | 'loss' | null {
  if (theirs.every((s) => s.fainted || s.hp <= 0)) return 'win';
  if (ours.every((s) => s.fainted || s.hp <= 0)) return 'loss';
  return null;
}

function pickReply(ev: RoundEvaluation, rng: () => number): LegalAction {
  const ids = ev.replies.map((r) => r.action.id);
  if (!ids.length) return { id: 'move:splash', type: 'move', moveId: 'splash' };
  const probs = ev.replies.map((r) => r.probability ?? 0);
  const sum = probs.reduce((a, b) => a + b, 0);
  const id = sum > 0 ? sampleAction(ids, probs, rng) : ids[0]!;
  return ev.replies.find((r) => r.action.id === id)?.action ?? ev.replies[0]!.action;
}

export function applySimResult(obs: BattleObservation, afterOurs: SlotSnapshot[], afterTheirs: SlotSnapshot[]): BattleObservation {
  return {
    ...obs,
    turn: obs.turn + 1,
    ours: afterOurs,
    theirs: afterTheirs,
    legalActions: legalFromSlots(afterOurs),
  };
}

export interface PlayTurnResult {
  observation: BattleObservation;
  sampledOpp: string;
  weWin: boolean;
  theyWin: boolean;
}

export async function playTurn(
  obs: BattleObservation,
  actionIdOrAction: string | LegalAction,
  facing: 'ours' | 'theirs',
  opts?: EvaluateOptions & { rng?: () => number; evaluation?: RoundEvaluation },
): Promise<PlayTurnResult> {
  const view = facing === 'theirs' ? flipObservation(obs) : obs;
  const ev = opts?.evaluation && facing === 'ours'
    ? opts.evaluation
    : await evaluateRound(view, opts);
  const wantId = typeof actionIdOrAction === 'string' ? actionIdOrAction : actionIdOrAction.id;
  const human = ev.choices.find((c) => c.action.id === wantId) ?? ev.choices[0];
  if (!human) throw new Error('no legal action to play');
  const rng = opts?.rng ?? Math.random;
  const opp = pickReply(ev, rng);
  const result = simulateRound(view, human.action, opp, [1, 2, 3, 4]);
  const nextView = applySimResult(view, result.afterOurs, result.afterTheirs);
  const next = facing === 'theirs' ? flipObservation(nextView) : nextView;
  return {
    observation: next,
    sampledOpp: opp.id,
    weWin: facing === 'theirs' ? result.theyWin : result.weWin,
    theyWin: facing === 'theirs' ? result.weWin : result.theyWin,
  };
}

export interface WinrateResult {
  wins: number;
  losses: number;
  draws: number;
  n: number;
  avgTurns: number;
}

export async function estimateWinrate(
  obs: BattleObservation,
  opts?: EvaluateOptions & { n?: number; maxTurns?: number; rng?: () => number },
): Promise<WinrateResult> {
  const n = opts?.n ?? 16;
  const maxTurns = opts?.maxTurns ?? 12;
  const rng = opts?.rng ?? Math.random;
  const evalOpts: EvaluateOptions = { ...opts, chanceSeeds: opts?.chanceSeeds ?? 1, refine: undefined };
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let turnSum = 0;
  for (let i = 0; i < n; i++) {
    let state = obs;
    let turns = 0;
    let terminal: 'win' | 'loss' | null = ended(state.ours, state.theirs);
    while (!terminal && turns < maxTurns) {
      const ev = await evaluateRound(state, evalOpts);
      if (!ev.choices.length) break;
      const ourIds = ev.choices.map((c) => c.action.id);
      const ourP = ev.choices.map((c) => c.probability ?? 0);
      const ourSum = ourP.reduce((a, b) => a + b, 0);
      const ourId = ourSum > 0 ? sampleAction(ourIds, ourP, rng) : ourIds[0]!;
      const our = ev.choices.find((c) => c.action.id === ourId)!.action;
      const opp = pickReply(ev, rng);
      const result = simulateRound(state, our, opp, [1 + (i % 4), 2, 3, 4]);
      turns += 1;
      if (result.weWin) { terminal = 'win'; break; }
      if (result.theyWin) { terminal = 'loss'; break; }
      state = applySimResult(state, result.afterOurs, result.afterTheirs);
      terminal = ended(state.ours, state.theirs);
    }
    turnSum += turns;
    if (terminal === 'win') wins += 1;
    else if (terminal === 'loss') losses += 1;
    else draws += 1;
  }
  return { wins, losses, draws, n, avgTurns: n ? turnSum / n : 0 };
}

export type { QuantumPolicyProcess };
