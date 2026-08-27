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
import { actionId, observationTera } from './observation.js';
import {
  choiceFeatures,
  cta,
  DEFAULT_WEIGHTS,
  damageScore,
  effectiveHeal,
  emptyImpactParts,
  expectedTtk,
  finiteOrZero,
  hitsToKill,
  impactParts,
  mateFromForced,
  modifierDelta,
  modifiersFromSlot,
  observationStateScore,
  pairTurnScore,
  pokemonValue,
  signedLog1p,
  slotToMonValue,
  softmax,
  switchScore,
  weightedMean,
  scoreExtrema,
  type ChoiceFeatures,
  type ImpactParts,
  type ScoreWeights,
} from './math.js';
import { simulateRound, type ActionEffect, type ActionTelemetry, type RoundSimResult } from './sim.js';
import { legalActionsForEval, toMoveId } from './actions.js';
import type { QuantumPolicyProcess } from './policy.js';

const CHANCE_SEEDS = 4;
const REFINE_ITERS = 2;
const JOINT_CAP = 32;

export interface EvaluateOptions {
  chanceSeeds?: number;
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

export function theirActions(obs: BattleObservation, hyp: CanonicalSet | undefined): LegalAction[] {
  const active = obs.theirs.find((s) => s.active) ?? obs.theirs[0];
  const rawMoves = hyp?.moves?.length ? hyp.moves : (active?.knownMoves ?? []);
  const moves = rawMoves.map((m) => toMoveId(m)).filter(Boolean);
  const canTera = !observationTera(obs).theirs && Boolean(hyp?.teraType) && !active?.terastallized;
  const isChoiceLocked = Boolean(active?.choiceLock);
  const isTrapped = Boolean(active?.trapped);

  const out: LegalAction[] = [];
  for (const moveId of moves) {
    if (isChoiceLocked && active && moveId !== toMoveId(active.choiceLock ?? '')) continue;
    out.push({ id: actionId({ type: 'move', moveId, tera: false }), type: 'move', moveId, tera: false });
    if (canTera) {
      out.push({ id: actionId({ type: 'move', moveId, tera: true }), type: 'move', moveId, tera: true });
    }
  }
  if (!isTrapped) {
    for (const slot of obs.theirs) {
      if (slot.active || slot.fainted || !slot.revealed || slot.hp <= 0) continue;
      out.push({ id: actionId({ type: 'switch', slot: slot.slot + 1 }), type: 'switch', slot: slot.slot + 1 });
    }
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

function fracFromEffect(e: ActionEffect): number {
  if (!(e.maxHp && e.maxHp > 0) || e.hpBefore == null || e.hpAfter == null) return 0;
  return (e.hpBefore - e.hpAfter) / e.maxHp;
}

function actorValue(
  tel: ActionTelemetry,
  actorOurs: boolean,
  obs: BattleObservation,
  afterFoe: SlotSnapshot[],
): { value: number; parts: ImpactParts; success: number } {
  const success = cta(tel.executed ? 1 : 0, tel.hit ? 1 : 0, tel.aliveAtExecution ? 1 : 0);
  const foe = actorOurs ? obs.theirs : obs.ours;
  const self = actorOurs ? obs.ours : obs.theirs;
  const foeIdx = activeIndex(foe);
  const selfIdx = activeIndex(self);
  const foeSide: 'p1' | 'p2' = actorOurs ? (obs.ourSide === 'p1' ? 'p2' : 'p1') : obs.ourSide;
  const selfSide = actorOurs ? obs.ourSide : (obs.ourSide === 'p1' ? 'p2' : 'p1');

  let dmgToFoe = 0;
  let healSelf = 0;
  let healFoe = 0;
  let selfLost = 0;
  for (const e of tel.effects) {
    if (!e.attributed) continue;
    if (e.kind === 'damage' || e.kind === 'drain') {
      const frac = Math.max(0, fracFromEffect(e));
      if (e.side === foeSide) dmgToFoe += frac;
      if (e.side === selfSide && e.kind === 'damage') selfLost += frac;
    }
    if (e.kind === 'recoil' && e.side === selfSide) selfLost += Math.max(0, fracFromEffect(e));
    if (e.kind === 'heal' || e.kind === 'drain') {
      if (!(e.maxHp && e.maxHp > 0) || e.hpBefore == null || e.hpAfter == null) continue;
      const healed = effectiveHeal(e.hpBefore, e.hpAfter, e.maxHp);
      if (e.side === selfSide) healSelf += healed;
      if (e.side === foeSide) healFoe += healed;
    }
  }
  if (tel.hit && dmgToFoe <= 0) {
    dmgToFoe = Math.max(0, hpFrac(foe, foeIdx) - hpFrac(afterFoe, foeIdx));
  }

  const ttk = expectedTtk(hpFrac(foe, foeIdx), dmgToFoe);
  const dmg = tel.hit ? damageScore(success, ttk) : 0;
  const heal = healSelf - healFoe - selfLost;

  const selfSlot = self[selfIdx];
  const foeSlot = foe[foeIdx];
  let mod = 0;
  if (selfSlot && tel.effects.some((e) => e.attributed && (e.kind === 'boost' || e.kind === 'unboost' || e.kind === 'status') && e.side === selfSide)) {
    mod += modifierDelta(selfSlot.modifiers, slotAfterEffects(selfSlot, tel.effects, selfSide).modifiers);
  }
  if (foeSlot && tel.effects.some((e) => e.attributed && (e.kind === 'boost' || e.kind === 'unboost' || e.kind === 'status') && e.side === foeSide)) {
    mod -= modifierDelta(foeSlot.modifiers, slotAfterEffects(foeSlot, tel.effects, foeSide).modifiers);
  }

  const value = finiteOrZero(dmg + heal + mod);
  const parts = emptyImpactParts();
  if (actorOurs) {
    parts.ourHealth = finiteOrZero(heal);
    parts.theirHealth = finiteOrZero(-dmg);
    parts.ourModifier = finiteOrZero(mod > 0 ? mod : 0);
    parts.theirModifier = finiteOrZero(mod < 0 ? mod : 0);
  } else {
    parts.ourHealth = finiteOrZero(-heal);
    parts.theirHealth = finiteOrZero(dmg);
    parts.ourModifier = finiteOrZero(mod < 0 ? -mod : 0);
    parts.theirModifier = finiteOrZero(mod > 0 ? -mod : 0);
  }
  parts.health = parts.ourHealth - parts.theirHealth;
  parts.modifier = parts.ourModifier - parts.theirModifier;
  parts.total = parts.health + parts.modifier;
  return { value, parts, success };
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

function scoreBranch(
  obs: BattleObservation,
  action: LegalAction,
  result: RoundSimResult,
): { pair: number; ourVal: number; theirVal: number; success: number; parts: ImpactParts } {
  const their = actorValue(result.theirs, false, obs, result.afterOurs);
  if (action.type === 'switch') {
    const after = observationStateScore(result.afterOurs, result.afterTheirs);
    const before = observationStateScore(obs.ours, obs.theirs);
    const pair = switchScore(after, before, their.value);
    return { pair, ourVal: pair, theirVal: their.value, success: 1, parts: emptyImpactParts() };
  }
  const our = actorValue(result.ours, true, obs, result.afterTheirs);
  return {
    pair: pairTurnScore(our.value, their.value),
    ourVal: our.value,
    theirVal: their.value,
    success: our.success,
    parts: our.parts,
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
    pWin: cell.pWin * inv,
    pLoss: cell.pLoss * inv,
    theirHBefore: cell.theirHBefore * inv,
    theirHAfter: cell.theirHAfter * inv,
    ourHBefore: cell.ourHBefore * inv,
    ourHAfter: cell.ourHAfter * inv,
    turnScore: cell.turnScore * inv,
    theirVal: cell.theirVal * inv,
  };
}

function cellFeatures(cell: PairCell): ChoiceFeatures {
  return choiceFeatures(cell.parts, {
    secondary: 0,
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

function mixFeatures(cells: Array<{ w: number; cell: PairCell }>): {
  features: ChoiceFeatures; parts: ImpactParts; success: number; post: number; turn: number; theirVal: number;
  htk: { tb: number; ta: number; ob: number; oa: number };
} {
  const z = {
    features: { health: 0, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 } as ChoiceFeatures,
    parts: emptyImpactParts(),
    success: 0, post: 0, turn: 0, theirVal: 0, tb: 0, ta: 0, ob: 0, oa: 0, w: 0,
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
    z.turn += cell.turnScore * w;
    z.theirVal += cell.theirVal * w;
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

function assemble(
  legal: LegalAction[],
  replies: LegalAction[],
  cells: Map<string, PairCell>,
  branches: Branch[],
  pOur: number[],
  pTheir: number[],
  _weights: ScoreWeights,
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
    const ours = branches.filter((b) => b.action.id === action.id);
    const range = rangeFromBranches(ours);
    const success = action.type === 'switch' ? 1 : Math.min(1, Math.max(0, mixed.success));
    const raw = finiteOrZero(mixed.turn);
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
    const mixed = mixFeatures(legal.flatMap((action, i) => {
      const cell = cells.get(pairKey(action.id, reply.id));
      return cell ? [{ w: pOur[i] ?? 0, cell }] : [];
    }));
    const flipped = flipFeatures(mixed.features);
    const raw = finiteOrZero(mixed.theirVal);
    const rows = branches.filter((b) => b.reply.id === reply.id);
    const range = rangeFromBranches(rows);
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
      pairs.push({ ourId: action.id, theirId: reply.id, score: cell.turnScore });
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
  const theirIdx = activeIndex(obs.theirs);
  const ourIdx = activeIndex(obs.ours);
  const ourActive = obs.ours[ourIdx];
  const ourRemain = ourActive ? pokemonValue(slotToMonValue(ourActive, 'ours')) : 0;

  const pairAcc = new Map<string, PairCell>();
  const replyById = new Map<string, LegalAction>();
  const branches: Branch[] = [];

  for (const action of legal) {
    const hyps: SetHypothesis[] = (obs.theirs.find((s) => s.active)?.hypotheses?.length
      ? obs.theirs.find((s) => s.active)!.hypotheses
      : [{ set: obs.theirs.find((s) => s.active)?.set ?? { species: 'smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'hardy' }, count: 1, probability: 1 }]);

    for (const hyp of hyps) {
      const replies = theirActions(obs, hyp.set);
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
          const snapParts = impactParts(before, after);
          const scored = scoreBranch(obs, action, result);
          const ourAfter = result.afterOurs[ourIdx];
          const ourFaint = ourAfter && (ourAfter.fainted || ourAfter.hp <= 0) ? 1 : 0;
          const theirHpLost = Math.max(0, hpFrac(obs.theirs, theirIdx) - hpFrac(result.afterTheirs, theirIdx));
          const post = observationStateScore(result.afterOurs, result.afterTheirs);
          branches.push({
            action, reply, w, turnScore: scored.pair, post, parts: scored.parts, success: scored.success,
            ourFaint, theirHpLost, ourRemain,
            pWin: result.weWin ? 1 : 0, pLoss: result.theyWin ? 1 : 0,
            theirHBefore: hpFrac(obs.theirs, theirIdx),
            theirHAfter: hpFrac(result.afterTheirs, theirIdx),
            ourHBefore: hpFrac(obs.ours, ourIdx),
            ourHAfter: hpFrac(result.afterOurs, ourIdx),
            theirVal: scored.theirVal,
          });
          let cell = pairAcc.get(key);
          if (!cell) {
            cell = {
              action, reply, w: 0, parts: emptyImpactParts(), success: 0, post: 0,
              ourFaint: 0, theirHpLost: 0, ourRemain: 0,
              pWin: 0, pLoss: 0, theirHBefore: 0, theirHAfter: 0, ourHBefore: 0, ourHAfter: 0,
              turnScore: 0, theirVal: 0,
            };
            pairAcc.set(key, cell);
          }
          cell.w += w;
          addParts(cell.parts, scored.parts.total !== 0 || scored.parts.health !== 0 ? scored.parts : snapParts, w);
          cell.success += scored.success * w;
          cell.post += post * w;
          cell.ourFaint += ourFaint * w;
          cell.theirHpLost += theirHpLost * w;
          cell.ourRemain += ourRemain * w;
          cell.pWin += (result.weWin ? 1 : 0) * w;
          cell.pLoss += (result.theyWin ? 1 : 0) * w;
          cell.theirHBefore += hpFrac(obs.theirs, theirIdx) * w;
          cell.theirHAfter += hpFrac(result.afterTheirs, theirIdx) * w;
          cell.ourHBefore += hpFrac(obs.ours, ourIdx) * w;
          cell.ourHAfter += hpFrac(result.afterOurs, ourIdx) * w;
          cell.turnScore += scored.pair * w;
          cell.theirVal += scored.theirVal * w;
        }
      }
    }
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
    diagnostics: refined.diagnostics,
  };
}
