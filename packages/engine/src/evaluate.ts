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
  /** Test seam: skip Showdown and supply D(i,j,h) directly. */
  pairDelta?: (ourId: string, theirId: string, hypothesisKey: string) => number;
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

/** Active-slot simulation assumptions. Public hypotheses on the slot are left for display. */
export function simulationAssumptions(active: SlotSnapshot | undefined): SetHypothesis[] {
  if (!active) throw new Error('no complete simulation assumption for the opponent active');
  if (active.setSource === 'manual') {
    if (!setIsComplete(active.set)) throw new Error('manual override has no complete set');
    return [{ set: active.set!, count: 1, probability: 1 }];
  }
  if (active.hypotheses?.length) {
    const mass = active.hypotheses.reduce((s, h) => s + h.probability, 0);
    if (!(mass > 0) || !Number.isFinite(mass)) {
      throw new Error('hypothesis mass is zero or non-finite');
    }
    return active.hypotheses.map((h) => ({ ...h, probability: h.probability / mass }));
  }
  if (setIsComplete(active.set)) {
    return [{ set: active.set!, count: 1, probability: 1 }];
  }
  throw new Error('no complete simulation assumption for the opponent active');
}

function hypothesisKey(set: CanonicalSet): string {
  return canonicalizeSet(set);
}

function theirSetsForHyp(obs: BattleObservation, hypSet: CanonicalSet): CanonicalSet[] {
  return obs.theirs.map((s) => {
    if (s.active) return hypSet;
    if (!s.revealed) return s.set ?? placeholderSet();
    if (s.setSource === 'manual' && s.set) return s.set;
    if (setIsComplete(s.set)) return s.set!;
    if (s.hypotheses.length) return s.hypotheses[0]!.set;
    return s.set ?? placeholderSet();
  });
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
  hypKey: string;
  hypProbability: number;
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
  hypKey: string;
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

function emptyCell(action: LegalAction, reply: LegalAction, hypKey: string, hypProbability: number): PairCell {
  return {
    action, reply, hypKey, hypProbability, w: 0, parts: emptyImpactParts(), success: 0, post: 0,
    ourFaint: 0, theirHpLost: 0, ourRemain: 0,
    pWin: 0, pLoss: 0, theirHBefore: 0, theirHAfter: 0, ourHBefore: 0, ourHAfter: 0,
    turnScore: 0, theirVal: 0,
    ourFeatures: emptyFeatures(), theirFeatures: emptyFeatures(),
    ourSuccessW: 0, theirSuccessW: 0,
    ourFeatAcc: emptyFeatures(), theirFeatAcc: emptyFeatures(),
  };
}

function cellKey(hypKey: string, ourId: string, theirId: string): string {
  return `${hypKey}\n${ourId}\n${theirId}`;
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

export interface HypothesisPolicy {
  key: string;
  set: CanonicalSet;
  probability: number;
  actions: LegalAction[];
  probabilities: number[];
  availabilityByAction: Record<string, number>;
}

export interface PairEvaluationCell {
  ourAction: LegalAction;
  theirAction: LegalAction;
  hypothesisKey: string;
  hypothesisProbability: number;
  pairDelta: number;
}

export interface TwoSidedPolicyDiagnostics {
  iterations: number;
  maxPolicyDelta: number;
  hypothesisMass: number;
  legalPairCount: number;
}

export interface JointPolicyResult {
  pOur: number[];
  hypotheses: HypothesisPolicy[];
  evaluation: RoundEvaluation;
  diagnostics: TwoSidedPolicyDiagnostics;
}

interface HypGrid {
  key: string;
  set: CanonicalSet;
  probability: number;
  actions: LegalAction[];
}

function deltaOf(cells: Map<string, PairCell>, hypKey: string, ourId: string, theirId: string): number | undefined {
  const cell = cells.get(cellKey(hypKey, ourId, theirId));
  return cell ? cell.turnScore : undefined;
}

function lInf(a: number[], b: number[]): number {
  let m = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

export async function evaluateTwoSidedPolicy(
  ourActions: LegalAction[],
  grids: HypGrid[],
  cells: Map<string, PairCell>,
  opts: EvaluateOptions,
): Promise<{
  pOur: number[];
  ourUtility: number[];
  hypotheses: HypothesisPolicy[];
  roundScore: number;
  diagnostics: TwoSidedPolicyDiagnostics;
  transformDiagnostics: Record<string, unknown>;
}> {
  const n = ourActions.length;
  let pOur = n ? ourActions.map(() => 1 / n) : [];
  const hypProbs: number[][] = grids.map((g) => g.actions.map(() => (g.actions.length ? 1 / g.actions.length : 0)));
  const iters = opts.refineIters ?? REFINE_ITERS;
  let maxPolicyDelta = 0;
  let lastDiag: Record<string, unknown> = {};

  for (let t = 0; t < iters; t++) {
    for (let h = 0; h < grids.length; h++) {
      const g = grids[h]!;
      const oppUtil = g.actions.map((reply) => {
        let u = 0;
        for (let i = 0; i < n; i++) {
          const d = deltaOf(cells, g.key, ourActions[i]!.id, reply.id);
          if (d === undefined) continue;
          u += (pOur[i] ?? 0) * (-d);
        }
        return u;
      });
      const transformed = await transformSidePolicy(
        opts.refine,
        g.actions.map((a) => a.id),
        oppUtil,
        opts,
        { actor: 'theirs', hypothesis: true },
      );
      hypProbs[h] = transformed.probs;
      lastDiag = transformed.diagnostics;
    }

    const ourUtil = ourActions.map((action) => {
      let u = 0;
      for (let h = 0; h < grids.length; h++) {
        const g = grids[h]!;
        const pH = g.probability;
        const pJ = hypProbs[h]!;
        for (let j = 0; j < g.actions.length; j++) {
          const d = deltaOf(cells, g.key, action.id, g.actions[j]!.id);
          if (d === undefined) continue;
          u += pH * (pJ[j] ?? 0) * d;
        }
      }
      return u;
    });
    const ours = await transformSidePolicy(
      opts.refine,
      ourActions.map((a) => a.id),
      ourUtil,
      opts,
      { actor: 'ours' },
    );
    maxPolicyDelta = Math.max(maxPolicyDelta, lInf(pOur, ours.probs));
    pOur = ours.probs;
    lastDiag = ours.diagnostics;
  }

  const ourUtility = ourActions.map((action) => {
    let u = 0;
    for (let h = 0; h < grids.length; h++) {
      const g = grids[h]!;
      const pJ = hypProbs[h]!;
      for (let j = 0; j < g.actions.length; j++) {
        const d = deltaOf(cells, g.key, action.id, g.actions[j]!.id);
        if (d === undefined) continue;
        u += g.probability * (pJ[j] ?? 0) * d;
      }
    }
    return u;
  });
  const roundScore = clamp(pOur.reduce((s, p, i) => s + p * (ourUtility[i] ?? 0), 0), -1, 1);

  const hypotheses: HypothesisPolicy[] = grids.map((g, h) => {
    const availabilityByAction: Record<string, number> = {};
    for (const a of g.actions) availabilityByAction[a.id] = g.probability;
    return {
      key: g.key,
      set: g.set,
      probability: g.probability,
      actions: g.actions,
      probabilities: hypProbs[h] ?? [],
      availabilityByAction,
    };
  });

  let legalPairCount = 0;
  for (const g of grids) legalPairCount += n * g.actions.length;
  const hypothesisMass = grids.reduce((s, g) => s + g.probability, 0);

  return {
    pOur,
    ourUtility,
    hypotheses,
    roundScore,
    diagnostics: { iterations: iters, maxPolicyDelta, hypothesisMass, legalPairCount },
    transformDiagnostics: lastDiag,
  };
}

function displayReplyMass(hypotheses: HypothesisPolicy[]): {
  replies: LegalAction[];
  probability: number[];
  availability: number[];
  expectedUtility: number[];
  hypothesisCount: number[];
} {
  const byId = new Map<string, LegalAction>();
  const avail = new Map<string, number>();
  const mass = new Map<string, number>();
  const hypCount = new Map<string, number>();
  for (const h of hypotheses) {
    for (let j = 0; j < h.actions.length; j++) {
      const a = h.actions[j]!;
      byId.set(a.id, a);
      avail.set(a.id, (avail.get(a.id) ?? 0) + h.probability);
      mass.set(a.id, (mass.get(a.id) ?? 0) + h.probability * (h.probabilities[j] ?? 0));
      hypCount.set(a.id, (hypCount.get(a.id) ?? 0) + 1);
    }
  }
  const replies = [...byId.values()];
  return {
    replies,
    probability: replies.map((a) => mass.get(a.id) ?? 0),
    availability: replies.map((a) => avail.get(a.id) ?? 0),
    expectedUtility: replies.map(() => 0),
    hypothesisCount: replies.map((a) => hypCount.get(a.id) ?? 0),
  };
}

function opponentExpectedUtility(
  reply: LegalAction,
  legal: LegalAction[],
  pOur: number[],
  hypotheses: HypothesisPolicy[],
  cells: Map<string, PairCell>,
  availability: number,
): number {
  if (!(availability > 0)) return 0;
  let u = 0;
  for (const h of hypotheses) {
    if (!h.actions.some((a) => a.id === reply.id)) continue;
    let inner = 0;
    for (let i = 0; i < legal.length; i++) {
      const d = deltaOf(cells, h.key, legal[i]!.id, reply.id);
      if (d === undefined) continue;
      inner += (pOur[i] ?? 0) * (-d);
    }
    u += (h.probability / availability) * inner;
  }
  return u;
}

function assemble(
  legal: LegalAction[],
  hypotheses: HypothesisPolicy[],
  cells: Map<string, PairCell>,
  branches: Branch[],
  pOur: number[],
  ourUtility: number[],
  weights: ScoreWeights,
): { choices: ChoiceEvaluation[]; replies: ReplyEvaluation[]; postScores: number[]; forcedRows: Array<Array<{ pWin: number; pLoss: number }>>; pairs: PairScore[] } {
  const display = displayReplyMass(hypotheses);
  const replies = display.replies;
  const choices: ChoiceEvaluation[] = [];
  const postScores: number[] = [];
  const forcedRows: Array<Array<{ pWin: number; pLoss: number }>> = [];
  const pairs: PairScore[] = [];

  for (let i = 0; i < legal.length; i++) {
    const action = legal[i]!;
    const mixed = mixActor(hypotheses.flatMap((h) => h.actions.map((reply, j) => {
      const cell = cells.get(cellKey(h.key, action.id, reply.id));
      if (!cell) {
        throw new Error(`missing cell ${JSON.stringify({ hyp: h.key, our: action.id, their: reply.id, keys: [...cells.keys()] })}`);
      }
      const w = h.probability * (h.probabilities[j] ?? 0);
      if (!(w > 0)) {
        throw new Error(`zero mix weight ${JSON.stringify({ pH: h.probability, pJ: h.probabilities, j, reply: reply.id, cellSuccess: cell.success, cellW: cell.w, ourSW: cell.ourSuccessW })}`);
      }
      return [{ w, cell }];
    })), 'ours');
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
      expectedUtility: ourUtility[i],
    });
    forcedRows.push(replies.map((reply) => {
      let pWin = 0;
      let pLoss = 0;
      let w = 0;
      for (const h of hypotheses) {
        const cell = cells.get(cellKey(h.key, action.id, reply.id));
        if (!cell) continue;
        const ww = h.probability;
        w += ww;
        pWin += (cell.pWin ?? 0) * ww;
        pLoss += (cell.pLoss ?? 0) * ww;
      }
      const inv = w > 0 ? 1 / w : 0;
      return { pWin: pWin * inv, pLoss: pLoss * inv };
    }));
  }

  const replyEvals: ReplyEvaluation[] = replies.map((reply, j) => {
    const availability = display.availability[j] ?? 0;
    const mixed = mixActor(hypotheses.flatMap((h) => {
      if (!h.actions.some((a) => a.id === reply.id)) return [];
      return legal.flatMap((action, i) => {
        const cell = cells.get(cellKey(h.key, action.id, reply.id));
        return cell ? [{ w: h.probability * (pOur[i] ?? 0), cell }] : [];
      });
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
      probability: display.probability[j],
      availability,
      expectedUtility: opponentExpectedUtility(reply, legal, pOur, hypotheses, cells, availability),
      hypothesisCount: display.hypothesisCount[j],
      minTurnScore: range.minTurn,
      maxTurnScore: range.maxTurn,
      meanPostScore: mixed.post,
      minPostScore: range.minPost,
      maxPostScore: range.maxPost,
      sampleCount: range.n,
    };
  });

  for (const action of legal) {
    const byReply = new Map<string, { score: number; w: number }>();
    for (const h of hypotheses) {
      for (const reply of h.actions) {
        const cell = cells.get(cellKey(h.key, action.id, reply.id));
        if (!cell) continue;
        const ourScore = scoredChoice(cell.success, cell.ourFeatures, weights);
        const theirCta = cell.w > 0 ? cell.theirSuccessW / cell.w : 0;
        const theirScore = scoredChoice(theirCta, cell.theirFeatures, weights);
        const d = clamp(ourScore - theirScore, -1, 1);
        const prev = byReply.get(reply.id) ?? { score: 0, w: 0 };
        prev.score += d * h.probability;
        prev.w += h.probability;
        byReply.set(reply.id, prev);
      }
    }
    for (const [theirId, acc] of byReply) {
      pairs.push({ ourId: action.id, theirId, score: acc.w > 0 ? acc.score / acc.w : 0 });
    }
  }

  return { choices, replies: replyEvals, postScores, forcedRows, pairs };
}

function emptyRound(legal: LegalAction[], extra?: Record<string, unknown>): RoundEvaluation {
  const p = legal.map(() => (legal.length ? 1 / legal.length : 0));
  return {
    choices: legal.map((action, i) => ({
      action,
      success: 0,
      expectedImpact: 0,
      expectedHealthDelta: 0,
      expectedModifierDelta: 0,
      ourHealth: 0,
      theirHealth: 0,
      ourModifier: 0,
      theirModifier: 0,
      hitsToKill: null,
      choiceScore: 0,
      scaledChoiceScore: 0,
      meanPostScore: 0,
      minTurnScore: 0,
      maxTurnScore: 0,
      minPostScore: 0,
      maxPostScore: 0,
      sampleCount: 0,
      features: emptyFeatures(),
      probability: p[i],
      expectedUtility: 0,
    })),
    replies: [],
    roundScore: 0,
    expectedRoundScore: 0,
    minRoundScore: 0,
    maxRoundScore: 0,
    forcedOutcome: 'none',
    mateProbability: 0,
    pairs: [],
    diagnostics: extra && Object.keys(extra).length ? extra : undefined,
  };
}

function addBranchToCell(
  pairAcc: Map<string, PairCell>,
  action: LegalAction,
  reply: LegalAction,
  hypKey: string,
  hypProbability: number,
  w: number,
  scored: { pairDelta: number; parts: ImpactParts; ourSuccess: number; theirSuccess: number; ourFeatures: ChoiceFeatures; theirFeatures: ChoiceFeatures; theirScore: number },
  extras: {
    post: number; ourFaint: number; theirHpLost: number; ourRemain: number;
    pWin: number; pLoss: number;
    theirHBefore: number; theirHAfter: number; ourHBefore: number; ourHAfter: number;
  },
): void {
  const key = cellKey(hypKey, action.id, reply.id);
  let cell = pairAcc.get(key);
  if (!cell) {
    cell = emptyCell(action, reply, hypKey, hypProbability);
    pairAcc.set(key, cell);
  }
  cell.w += w;
  addParts(cell.parts, scored.parts, w);
  cell.success += scored.ourSuccess * w;
  cell.post += extras.post * w;
  cell.ourFaint += extras.ourFaint * w;
  cell.theirHpLost += extras.theirHpLost * w;
  cell.ourRemain += extras.ourRemain * w;
  cell.pWin += extras.pWin * w;
  cell.pLoss += extras.pLoss * w;
  cell.theirHBefore += extras.theirHBefore * w;
  cell.theirHAfter += extras.theirHAfter * w;
  cell.ourHBefore += extras.ourHBefore * w;
  cell.ourHAfter += extras.ourHAfter * w;
  cell.turnScore += scored.pairDelta * w;
  cell.theirVal += scored.theirScore * w;
  cell.ourSuccessW += scored.ourSuccess * w;
  cell.theirSuccessW += scored.theirSuccess * w;
  addFeat(cell.ourFeatAcc, scored.ourFeatures, scored.ourSuccess * w);
  addFeat(cell.theirFeatAcc, scored.theirFeatures, scored.theirSuccess * w);
}

async function evaluateRoundCore(obs: BattleObservation, opts?: EvaluateOptions): Promise<JointPolicyResult> {
  const legal = obs.legalActions.length ? obs.legalActions : legalActionsForEval(obs);
  const chanceN = Math.max(1, opts?.chanceSeeds ?? CHANCE_SEEDS);
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const valuations = opts?.valuations ?? loadDefaultValuations();
  const theirIdx = activeIndex(obs.theirs);
  const ourIdx = activeIndex(obs.ours);
  const injected = opts?.pairDelta;

  const pairAcc = new Map<string, PairCell>();
  const branches: Branch[] = [];
  let hypothesisUnavailable = 0;
  const coverage = new Set<string>();

  const rawHyps = simulationAssumptions(obs.theirs.find((s) => s.active));
  const grids: HypGrid[] = [];
  for (const hyp of rawHyps) {
    const replies = theirActions(obs, hyp.set);
    if (!replies.length) {
      hypothesisUnavailable += 1;
      continue;
    }
    grids.push({
      key: hypothesisKey(hyp.set),
      set: hyp.set,
      probability: hyp.probability,
      actions: replies,
    });
  }
  const gridMass = grids.reduce((s, g) => s + g.probability, 0);
  if (gridMass > 0) {
    for (const g of grids) g.probability /= gridMass;
  }

  for (const action of legal) {
    for (const g of grids) {
      const theirSets = theirSetsForHyp(obs, g.set);
      for (const reply of g.actions) {
        if (injected) {
          const d = clamp(injected(action.id, reply.id, g.key), -1, 1);
          const scored = {
            pairDelta: d,
            parts: emptyImpactParts(),
            ourSuccess: 1,
            theirSuccess: 1,
            ourFeatures: emptyFeatures(),
            theirFeatures: emptyFeatures(),
            theirScore: 0,
          };
          addBranchToCell(pairAcc, action, reply, g.key, g.probability, 1, scored, {
            post: 0, ourFaint: 0, theirHpLost: 0, ourRemain: hpFrac(obs.ours, ourIdx),
            pWin: 0, pLoss: 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx), theirHAfter: hpFrac(obs.theirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx), ourHAfter: hpFrac(obs.ours, ourIdx),
          });
          branches.push({
            action, reply, hypKey: g.key, w: 1, turnScore: d, post: 0, parts: emptyImpactParts(), success: 1,
            ourFaint: 0, theirHpLost: 0, ourRemain: hpFrac(obs.ours, ourIdx),
            pWin: 0, pLoss: 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx), theirHAfter: hpFrac(obs.theirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx), ourHAfter: hpFrac(obs.ours, ourIdx),
            theirVal: 0,
          });
          continue;
        }
        for (let k = 0; k < chanceN; k++) {
          const seed = [1 + k, 2, 3, 4];
          let result: RoundSimResult;
          try {
            result = simulateRound(obs, action, reply, seed, theirSets);
          } catch (err) {
            if (err instanceof IllegalSimChoiceError && !g.actions.some((a) => a.id === reply.id)) {
              hypothesisUnavailable += 1;
              continue;
            }
            throw err;
          }
          const w = 1 / chanceN;
          const scored = scoreRealizedPair(obs, action, reply, result, weights, valuations);
          if (action.moveId === 'earthquake') {
            console.log('ohko-debug', reply.id, {
              ourSuccess: scored.ourSuccess,
              theirSuccess: scored.theirSuccess,
              pairDelta: scored.pairDelta,
              executed: result.ours.executed,
              hit: result.ours.hit,
              alive: result.ours.aliveAtExecution,
            });
          }
          for (const c of scored.coverage) coverage.add(c);
          const ourAfter = result.afterOurs[ourIdx];
          const ourFaint = ourAfter && (ourAfter.fainted || ourAfter.hp <= 0) ? 1 : 0;
          const theirHpLost = Math.max(0, hpFrac(obs.theirs, theirIdx) - hpFrac(result.afterTheirs, theirIdx));
          const post = observationStateScore(result.afterOurs, result.afterTheirs);
          branches.push({
            action, reply, hypKey: g.key, w, turnScore: scored.pairDelta, post, parts: scored.parts, success: scored.ourSuccess,
            ourFaint, theirHpLost, ourRemain: hpFrac(obs.ours, ourIdx),
            pWin: result.weWin ? 1 : 0, pLoss: result.theyWin ? 1 : 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx),
            theirHAfter: hpFrac(result.afterTheirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx),
            ourHAfter: hpFrac(result.afterOurs, ourIdx),
            theirVal: scored.theirScore,
          });
          addBranchToCell(pairAcc, action, reply, g.key, g.probability, w, scored, {
            post, ourFaint, theirHpLost, ourRemain: hpFrac(obs.ours, ourIdx),
            pWin: result.weWin ? 1 : 0, pLoss: result.theyWin ? 1 : 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx),
            theirHAfter: hpFrac(result.afterTheirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx),
            ourHAfter: hpFrac(result.afterOurs, ourIdx),
          });
        }
      }
    }
  }

  const emptyDiag = {
    iterations: 0,
    maxPolicyDelta: 0,
    hypothesisMass: grids.reduce((s, g) => s + g.probability, 0),
    legalPairCount: 0,
  };
  if (!branches.length) {
    const ev = emptyRound(legal, hypothesisUnavailable ? { hypothesisUnavailable } : undefined);
    return { pOur: ev.choices.map((c) => c.probability ?? 0), hypotheses: [], evaluation: ev, diagnostics: emptyDiag };
  }

  const cells = new Map<string, PairCell>();
  for (const [k, v] of pairAcc) {
    const m = meanCell(v);
    if (v.action.moveId === 'earthquake') {
      console.log('meanCell', k, { w: v.w, ourSW: v.ourSuccessW, accSuccess: v.success, meanSuccess: m.success, turn: m.turnScore });
    }
    cells.set(k, m);
  }

  const policy = await evaluateTwoSidedPolicy(legal, grids, cells, opts ?? {});
  const final = assemble(legal, policy.hypotheses, cells, branches, policy.pOur, policy.ourUtility, weights);
  const mate = mateFromForced(final.forcedRows);
  const roundExt = scoreExtrema(branches.map((b) => b.turnScore));
  const coverageList = [...coverage];
  const diag: Record<string, unknown> = {
    ...policy.diagnostics,
    ...policy.transformDiagnostics,
    ...(hypothesisUnavailable ? { hypothesisUnavailable } : {}),
    ...(coverageList.length ? { unvaluedEffects: coverageList } : {}),
  };
  const evaluation: RoundEvaluation = {
    choices: final.choices,
    replies: final.replies,
    roundScore: policy.roundScore,
    expectedRoundScore: policy.roundScore,
    minRoundScore: roundExt.min,
    maxRoundScore: roundExt.max,
    forcedOutcome: mate.forcedOutcome,
    mateProbability: mate.mateProbability,
    pairs: final.pairs,
    diagnostics: Object.keys(diag).length ? diag : undefined,
  };
  return {
    pOur: policy.pOur,
    hypotheses: policy.hypotheses,
    evaluation,
    diagnostics: policy.diagnostics,
  };
}

export async function evaluateRound(obs: BattleObservation, opts?: EvaluateOptions): Promise<RoundEvaluation> {
  return (await evaluateRoundCore(obs, opts)).evaluation;
}

export async function evaluateJointStatePolicy(
  obs: BattleObservation,
  opts?: EvaluateOptions,
): Promise<JointPolicyResult> {
  return evaluateRoundCore(obs, opts);
}

