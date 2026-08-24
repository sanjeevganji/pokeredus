import type {
  BattleObservation,
  CanonicalSet,
  ChoiceEvaluation,
  LegalAction,
  ReplyEvaluation,
  RoundEvaluation,
  SetHypothesis,
  SlotSnapshot,
} from './observation.js';
import { actionId } from './observation.js';
import {
  choiceScore,
  cta,
  cts,
  hitsToKill,
  impactParts,
  mateFromForced,
  observationStateScore,
  roundScore,
  signedLog1p,
  slotToMonValue,
} from './math.js';
import { simulateRound } from './sim.js';
import { enumerateFromRequest, type ShowdownRequest } from './actions.js';

const CHANCE_SEEDS = 4;

function valuesOf(ours: SlotSnapshot[], theirs: SlotSnapshot[]) {
  return [
    ...ours.map((s) => slotToMonValue(s, 'ours')),
    ...theirs.map((s) => slotToMonValue(s, 'theirs')),
  ];
}

function theirActions(obs: BattleObservation, hyp: CanonicalSet | undefined): LegalAction[] {
  const active = obs.theirs.find((s) => s.active) ?? obs.theirs[0];
  const moves = hyp?.moves ?? active?.knownMoves ?? [];
  const out: LegalAction[] = [];
  for (const moveId of moves) {
    const id = actionId({ type: 'move', moveId });
    out.push({ id, type: 'move', moveId });
  }
  for (const slot of obs.theirs) {
    if (slot.active || slot.fainted || !slot.revealed) continue;
    out.push({ id: actionId({ type: 'switch', slot: slot.slot + 1 }), type: 'switch', slot: slot.slot + 1 });
  }
  if (!out.length) out.push({ id: 'move:splash', type: 'move', moveId: 'splash' });
  return out;
}

function switchStayScores(obs: BattleObservation, action: LegalAction): { stay: number; after: number } {
  const stay = observationStateScore(obs.ours, obs.theirs);
  if (action.type !== 'switch' || action.slot === undefined) return { stay, after: stay };
  const ours = obs.ours.map((s) => ({ ...s, active: false }));
  const incoming = ours[(action.slot ?? 1) - 1];
  const outgoing = ours.find((s) => obs.ours[s.slot]?.active) ?? ours.find((s) => s.active);
  if (!incoming) return { stay, after: stay };
  for (const s of ours) s.active = s.slot === incoming.slot;
  if (outgoing) {
    const tmpHp = incoming.hp;
    incoming.hp = outgoing.hp;
    incoming.maxHp = outgoing.maxHp;
    incoming.fainted = outgoing.fainted;
    outgoing.hp = tmpHp;
  }
  return { stay, after: observationStateScore(ours, obs.theirs) };
}

export function evaluateRound(obs: BattleObservation, opts?: { chanceSeeds?: number }): RoundEvaluation {
  const legal = obs.legalActions.length ? obs.legalActions : enumerateFromRequest(obs.request as ShowdownRequest);
  const chanceN = opts?.chanceSeeds ?? CHANCE_SEEDS;
  const choices: ChoiceEvaluation[] = [];
  const postScores: number[] = [];
  const forcedRows: Array<Array<{ pWin: number; pLoss: number }>> = [];

  for (const action of legal) {
    const hyps: SetHypothesis[] = (obs.theirs.find((s) => s.active)?.hypotheses?.length
      ? obs.theirs.find((s) => s.active)!.hypotheses
      : [{ set: obs.theirs.find((s) => s.active)?.set ?? { species: 'smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'hardy' }, count: 1, probability: 1 }]);

    let impactSum = 0;
    let weightSum = 0;
    let successSum = 0;
    let postSum = 0;
    const repliesAgg: Array<{ pWin: number; pLoss: number; w: number }> = [];

    for (const hyp of hyps) {
      const replies = theirActions(obs, hyp.set);
      const theirSets = obs.theirs.map((s) => (s.active ? hyp.set : (s.set ?? hyp.set)));
      for (const reply of replies) {
        let win = 0;
        let loss = 0;
        let n = 0;
        for (let k = 0; k < chanceN; k++) {
          const seed = [1 + k, 2, 3, 4];
          const result = simulateRound(obs, action, reply, seed, theirSets);
          const before = valuesOf(obs.ours, obs.theirs);
          const after = valuesOf(result.afterOurs, result.afterTheirs);
          const w = hyp.probability / (replies.length * chanceN);
          impactSum += impact(before, after) * w;
          weightSum += w;
          const success = action.type === 'move'
            ? cta(result.pExecute, result.pHit, result.aliveAtExecution)
            : 0;
          successSum += success * w;
          postSum += observationStateScore(result.afterOurs, result.afterTheirs) * w;
          win += result.weWin ? 1 : 0;
          loss += result.theyWin ? 1 : 0;
          n += 1;
        }
        repliesAgg.push({ pWin: n ? win / n : 0, pLoss: n ? loss / n : 0, w: hyp.probability / replies.length });
      }
    }

    const expectedImpact = weightSum > 0 ? impactSum / weightSum * weightSum : 0;
    let success = 0;
    if (action.type === 'switch') {
      const { stay, after } = switchStayScores(obs, action);
      success = cts(after, stay, Boolean(action.forced));
    } else {
      success = weightSum > 0 ? successSum / weightSum * weightSum : 0;
      success = Math.min(1, Math.max(0, success / Math.max(weightSum, 1e-9)));
    }
    const raw = choiceScore(success, expectedImpact);
    const meanPost = weightSum > 0 ? postSum : 0;
    postScores.push(meanPost);
    choices.push({
      action,
      success,
      cta: action.type === 'move' ? success : undefined,
      cts: action.type === 'switch' ? success : undefined,
      expectedImpact,
      choiceScore: raw,
      scaledChoiceScore: signedLog1p(raw),
      meanPostScore: meanPost,
    });
    forcedRows.push(repliesAgg.map((r) => ({ pWin: r.pWin, pLoss: r.pLoss })));
  }

  const mate = mateFromForced(forcedRows);
  return {
    choices,
    roundScore: roundScore(postScores),
    forcedOutcome: mate.forcedOutcome,
    mateProbability: mate.mateProbability,
  };
}
