import type {
  BattleObservation,
  CanonicalSet,
  ChoiceEvaluation,
  LegalAction,
  PairScore,
  PolicyMode,
  ReplyEvaluation,
  RoundEvaluation,
  SetHypothesis,
  SlotSnapshot,
} from './observation.js';
import { observationTera, placeholderSet } from './observation.js';
import { canonicalizeSet } from './beliefs.js';
import { setIsComplete } from './set-overrides.js';
import {
  actorSecondaryFeature,
  boundFeatures,
  clamp,
  cta,
  cts,
  DEFAULT_WEIGHTS,
  emptyFeatures,
  emptyImpactParts,
  finiteOrZero,
  hitsToKill,
  impactParts,
  mateFromForced,
  modifierValue,
  modifiersFromSlot,
  observationStateScore,
  scoredChoice,
  signedLog1p,
  slotToMonValue,
  softmax,
  weightedMean,
  scoreExtrema,
  type ChoiceFeatures,
  type ImpactParts,
  type ScoreWeights,
} from './math.js';
import { IllegalSimChoiceError, simulateRound, type ActionEffect, type ActionTelemetry, type RoundSimResult } from './sim.js';
import { legalActionsForEval, legalFromSlots, slotsWithActiveSet } from './actions.js';
import { transformSidePolicy, type QuantumPolicyProcess } from './policy.js';
import {
  loadDefaultValuations,
  valuationOrNeutral,
  type EffectValuationRegistry,
} from './effect-valuation.js';

const CHANCE_SEEDS = 4;
const REFINE_ITERS = 2;
const JOINT_CAP = 32;

export interface EvaluateOptions {
  chanceSeeds?: number;
  weights?: ScoreWeights;
  valuations?: EffectValuationRegistry;
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

export function theirActions(obs: BattleObservation, hyp: CanonicalSet | undefined): LegalAction[] {
  return legalFromSlots(slotsWithActiveSet(obs.theirs, hyp), observationTera(obs).theirs);
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

function hpDeltaFromEffect(e: ActionEffect): number {
  if (!(e.maxHp && e.maxHp > 0) || e.hpBefore == null || e.hpAfter == null) return 0;
  return (e.hpAfter - e.hpBefore) / e.maxHp;
}

function isHazardHp(e: ActionEffect): boolean {
  if (e.kind === 'hazard') return true;
  const from = e.from ?? '';
  return /stealth rock|spikes|toxic spikes|sticky web/.test(from);
}

function attributedHp(tel: ActionTelemetry, side: 'p1' | 'p2', includeSwitchHazards: boolean): number {
  let d = 0;
  for (const e of tel.effects) {
    if (e.side !== side) continue;
    const allow = e.attributed || (includeSwitchHazards && isHazardHp(e));
    if (!allow) continue;
    if (e.kind === 'damage' || e.kind === 'heal' || e.kind === 'recoil' || e.kind === 'drain' || e.kind === 'hazard' || (includeSwitchHazards && e.kind === 'residual' && isHazardHp(e))) {
      d += hpDeltaFromEffect(e);
    }
  }
  return d;
}

function actionSuccess(action: LegalAction, tel: ActionTelemetry, actorAfter: SlotSnapshot[]): number {
  if (action.type === 'switch') {
    return cts(switchCompleted(action, actorAfter), Boolean(action.forced));
  }
  return cta(tel.executed ? 1 : 0, tel.hit ? 1 : 0, tel.aliveAtExecution ? 1 : 0);
}

function switchCompleted(action: LegalAction, actorAfter: SlotSnapshot[]): boolean {
  const idx = (action.slot ?? 1) - 1;
  const incoming = actorAfter.find((s) => s.slot === idx) ?? actorAfter[idx];
  if (incoming?.active && !incoming.fainted && incoming.hp > 0) return true;
  const active = actorAfter.find((s) => s.active);
  return Boolean(active && !active.fainted && active.hp > 0);
}

function addFeat(dst: ChoiceFeatures, src: ChoiceFeatures, w: number): void {
  dst.health += src.health * w;
  dst.modifier += src.modifier * w;
  dst.secondary += src.secondary * w;
  dst.switchRisk += src.switchRisk * w;
  dst.sacrifice += src.sacrifice * w;
}

function scaleFeat(f: ChoiceFeatures, inv: number): ChoiceFeatures {
  return boundFeatures({
    health: f.health * inv,
    modifier: f.modifier * inv,
    secondary: f.secondary * inv,
    switchRisk: f.switchRisk * inv,
    sacrifice: f.sacrifice * inv,
  });
}

function slotAfterEffects(slot: SlotSnapshot, effects: ActionEffect[], side: 'p1' | 'p2'): SlotSnapshot {
  const boosts = { ...slot.boosts };
  let status = slot.status;
  for (const e of effects) {
    if (!e.attributed || e.side !== side) continue;
    if ((e.kind === 'boost' || e.kind === 'unboost') && e.stat && e.amount) {
      const k = e.stat as keyof typeof boosts;
      if (k in boosts) {
        const delta = e.kind === 'boost' ? e.amount : -e.amount;
        boosts[k] = Math.max(-6, Math.min(6, (boosts[k] ?? 0) + delta));
      }
    }
    if (e.kind === 'status' && e.status) status = e.status;
  }
  const next = { ...slot, boosts, status };
  next.modifiers = modifiersFromSlot(next);
  return next;
}

function actorFeatures(
  tel: ActionTelemetry,
  action: LegalAction,
  actorOurs: boolean,
  obs: BattleObservation,
  result: RoundSimResult,
  valuations: EffectValuationRegistry,
): { features: ChoiceFeatures; success: number; coverage: string[] } {
  const self = actorOurs ? obs.ours : obs.theirs;
  const foe = actorOurs ? obs.theirs : obs.ours;
  const afterSelf = actorOurs ? result.afterOurs : result.afterTheirs;
  const afterFoe = actorOurs ? result.afterTheirs : result.afterOurs;
  const selfIdx = activeIndex(self);
  const foeIdx = activeIndex(foe);
  const selfSide = actorOurs ? obs.ourSide : (obs.ourSide === 'p1' ? 'p2' : 'p1');
  const foeSide: 'p1' | 'p2' = selfSide === 'p1' ? 'p2' : 'p1';
  const success = actionSuccess(action, tel, afterSelf);
  const coverage: string[] = [];

  const includeHazards = action.type === 'switch';
  let selfHp = attributedHp(tel, selfSide, includeHazards);
  let foeHp = attributedHp(tel, foeSide, includeHazards);
  if (action.type === 'move' && tel.hit && foeHp === 0) {
    foeHp = hpFrac(afterFoe, foeIdx) - hpFrac(foe, foeIdx);
  }
  const health = clamp((selfHp - foeHp) / 6, -1, 1);

  const selfSlot = self[selfIdx];
  const foeSlot = foe[foeIdx];
  let selfMod = 0;
  let foeMod = 0;
  if (selfSlot) {
    selfMod = modifierValue(slotAfterEffects(selfSlot, tel.effects, selfSide).modifiers) - modifierValue(selfSlot.modifiers);
  }
  if (foeSlot) {
    foeMod = modifierValue(slotAfterEffects(foeSlot, tel.effects, foeSide).modifiers) - modifierValue(foeSlot.modifiers);
  }
  const modifier = clamp((selfMod - foeMod) / 6, -1, 1);

  const fieldTouched = tel.effects.some((e) => e.attributed && (e.kind === 'hazard' || /stealth rock|spikes|reflect|light screen|rain|sun|terrain/.test(e.from ?? '')));
  const secondary = fieldTouched
    ? actorSecondaryFeature(obs.ours, result.afterOurs, obs.theirs, result.afterTheirs, obs.field, result.afterField, obs.ourSide, actorOurs)
    : 0;

  const afterActive = afterSelf[selfIdx];
  const faint = afterActive && (afterActive.fainted || afterActive.hp <= 0) ? 1 : 0;
  const switchRisk = faint * hpFrac(self, selfIdx);
  const sacrifice = faint * Math.max(0, hpFrac(foe, foeIdx) - hpFrac(afterFoe, foeIdx));

  if (action.type === 'move' && action.moveId) {
    const looked = valuationOrNeutral(valuations, 'moves', action.moveId);
    const effectful = tel.effects.some((e) => e.attributed && e.kind !== 'damage' && e.kind !== 'recoil' && e.kind !== 'drain' && e.kind !== 'heal');
    if (looked.coverage && effectful) coverage.push(looked.coverage);
  }

  return {
    success,
    coverage,
    features: boundFeatures({ health, modifier, secondary, switchRisk, sacrifice }),
  };
}

export interface RealizedPairScore {
  ourSuccess: number;
  theirSuccess: number;
  ourFeatures: ChoiceFeatures;
  theirFeatures: ChoiceFeatures;
  ourScore: number;
  theirScore: number;
  pairDelta: number;
  parts: ImpactParts;
  residualHealth: number;
  residualModifier: number;
  coverage: string[];
}

export function scoreRealizedPair(
  before: BattleObservation,
  ourAction: LegalAction,
  theirAction: LegalAction,
  simResult: RoundSimResult,
  weights: ScoreWeights,
  valuations: EffectValuationRegistry = loadDefaultValuations(),
): RealizedPairScore {
  const our = actorFeatures(simResult.ours, ourAction, true, before, simResult, valuations);
  const their = actorFeatures(simResult.theirs, theirAction, false, before, simResult, valuations);
  const ourScore = scoredChoice(our.success, our.features, weights);
  const theirScore = scoredChoice(their.success, their.features, weights);
  const beforeMons = valuesOf(before.ours, before.theirs);
  const afterMons = valuesOf(simResult.afterOurs, simResult.afterTheirs);
  const parts = impactParts(beforeMons, afterMons);
  const residualHealth = finiteOrZero(parts.health / 6 - (our.features.health - their.features.health));
  const residualModifier = finiteOrZero(parts.modifier / 6 - (our.features.modifier - their.features.modifier));
  return {
    ourSuccess: our.success,
    theirSuccess: their.success,
    ourFeatures: our.features,
    theirFeatures: their.features,
    ourScore,
    theirScore,
    pairDelta: clamp(ourScore - theirScore, -1, 1),
    parts,
    residualHealth,
    residualModifier,
    coverage: [...our.coverage, ...their.coverage],
  };
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
  pWin: number;
  pLoss: number;
  theirHBefore: number;
  theirHAfter: number;
  ourHBefore: number;
  ourHAfter: number;
  turnScore: number;
  theirVal: number;
  ourFeatures: ChoiceFeatures;
  theirFeatures: ChoiceFeatures;
  ourSuccessW: number;
  theirSuccessW: number;
  ourFeatAcc: ChoiceFeatures;
  theirFeatAcc: ChoiceFeatures;
}

interface Branch {
  action: LegalAction;
  reply: LegalAction;
  w: number;
  turnScore: number;
  post: number;
  parts: ImpactParts;
  success: number;
  ourFaint: number;
  theirHpLost: number;
  ourRemain: number;
  pWin: number;
  pLoss: number;
  theirHBefore: number;
  theirHAfter: number;
  ourHBefore: number;
  ourHAfter: number;
  theirVal: number;
}

function emptyCell(action: LegalAction, reply: LegalAction): PairCell {
  return {
    action, reply, w: 0, parts: emptyImpactParts(), success: 0, post: 0,
    ourFaint: 0, theirHpLost: 0, ourRemain: 0,
    pWin: 0, pLoss: 0, theirHBefore: 0, theirHAfter: 0, ourHBefore: 0, ourHAfter: 0,
    turnScore: 0, theirVal: 0,
    ourFeatures: emptyFeatures(), theirFeatures: emptyFeatures(),
    ourSuccessW: 0, theirSuccessW: 0,
    ourFeatAcc: emptyFeatures(), theirFeatAcc: emptyFeatures(),
  };
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
    success: cell.ourSuccessW * inv,
    post: cell.post * inv,
    ourFaint: cell.ourFaint * inv,
    theirHpLost: cell.theirHpLost * inv,
    ourRemain: cell.ourRemain * inv,
    pWin: cell.pWin * inv,
    pLoss: cell.pLoss * inv,
    theirHBefore: cell.theirHBefore * inv,
    theirHAfter: cell.theirHAfter * inv,
    ourHBefore: cell.ourHBefore * inv,
    ourHAfter: cell.ourHAfter * inv,
    turnScore: cell.turnScore * inv,
    theirVal: cell.theirVal * inv,
    ourFeatures: cell.ourSuccessW > 0 ? scaleFeat(cell.ourFeatAcc, 1 / cell.ourSuccessW) : emptyFeatures(),
    theirFeatures: cell.theirSuccessW > 0 ? scaleFeat(cell.theirFeatAcc, 1 / cell.theirSuccessW) : emptyFeatures(),
  };
}

function mixActor(
  cells: Array<{ w: number; cell: PairCell }>,
  whose: 'ours' | 'theirs',
): { features: ChoiceFeatures; success: number; parts: ImpactParts; post: number; turn: number; theirVal: number; htk: { tb: number; ta: number; ob: number; oa: number } } {
  const z = {
    featAcc: emptyFeatures(),
    parts: emptyImpactParts(),
    successW: 0, post: 0, turn: 0, theirVal: 0, tb: 0, ta: 0, ob: 0, oa: 0, w: 0,
  };
  for (const { w, cell } of cells) {
    if (!(w > 0)) continue;
    const ctaMass = whose === 'ours' ? cell.success : (cell.w > 0 ? cell.theirSuccessW / cell.w : 0);
    const feat = whose === 'ours' ? cell.ourFeatures : cell.theirFeatures;
    z.w += w;
    z.successW += w * ctaMass;
    addFeat(z.featAcc, feat, w * ctaMass);
    addParts(z.parts, cell.parts, w);
    z.post += cell.post * w;
    z.turn += cell.turnScore * w;
    z.theirVal += cell.theirVal * w;
    z.tb += cell.theirHBefore * w;
    z.ta += cell.theirHAfter * w;
    z.ob += cell.ourHBefore * w;
    z.oa += cell.ourHAfter * w;
  }
  const inv = z.w > 0 ? 1 / z.w : 0;
  return {
    features: z.successW > 0 ? scaleFeat(z.featAcc, 1 / z.successW) : emptyFeatures(),
    success: z.w > 0 ? z.successW / z.w : 0,
    parts: scaleParts(z.parts, inv),
    post: z.post * inv,
    turn: z.turn * inv,
    theirVal: z.theirVal * inv,
    htk: { tb: z.tb * inv, ta: z.ta * inv, ob: z.ob * inv, oa: z.oa * inv },
  };
}

function rangeFromBranches(rows: Branch[]): {
  minTurn: number; maxTurn: number; minPost: number; maxPost: number; n: number;
} {
  const turns = rows.map((b) => b.turnScore);
  const posts = rows.map((b) => b.post);
  const t = scoreExtrema(turns);
  const p = scoreExtrema(posts);
  return { minTurn: t.min, maxTurn: t.max, minPost: p.min, maxPost: p.max, n: rows.length };
}

function unweightedImpact(f: ChoiceFeatures): number {
  return finiteOrZero(f.health + f.modifier + f.secondary);
}

function assemble(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  branches: Branch[],
  pOur: number[],
  pTheir: number[],
  weights: ScoreWeights,
): { choices: ChoiceEvaluation[]; replies: ReplyEvaluation[]; postScores: number[]; forcedRows: Array<Array<{ pWin: number; pLoss: number }>>; pairs: PairScore[] } {
  const choices: ChoiceEvaluation[] = [];
  const postScores: number[] = [];
  const forcedRows: Array<Array<{ pWin: number; pLoss: number }>> = [];
  const pairs: PairScore[] = [];

  for (let i = 0; i < legal.length; i++) {
    const action = legal[i]!;
    const mixed = mixActor(replies.flatMap((reply, j) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return cell ? [{ w: pTheir[j] ?? 0, cell }] : [];
    }), 'ours');
    const ours = branches.filter((b) => b.action.id === action.id);
    const range = rangeFromBranches(ours);
    const success = clamp(mixed.success, 0, 1);
    const raw = scoredChoice(success, mixed.features, weights);
    postScores.push(mixed.post);
    choices.push({
      action,
      success,
      cta: action.type === 'move' ? success : undefined,
      cts: action.type === 'switch' ? success : undefined,
      expectedImpact: unweightedImpact(mixed.features),
      expectedHealthDelta: mixed.parts.health,
      expectedModifierDelta: mixed.parts.modifier,
      ourHealth: finiteOrZero(mixed.htk.oa - mixed.htk.ob),
      theirHealth: finiteOrZero(mixed.htk.ta - mixed.htk.tb),
      ourModifier: mixed.parts.ourModifier,
      theirModifier: mixed.parts.theirModifier,
      hitsToKill: hitsToKill(mixed.htk.tb, mixed.htk.ta),
      choiceScore: raw,
      scaledChoiceScore: signedLog1p(raw),
      meanPostScore: mixed.post,
      minTurnScore: range.minTurn,
      maxTurnScore: range.maxTurn,
      minPostScore: range.minPost,
      maxPostScore: range.maxPost,
      sampleCount: range.n,
      features: mixed.features,
      probability: pOur[i],
    });
    forcedRows.push(replies.map((reply) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return { pWin: cell?.pWin ?? 0, pLoss: cell?.pLoss ?? 0 };
    }));
  }

  const replyEvals: ReplyEvaluation[] = replies.map((reply, j) => {
    const mixed = mixActor(legal.flatMap((action, i) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return cell ? [{ w: pOur[i] ?? 0, cell }] : [];
    }), 'theirs');
    const raw = scoredChoice(mixed.success, mixed.features, weights);
    const rows = branches.filter((b) => b.reply.id === reply.id);
    const range = rangeFromBranches(rows);
    return {
      action: reply,
      success: mixed.success,
      cta: reply.type === 'move' ? mixed.success : undefined,
      cts: reply.type === 'switch' ? mixed.success : undefined,
      expectedImpact: unweightedImpact(mixed.features),
      hitsToKillUs: hitsToKill(mixed.htk.ob, mixed.htk.oa),
      choiceScore: raw,
      expectedHealthDelta: mixed.parts.health,
      expectedModifierDelta: mixed.parts.modifier,
      ourHealth: finiteOrZero(mixed.htk.oa - mixed.htk.ob),
      theirHealth: finiteOrZero(mixed.htk.ta - mixed.htk.tb),
      ourModifier: mixed.parts.ourModifier,
      theirModifier: mixed.parts.theirModifier,
      features: mixed.features,
      probability: pTheir[j],
      minTurnScore: range.minTurn,
      maxTurnScore: range.maxTurn,
      meanPostScore: mixed.post,
      minPostScore: range.minPost,
      maxPostScore: range.maxPost,
      sampleCount: range.n,
    };
  });

  for (const action of legal) {
    for (const reply of replies) {
      const cell = cells.get(pairKey(action.id, reply.id));
      if (!cell) continue;
      const ourScore = scoredChoice(cell.success, cell.ourFeatures, weights);
      const theirCta = cell.w > 0 ? cell.theirSuccessW / cell.w : 0;
      const theirScore = scoredChoice(theirCta, cell.theirFeatures, weights);
      pairs.push({ ourId: action.id, theirId: reply.id, score: clamp(ourScore - theirScore, -1, 1) });
    }
  }

  return { choices, replies: replyEvals, postScores, forcedRows, pairs };
}

function expectedFromPolicy(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  pOur: number[],
  pTheir: number[],
): number {
  const values: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < legal.length; i++) {
    for (let j = 0; j < replies.length; j++) {
      const cell = cells.get(pairKey(legal[i]!.id, replies[j]!.id));
      if (!cell) continue;
      values.push(cell.turnScore);
      weights.push((pOur[i] ?? 0) * (pTheir[j] ?? 0));
    }
  }
  return weightedMean(values, weights);
}

async function policyProbs(
  process: QuantumPolicyProcess,
  actions: string[],
  scores: number[],
  opts: EvaluateOptions,
): Promise<{ probs: number[]; diagnostics: Record<string, unknown> }> {
  if (!actions.length) return { probs: [], diagnostics: { mode: 'empty' } };
  const res = await process.decide({
    actions,
    scores,
    mode: opts.policy ?? 'quantum',
    seed: opts.seed,
    shots: opts.shots ?? null,
  });
  return { probs: res.probabilities, diagnostics: res.diagnostics ?? {} };
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
    if (i !== undefined) pOur[i] = (pOur[i] ?? 0) + p;
    if (j !== undefined) pTheir[j] = (pTheir[j] ?? 0) + p;
  }
  const so = pOur.reduce((a, b) => a + b, 0);
  const st = pTheir.reduce((a, b) => a + b, 0);
  return {
    pOur: so > 0 ? pOur.map((x) => x / so) : softmax(ourIds.map(() => 0)),
    pTheir: st > 0 ? pTheir.map((x) => x / st) : softmax(theirIds.map(() => 0)),
  };
}

export interface JointPolicyResult {
  pOur: number[];
  pTheir: number[];
  jointProbs: Map<string, number>;
  diagnostics?: Record<string, unknown>;
  omittedPairs: number;
  evaluation: RoundEvaluation;
}

export function capJointPairs(
  pairs: PairScore[],
  ourIds: string[],
  theirIds: string[],
  cap: number,
): { kept: PairScore[]; omitted: number } {
  if (pairs.length <= cap) return { kept: pairs, omitted: 0 };
  const used = new Set<string>();
  const kept: PairScore[] = [];
  const keyOf = (p: PairScore) => `${p.ourId}\t${p.theirId}`;

  // First reserve at least one best pair per our action
  for (const id of ourIds) {
    const candidates = pairs.filter((p) => p.ourId === id);
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (Math.abs(b.score) > Math.abs(a.score) ? b : a));
    kept.push(best);
    used.add(keyOf(best));
  }

  // Next reserve at least one best pair per their action
  for (const id of theirIds) {
    const candidates = pairs.filter((p) => p.theirId === id && !used.has(keyOf(p)));
    if (!candidates.length) continue;
    const best = candidates.reduce((a, b) => (Math.abs(b.score) > Math.abs(a.score) ? b : a));
    kept.push(best);
    used.add(keyOf(best));
  }

  // Fill remaining capacity by absolute score
  const rest = pairs
    .filter((p) => !used.has(keyOf(p)))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

  for (const p of rest) {
    if (kept.length >= cap) break;
    kept.push(p);
    used.add(keyOf(p));
  }
  return { kept, omitted: pairs.length - kept.length };
}

export async function evaluateJointStatePolicy(
  obs: BattleObservation,
  opts?: EvaluateOptions,
): Promise<JointPolicyResult> {
  const ev = await evaluateRound(obs, opts);
  const ourIds = ev.choices.map((c) => c.action.id);
  const theirIds = ev.replies.map((r) => r.action.id);
  const pOur = ev.choices.map((c) => c.probability ?? (ourIds.length ? 1 / ourIds.length : 1));
  const pTheir = ev.replies.map((r) => r.probability ?? (theirIds.length ? 1 / theirIds.length : 1));

  const jointProbs = new Map<string, number>();
  for (let i = 0; i < ourIds.length; i++) {
    for (let j = 0; j < theirIds.length; j++) {
      jointProbs.set(pairKey(ourIds[i]!, theirIds[j]!), (pOur[i] ?? 0) * (pTheir[j] ?? 0));
    }
  }

  const omitted = typeof ev.diagnostics?.omittedPairs === 'number' ? ev.diagnostics.omittedPairs : 0;
  return {
    pOur,
    pTheir,
    jointProbs,
    diagnostics: ev.diagnostics,
    omittedPairs: omitted,
    evaluation: ev,
  };
}

async function refineLoop(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  branches: Branch[],
  pOur: number[],
  pTheir: number[],
  weights: ScoreWeights,
  opts: EvaluateOptions,
): Promise<{ pOur: number[]; pTheir: number[]; diagnostics?: Record<string, unknown> }> {
  const process = opts.refine;
  if (!process) return { pOur, pTheir };
  const iters = opts.refineIters ?? REFINE_ITERS;
  let diag: Record<string, unknown> | undefined;
  let nextOur = pOur;
  let nextTheir = pTheir;
  for (let n = 0; n < iters; n++) {
    const assembled = assemble(legal, replies, cells, branches, nextOur, nextTheir, weights);
    const sorted = assembled.pairs.slice().sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    const capped = capJointPairs(sorted, legal.map((a) => a.id), replies.map((r) => r.id), JOINT_CAP);
    const pairRows = capped.kept;
    const pairIds = pairRows.map((p) => pairKey(p.ourId, p.theirId));
    const pairScores = pairRows.map((p) => signedLog1p(p.score));
    try {
      const joint = await policyProbs(process, pairIds, pairScores, opts);
      diag = { ...joint.diagnostics, omittedPairs: capped.omitted };
      const marg = marginalize(pairIds, joint.probs, legal.map((a) => a.id), replies.map((r) => r.id));
      nextOur = marg.pOur;
      nextTheir = marg.pTheir;
    } catch {
      const ourScores = assembled.choices.map((c) => c.scaledChoiceScore);
      const theirScores = assembled.replies.map((r) => signedLog1p(r.choiceScore));
      try {
        const ours = await policyProbs(process, legal.map((a) => a.id), ourScores, opts);
        const theirs = await policyProbs(process, replies.map((r) => r.id), theirScores, opts);
        nextOur = ours.probs;
        nextTheir = theirs.probs;
        diag = { ...ours.diagnostics, omittedPairs: capped.omitted };
      } catch (err2) {
        if (opts.refineFallback === 'throw') throw err2;
        nextOur = softmax(ourScores);
        nextTheir = softmax(theirScores);
        diag = { mode: 'softmax', fallback: true, omittedPairs: capped.omitted };
      }
    }
  }
  return { pOur: nextOur, pTheir: nextTheir, diagnostics: diag };
}

export async function evaluateRound(obs: BattleObservation, opts?: EvaluateOptions): Promise<RoundEvaluation> {
  const legal = obs.legalActions.length ? obs.legalActions : legalActionsForEval(obs);
  const chanceN = opts?.chanceSeeds ?? CHANCE_SEEDS;
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const valuations = opts?.valuations ?? loadDefaultValuations();
  const theirIdx = activeIndex(obs.theirs);
  const ourIdx = activeIndex(obs.ours);

  const pairAcc = new Map<string, PairCell>();
  const replyById = new Map<string, LegalAction>();
  const branches: Branch[] = [];
  let hypothesisUnavailable = 0;
  const coverage = new Set<string>();

  const rawHyps: SetHypothesis[] = (obs.theirs.find((s) => s.active)?.hypotheses?.length
    ? obs.theirs.find((s) => s.active)!.hypotheses
    : [{ set: obs.theirs.find((s) => s.active)?.set ?? { species: 'smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'hardy' }, count: 1, probability: 1 }]);
  const usableHyps: SetHypothesis[] = [];
  for (const hyp of rawHyps) {
    if (!theirActions(obs, hyp.set).length) {
      hypothesisUnavailable += 1;
      continue;
    }
    usableHyps.push(hyp);
  }
  const hypMass = usableHyps.reduce((s, h) => s + h.probability, 0);
  const hyps = hypMass > 0
    ? usableHyps.map((h) => ({ ...h, probability: h.probability / hypMass }))
    : [];

  for (const action of legal) {
    for (const hyp of hyps) {
      const replies = theirActions(obs, hyp.set);
      const theirSets = obs.theirs.map((s) => (s.active ? hyp.set : (s.set ?? hyp.set)));
      for (const reply of replies) {
        replyById.set(reply.id, reply);
        const key = pairKey(action.id, reply.id);
        for (let k = 0; k < chanceN; k++) {
          const seed = [1 + k, 2, 3, 4];
          let result: RoundSimResult;
          try {
            result = simulateRound(obs, action, reply, seed, theirSets);
          } catch (err) {
            if (err instanceof IllegalSimChoiceError && !replies.some((a) => a.id === reply.id)) {
              hypothesisUnavailable += 1;
              continue;
            }
            throw err;
          }
          const w = hyp.probability / chanceN;
          const scored = scoreRealizedPair(obs, action, reply, result, weights, valuations);
          for (const c of scored.coverage) coverage.add(c);
          const ourAfter = result.afterOurs[ourIdx];
          const ourFaint = ourAfter && (ourAfter.fainted || ourAfter.hp <= 0) ? 1 : 0;
          const theirHpLost = Math.max(0, hpFrac(obs.theirs, theirIdx) - hpFrac(result.afterTheirs, theirIdx));
          const post = observationStateScore(result.afterOurs, result.afterTheirs);
          branches.push({
            action, reply, w, turnScore: scored.pairDelta, post, parts: scored.parts, success: scored.ourSuccess,
            ourFaint, theirHpLost, ourRemain: hpFrac(obs.ours, ourIdx),
            pWin: result.weWin ? 1 : 0, pLoss: result.theyWin ? 1 : 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx),
            theirHAfter: hpFrac(result.afterTheirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx),
            ourHAfter: hpFrac(result.afterOurs, ourIdx),
            theirVal: scored.theirScore,
          });
          let cell = pairAcc.get(key);
          if (!cell) {
            cell = emptyCell(action, reply);
            pairAcc.set(key, cell);
          }
          cell.w += w;
          addParts(cell.parts, scored.parts, w);
          cell.success += scored.ourSuccess * w;
          cell.post += post * w;
          cell.ourFaint += ourFaint * w;
          cell.theirHpLost += theirHpLost * w;
          cell.ourRemain += hpFrac(obs.ours, ourIdx) * w;
          cell.pWin += (result.weWin ? 1 : 0) * w;
          cell.pLoss += (result.theyWin ? 1 : 0) * w;
          cell.theirHBefore += hpFrac(obs.theirs, theirIdx) * w;
          cell.theirHAfter += hpFrac(result.afterTheirs, theirIdx) * w;
          cell.ourHBefore += hpFrac(obs.ours, ourIdx) * w;
          cell.ourHAfter += hpFrac(result.afterOurs, ourIdx) * w;
          cell.turnScore += scored.pairDelta * w;
          cell.theirVal += scored.theirScore * w;
          cell.ourSuccessW += scored.ourSuccess * w;
          cell.theirSuccessW += scored.theirSuccess * w;
          addFeat(cell.ourFeatAcc, scored.ourFeatures, scored.ourSuccess * w);
          addFeat(cell.theirFeatAcc, scored.theirFeatures, scored.theirSuccess * w);
        }
      }
    }
  }

  if (!branches.length) {
    const empty = assemble(legal, [], new Map(), [], legal.map(() => (legal.length ? 1 / legal.length : 0)), [], weights);
    return {
      choices: empty.choices,
      replies: [],
      roundScore: 0,
      expectedRoundScore: 0,
      minRoundScore: 0,
      maxRoundScore: 0,
      forcedOutcome: 'none',
      mateProbability: 0,
      pairs: [],
      diagnostics: hypothesisUnavailable ? { hypothesisUnavailable } : undefined,
    };
  }

  const cells = new Map<string, PairCell>();
  for (const [k, v] of pairAcc) cells.set(k, meanCell(v));

  const replies = [...replyById.values()];
  const uniformOur = legal.map(() => (legal.length ? 1 / legal.length : 0));
  const uniformTheir = replies.map(() => (replies.length ? 1 / replies.length : 0));

  const first = assemble(legal, replies, cells, branches, uniformOur, uniformTheir, weights);
  const pTheir = softmax(first.replies.map((r) => r.choiceScore));
  const pOurSoft = softmax(first.choices.map((c) => c.scaledChoiceScore));
  const refined = await refineLoop(legal, replies, cells, branches, pOurSoft, pTheir.length ? pTheir : uniformTheir, weights, opts ?? {});
  const final = assemble(legal, replies, cells, branches, refined.pOur, refined.pTheir, weights);
  const mate = mateFromForced(final.forcedRows);
  const expected = expectedFromPolicy(legal, replies, cells, refined.pOur, refined.pTheir);
  const roundExt = scoreExtrema(branches.map((b) => b.turnScore));
  const coverageList = [...coverage];
  const diag: Record<string, unknown> = {
    ...refined.diagnostics,
    ...(hypothesisUnavailable ? { hypothesisUnavailable } : {}),
    ...(coverageList.length ? { unvaluedEffects: coverageList } : {}),
  };
  return {
    choices: final.choices,
    replies: final.replies,
    roundScore: expected,
    expectedRoundScore: expected,
    minRoundScore: roundExt.min,
    maxRoundScore: roundExt.max,
    forcedOutcome: mate.forcedOutcome,
    mateProbability: mate.mateProbability,
    pairs: final.pairs,
    diagnostics: Object.keys(diag).length ? diag : undefined,
  };
}
