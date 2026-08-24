import type {
  BattleObservation,
  CanonicalSet,
  ChoiceEvaluation,
  LegalAction,
  PairScore,
  ReplyEvaluation,
  RoundEvaluation,
  SetHypothesis,
  SlotSnapshot,
} from './observation.js';
import { actionId } from './observation.js';
import {
  choiceFeatures,
  cta,
  cts,
  DEFAULT_WEIGHTS,
  emptyImpactParts,
  hitsToKill,
  impactParts,
  mateFromForced,
  observationStateScore,
  pokemonValue,
  roundScore,
  scoredChoice,
  secondaryDelta,
  signedLog1p,
  slotToMonValue,
  softmax,
  type ChoiceFeatures,
  type ImpactParts,
  type ScoreWeights,
} from './math.js';
import { simulateRound } from './sim.js';
import { enumerateFromRequest, type ShowdownRequest } from './actions.js';
import type { PolicyMode } from './observation.js';
import type { QuantumPolicyProcess } from './policy.js';

const CHANCE_SEEDS = 4;
const REFINE_ITERS = 2;
const JOINT_CAP = 32;

export interface EvaluateOptions {
  chanceSeeds?: number;
  theirTera?: boolean;
  weights?: ScoreWeights;
  refine?: QuantumPolicyProcess;
  policy?: PolicyMode;
  seed?: number;
  shots?: number | null;
  refineIters?: number;
  refineFallback?: 'throw' | 'softmax';
}

function valuesOf(ours: SlotSnapshot[], theirs: SlotSnapshot[]) {
  return [
    ...ours.map((s) => slotToMonValue(s, 'ours')),
    ...theirs.map((s) => slotToMonValue(s, 'theirs')),
  ];
}

export function theirActions(obs: BattleObservation, hyp: CanonicalSet | undefined, tera = false): LegalAction[] {
  const active = obs.theirs.find((s) => s.active) ?? obs.theirs[0];
  const moves = hyp?.moves ?? active?.knownMoves ?? [];
  const out: LegalAction[] = [];
  for (const moveId of moves) {
    out.push({ id: actionId({ type: 'move', moveId, tera }), type: 'move', moveId, tera });
  }
  for (const slot of obs.theirs) {
    if (slot.active || slot.fainted || !slot.revealed) continue;
    out.push({ id: actionId({ type: 'switch', slot: slot.slot + 1 }), type: 'switch', slot: slot.slot + 1 });
  }
  if (!out.length) out.push({ id: 'move:splash', type: 'move', moveId: 'splash' });
  return out;
}

function hpFrac(slots: SlotSnapshot[], index: number): number {
  const s = slots[index];
  if (!s || s.fainted || s.maxHp <= 0) return 0;
  return Math.max(0, Math.min(1, s.hp / s.maxHp));
}

function activeIndex(slots: SlotSnapshot[]): number {
  const i = slots.findIndex((s) => s.active);
  return i >= 0 ? i : 0;
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

export function withOurTera(obs: BattleObservation): BattleObservation {
  const base = obs.legalActions.length ? obs.legalActions : enumerateFromRequest(obs.request as ShowdownRequest);
  const moves = base.filter((a) => a.type === 'move' && !a.tera);
  const rest = base.filter((a) => a.type !== 'move');
  const teraMoves = moves.map((a) => ({
    ...a,
    tera: true,
    id: actionId({ type: 'move', moveId: a.moveId, tera: true }),
  }));
  return { ...obs, legalActions: [...teraMoves, ...rest] };
}

interface PairCell {
  action: LegalAction;
  reply: LegalAction;
  w: number;
  parts: ImpactParts;
  success: number;
  post: number;
  ourFaint: number;
  theirHpLost: number;
  ourRemain: number;
  secondary: number;
  pWin: number;
  pLoss: number;
  theirHBefore: number;
  theirHAfter: number;
  ourHBefore: number;
  ourHAfter: number;
}

function pairKey(ourId: string, theirId: string): string {
  return `${ourId}\t${theirId}`;
}

function addParts(dst: ImpactParts, src: ImpactParts, w: number): void {
  dst.health += src.health * w;
  dst.modifier += src.modifier * w;
  dst.total += src.total * w;
  dst.ourHealth += src.ourHealth * w;
  dst.theirHealth += src.theirHealth * w;
  dst.ourModifier += src.ourModifier * w;
  dst.theirModifier += src.theirModifier * w;
}

function scaleParts(p: ImpactParts, inv: number): ImpactParts {
  return {
    health: p.health * inv,
    modifier: p.modifier * inv,
    total: p.total * inv,
    ourHealth: p.ourHealth * inv,
    theirHealth: p.theirHealth * inv,
    ourModifier: p.ourModifier * inv,
    theirModifier: p.theirModifier * inv,
  };
}

function meanCell(cell: PairCell): PairCell {
  const inv = cell.w > 0 ? 1 / cell.w : 0;
  return {
    ...cell,
    parts: scaleParts(cell.parts, inv),
    success: cell.success * inv,
    post: cell.post * inv,
    ourFaint: cell.ourFaint * inv,
    theirHpLost: cell.theirHpLost * inv,
    ourRemain: cell.ourRemain * inv,
    secondary: cell.secondary * inv,
    pWin: cell.pWin * inv,
    pLoss: cell.pLoss * inv,
    theirHBefore: cell.theirHBefore * inv,
    theirHAfter: cell.theirHAfter * inv,
    ourHBefore: cell.ourHBefore * inv,
    ourHAfter: cell.ourHAfter * inv,
  };
}

function cellFeatures(cell: PairCell): ChoiceFeatures {
  return choiceFeatures(cell.parts, {
    secondary: cell.secondary,
    switchRisk: cell.ourFaint * cell.ourRemain,
    sacrifice: cell.ourFaint * cell.theirHpLost,
  });
}

function flipFeatures(f: ChoiceFeatures): ChoiceFeatures {
  return {
    health: -f.health,
    modifier: -f.modifier,
    secondary: -f.secondary,
    switchRisk: f.switchRisk,
    sacrifice: f.sacrifice,
  };
}

function mixFeatures(cells: Array<{ w: number; cell: PairCell }>): { features: ChoiceFeatures; parts: ImpactParts; success: number; post: number; htk: { tb: number; ta: number; ob: number; oa: number } } {
  const z = {
    features: { health: 0, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 } as ChoiceFeatures,
    parts: emptyImpactParts(),
    success: 0,
    post: 0,
    tb: 0, ta: 0, ob: 0, oa: 0,
    w: 0,
  };
  for (const { w, cell } of cells) {
    if (!(w > 0)) continue;
    const f = cellFeatures(cell);
    z.features.health += f.health * w;
    z.features.modifier += f.modifier * w;
    z.features.secondary += f.secondary * w;
    z.features.switchRisk += f.switchRisk * w;
    z.features.sacrifice += f.sacrifice * w;
    addParts(z.parts, cell.parts, w);
    z.success += cell.success * w;
    z.post += cell.post * w;
    z.tb += cell.theirHBefore * w;
    z.ta += cell.theirHAfter * w;
    z.ob += cell.ourHBefore * w;
    z.oa += cell.ourHAfter * w;
    z.w += w;
  }
  const inv = z.w > 0 ? 1 / z.w : 0;
  return {
    features: {
      health: z.features.health * inv,
      modifier: z.features.modifier * inv,
      secondary: z.features.secondary * inv,
      switchRisk: z.features.switchRisk * inv,
      sacrifice: z.features.sacrifice * inv,
    },
    parts: scaleParts(z.parts, inv),
    success: z.success * inv,
    post: z.post * inv,
    htk: { tb: z.tb * inv, ta: z.ta * inv, ob: z.ob * inv, oa: z.oa * inv },
  };
}

function assemble(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  pOur: number[],
  pTheir: number[],
  weights: ScoreWeights,
  obs: BattleObservation,
): { choices: ChoiceEvaluation[]; replies: ReplyEvaluation[]; postScores: number[]; forcedRows: Array<Array<{ pWin: number; pLoss: number }>>; pairs: PairScore[] } {
  const choices: ChoiceEvaluation[] = [];
  const postScores: number[] = [];
  const forcedRows: Array<Array<{ pWin: number; pLoss: number }>> = [];
  const pairs: PairScore[] = [];

  for (let i = 0; i < legal.length; i++) {
    const action = legal[i]!;
    const mixed = mixFeatures(replies.flatMap((reply, j) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return cell ? [{ w: pTheir[j] ?? 0, cell }] : [];
    }));
    let success = mixed.success;
    if (action.type === 'switch') {
      const { stay, after } = switchStayScores(obs, action);
      success = cts(after, stay, Boolean(action.forced));
    } else {
      success = Math.min(1, Math.max(0, success));
    }
    const raw = scoredChoice(success, mixed.features, weights);
    postScores.push(mixed.post);
    choices.push({
      action,
      success,
      cta: action.type === 'move' ? success : undefined,
      cts: action.type === 'switch' ? success : undefined,
      expectedImpact: mixed.parts.total,
      expectedHealthDelta: mixed.parts.health,
      expectedModifierDelta: mixed.parts.modifier,
      ourHealth: mixed.parts.ourHealth,
      theirHealth: mixed.parts.theirHealth,
      ourModifier: mixed.parts.ourModifier,
      theirModifier: mixed.parts.theirModifier,
      hitsToKill: hitsToKill(mixed.htk.tb, mixed.htk.ta),
      choiceScore: raw,
      scaledChoiceScore: signedLog1p(raw),
      meanPostScore: mixed.post,
      features: mixed.features,
      probability: pOur[i],
    });
    forcedRows.push(replies.map((reply) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return { pWin: cell?.pWin ?? 0, pLoss: cell?.pLoss ?? 0 };
    }));
  }

  const replyEvals: ReplyEvaluation[] = replies.map((reply, j) => {
    const mixed = mixFeatures(legal.map((action, i) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return { w: pOur[i] ?? 0, cell: cell! };
    }).filter((x) => x.cell));
    const flipped = flipFeatures(mixed.features);
    const raw = scoredChoice(1, flipped, weights);
    return {
      action: reply,
      expectedImpact: mixed.parts.total,
      hitsToKillUs: hitsToKill(mixed.htk.ob, mixed.htk.oa),
      choiceScore: raw,
      expectedHealthDelta: mixed.parts.health,
      expectedModifierDelta: mixed.parts.modifier,
      ourHealth: mixed.parts.ourHealth,
      theirHealth: mixed.parts.theirHealth,
      ourModifier: mixed.parts.ourModifier,
      theirModifier: mixed.parts.theirModifier,
      features: flipped,
      probability: pTheir[j],
    };
  });

  for (const action of legal) {
    for (const reply of replies) {
      const cell = cells.get(pairKey(action.id, reply.id));
      if (!cell) continue;
      const f = cellFeatures(cell);
      pairs.push({ ourId: action.id, theirId: reply.id, score: scoredChoice(cell.success, f, weights) });
    }
  }

  return { choices, replies: replyEvals, postScores, forcedRows, pairs };
}

async function policyProbs(
  process: QuantumPolicyProcess,
  actions: string[],
  scores: number[],
  opts: EvaluateOptions,
): Promise<{ probs: number[]; diagnostics: Record<string, unknown> }> {
  if (!actions.length) return { probs: [], diagnostics: { mode: 'empty' } };
  try {
    const res = await process.decide({
      actions,
      scores,
      mode: opts.policy ?? 'quantum',
      seed: opts.seed,
      shots: opts.shots ?? null,
    });
    return { probs: res.probabilities, diagnostics: res.diagnostics ?? {} };
  } catch (err) {
    if (opts.refineFallback === 'throw') throw err;
    return { probs: softmax(scores), diagnostics: { mode: 'softmax', fallback: true } };
  }
}

function marginalize(
  pairIds: string[],
  joint: number[],
  ourIds: string[],
  theirIds: string[],
): { pOur: number[]; pTheir: number[] } {
  const pOur = ourIds.map(() => 0);
  const pTheir = theirIds.map(() => 0);
  const ourIndex = new Map(ourIds.map((id, i) => [id, i]));
  const theirIndex = new Map(theirIds.map((id, i) => [id, i]));
  for (let k = 0; k < pairIds.length; k++) {
    const raw = pairIds[k]!;
    const tab = raw.indexOf('\t');
    const ourId = tab >= 0 ? raw.slice(0, tab) : raw;
    const theirId = tab >= 0 ? raw.slice(tab + 1) : '';
    const i = ourIndex.get(ourId);
    const j = theirIndex.get(theirId);
    const p = joint[k] ?? 0;
    if (i != null) pOur[i] += p;
    if (j != null) pTheir[j] += p;
  }
  const so = pOur.reduce((a, b) => a + b, 0);
  const st = pTheir.reduce((a, b) => a + b, 0);
  return {
    pOur: so > 0 ? pOur.map((x) => x / so) : softmax(ourIds.map(() => 0)),
    pTheir: st > 0 ? pTheir.map((x) => x / st) : softmax(theirIds.map(() => 0)),
  };
}

async function refineLoop(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  pOur: number[],
  pTheir: number[],
  weights: ScoreWeights,
  obs: BattleObservation,
  opts: EvaluateOptions,
): Promise<{ pOur: number[]; pTheir: number[]; diagnostics?: Record<string, unknown> }> {
  const process = opts.refine;
  if (!process) return { pOur, pTheir };
  const iters = opts.refineIters ?? REFINE_ITERS;
  let diag: Record<string, unknown> | undefined;
  let nextOur = pOur;
  let nextTheir = pTheir;
  for (let n = 0; n < iters; n++) {
    const assembled = assemble(legal, replies, cells, nextOur, nextTheir, weights, obs);
    let pairRows = assembled.pairs.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    if (pairRows.length > JOINT_CAP) pairRows = pairRows.slice(0, JOINT_CAP); // ponytail: 32-pair QAOA cap; raise JOINT_CAP if action counts grow
    const pairIds = pairRows.map((p) => pairKey(p.ourId, p.theirId));
    const pairScores = pairRows.map((p) => signedLog1p(p.score));
    try {
      const joint = await policyProbs(process, pairIds, pairScores, opts);
      diag = joint.diagnostics;
      const marg = marginalize(pairIds, joint.probs, legal.map((a) => a.id), replies.map((r) => r.id));
      nextOur = marg.pOur;
      nextTheir = marg.pTheir;
    } catch (err) {
      if (opts.refineFallback === 'throw') throw err;
      const ourScores = assembled.choices.map((c) => c.scaledChoiceScore);
      const theirScores = assembled.replies.map((r) => signedLog1p(r.choiceScore));
      try {
        const ours = await policyProbs(process, legal.map((a) => a.id), ourScores, opts);
        const theirs = await policyProbs(process, replies.map((r) => r.id), theirScores, opts);
        nextOur = ours.probs;
        nextTheir = theirs.probs;
        diag = ours.diagnostics;
      } catch (err2) {
        if (opts.refineFallback === 'throw') throw err2;
        nextOur = softmax(ourScores);
        nextTheir = softmax(theirScores);
        diag = { mode: 'softmax', fallback: true };
      }
    }
  }
  return { pOur: nextOur, pTheir: nextTheir, diagnostics: diag };
}

export async function evaluateRound(obs: BattleObservation, opts?: EvaluateOptions): Promise<RoundEvaluation> {
  const raw = obs.legalActions.length ? obs.legalActions : enumerateFromRequest(obs.request as ShowdownRequest);
  const hasNonTeraMove = raw.some((a) => a.type === 'move' && !a.tera);
  const legal = hasNonTeraMove ? raw.filter((a) => !a.tera) : raw;
  const chanceN = opts?.chanceSeeds ?? CHANCE_SEEDS;
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const theirIdx = activeIndex(obs.theirs);
  const ourIdx = activeIndex(obs.ours);
  const ourActive = obs.ours[ourIdx];
  const ourRemain = ourActive ? pokemonValue(slotToMonValue(ourActive, 'ours')) : 0;

  const pairAcc = new Map<string, PairCell>();
  const replyById = new Map<string, LegalAction>();

  for (const action of legal) {
    const hyps: SetHypothesis[] = (obs.theirs.find((s) => s.active)?.hypotheses?.length
      ? obs.theirs.find((s) => s.active)!.hypotheses
      : [{ set: obs.theirs.find((s) => s.active)?.set ?? { species: 'smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'hardy' }, count: 1, probability: 1 }]);

    for (const hyp of hyps) {
      const replies = theirActions(obs, hyp.set, Boolean(opts?.theirTera));
      const theirSets = obs.theirs.map((s) => (s.active ? hyp.set : (s.set ?? hyp.set)));
      for (const reply of replies) {
        replyById.set(reply.id, reply);
        const key = pairKey(action.id, reply.id);
        for (let k = 0; k < chanceN; k++) {
          const seed = [1 + k, 2, 3, 4];
          const result = simulateRound(obs, action, reply, seed, theirSets);
          const before = valuesOf(obs.ours, obs.theirs);
          const after = valuesOf(result.afterOurs, result.afterTheirs);
          const w = hyp.probability / chanceN;
          const parts = impactParts(before, after);
          const success = action.type === 'move'
            ? cta(result.pExecute, result.pHit, result.aliveAtExecution)
            : 0;
          const ourAfter = result.afterOurs[ourIdx];
          const ourFaint = ourAfter && (ourAfter.fainted || ourAfter.hp <= 0) ? 1 : 0;
          const theirHpLost = Math.max(0, hpFrac(obs.theirs, theirIdx) - hpFrac(result.afterTheirs, theirIdx));
          const secondary = secondaryDelta(
            obs.ours, result.afterOurs, obs.theirs, result.afterTheirs,
            obs.field, result.afterField, obs.ourSide,
          );
          let cell = pairAcc.get(key);
          if (!cell) {
            cell = {
              action, reply, w: 0, parts: emptyImpactParts(), success: 0, post: 0,
              ourFaint: 0, theirHpLost: 0, ourRemain: 0, secondary: 0,
              pWin: 0, pLoss: 0, theirHBefore: 0, theirHAfter: 0, ourHBefore: 0, ourHAfter: 0,
            };
            pairAcc.set(key, cell);
          }
          cell.w += w;
          addParts(cell.parts, parts, w);
          cell.success += success * w;
          cell.post += observationStateScore(result.afterOurs, result.afterTheirs) * w;
          cell.ourFaint += ourFaint * w;
          cell.theirHpLost += theirHpLost * w;
          cell.ourRemain += ourRemain * w;
          cell.secondary += secondary * w;
          cell.pWin += (result.weWin ? 1 : 0) * w;
          cell.pLoss += (result.theyWin ? 1 : 0) * w;
          cell.theirHBefore += hpFrac(obs.theirs, theirIdx) * w;
          cell.theirHAfter += hpFrac(result.afterTheirs, theirIdx) * w;
          cell.ourHBefore += hpFrac(obs.ours, ourIdx) * w;
          cell.ourHAfter += hpFrac(result.afterOurs, ourIdx) * w;
        }
      }
    }
  }

  const cells = new Map<string, PairCell>();
  for (const [k, v] of pairAcc) cells.set(k, meanCell(v));

  const replies = [...replyById.values()];
  const uniformOur = legal.map(() => (legal.length ? 1 / legal.length : 0));
  const uniformTheir = replies.map(() => (replies.length ? 1 / replies.length : 0));

  let first = assemble(legal, replies, cells, uniformOur, uniformTheir, weights, obs);
  const pTheir = softmax(first.replies.map((r) => r.choiceScore));
  const pOurSoft = softmax(first.choices.map((c) => c.scaledChoiceScore));
  const refined = await refineLoop(legal, replies, cells, pOurSoft, pTheir.length ? pTheir : uniformTheir, weights, obs, opts ?? {});
  const final = assemble(legal, replies, cells, refined.pOur, refined.pTheir, weights, obs);
  const mate = mateFromForced(final.forcedRows);
  return {
    choices: final.choices,
    replies: final.replies,
    roundScore: roundScore(final.postScores),
    forcedOutcome: mate.forcedOutcome,
    mateProbability: mate.mateProbability,
    pairs: final.pairs,
    diagnostics: refined.diagnostics,
  };
}
