import type { FieldSnapshot, ForcedOutcome, Modifier, MonValue, PlayerSide, SlotSnapshot } from './observation.js';

export const EPS = 1e-9;

/**
 * Score contract (our perspective: positive favors us).
 * damageScore = CTA / expectedTTK, CTA = P(executes)×P(hit|executes)×P(alive at resolve).
 * expectedTTK is ≥1 from the target's current HP and damage on hitting branches.
 * Healing is restored HP / max HP, excluding overheal; residuals are not the selected move.
 * modifierValue = 0.5 × tanh(mean(log(multiplier) × expectedRemainingTurns)).
 * pairTurnScore = our attributed action − opponent attributed action.
 * switchScore = stateScore(after) − stateScore(before) − attributedOpponentActionScore.
 * signedLog1p is Hamiltonian/display only.
 */

/** Documented duration estimates when Showdown does not expose remaining turns. */
export const MODIFIER_TURNS = {
  boost: 6,
  burn: 3,
  para: 3,
  screen: 5,
} as const;

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function sigmoid(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

export function signedLog1p(x: number): number {
  return Math.sign(x) * Math.log1p(Math.abs(x));
}

export function meanModifier(mods: Modifier[]): number {
  if (!mods.length) return 0;
  let s = 0;
  for (const m of mods) {
    const mult = Math.max(m.multiplier, EPS);
    s += Math.log(mult) * m.remainingTurns;
  }
  return s / mods.length;
}

export function slotToMonValue(slot: SlotSnapshot, side: 'ours' | 'theirs'): MonValue {
  const maxHp = slot.maxHp > 0 ? slot.maxHp : 1;
  return {
    side,
    revealed: slot.revealed,
    h: slot.fainted ? 0 : clamp(slot.hp / maxHp, 0, 1),
    L: slot.fainted || slot.hp <= 0 ? 0 : 1,
    M: meanModifier(slot.modifiers),
  };
}

export function pokemonValue(mon: MonValue): number {
  if (mon.L <= 0) return 0;
  return mon.L * clamp(mon.h + 0.5 * Math.tanh(mon.M), 0, 1);
}

export function stateScore(mons: MonValue[]): number {
  let s = 0;
  for (const m of mons) {
    const v = pokemonValue(m);
    s += m.side === 'ours' ? v : -v;
  }
  return clamp(s, -6, 6);
}

export function observationStateScore(ours: SlotSnapshot[], theirs: SlotSnapshot[]): number {
  const mons = [
    ...ours.map((s) => slotToMonValue(s, 'ours')),
    ...theirs.map((s) => slotToMonValue(s, 'theirs')),
  ];
  return stateScore(mons);
}

export function cta(pExecute: number, pHit: number, aliveAtExecution: number): number {
  return clamp(pExecute * pHit * aliveAtExecution, 0, 1);
}

export function cts(afterSwitch: number, stay: number, forced: boolean, eps = EPS): number {
  if (forced) return 1;
  const denom = Math.max(Math.abs(stay), eps);
  return sigmoid((afterSwitch - stay) / denom);
}

export interface ImpactParts {
  health: number;
  modifier: number;
  total: number;
  ourHealth: number;
  theirHealth: number;
  ourModifier: number;
  theirModifier: number;
}

export function emptyImpactParts(): ImpactParts {
  return {
    health: 0, modifier: 0, total: 0,
    ourHealth: 0, theirHealth: 0, ourModifier: 0, theirModifier: 0,
  };
}

/** HP-fraction and 0.5·Δtanh(M) deltas, each in [-1, 1], matching pokemonValue units. */
export function impactParts(before: MonValue[], after: MonValue[]): ImpactParts {
  const n = Math.min(before.length, after.length);
  let ourHealth = 0;
  let theirHealth = 0;
  let ourModifier = 0;
  let theirModifier = 0;
  for (let i = 0; i < n; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (!b.revealed && !a.revealed) continue;
    const dh = clamp(a.h - b.h, -1, 1);
    const dM = clamp(0.5 * (Math.tanh(a.M) - Math.tanh(b.M)), -1, 1);
    if (b.side === 'ours') {
      ourHealth += dh;
      ourModifier += dM;
    } else {
      theirHealth += dh;
      theirModifier += dM;
    }
  }
  const health = ourHealth - theirHealth;
  const modifier = ourModifier - theirModifier;
  return { health, modifier, total: health + modifier, ourHealth, theirHealth, ourModifier, theirModifier };
}

export function impact(before: MonValue[], after: MonValue[]): number {
  return impactParts(before, after).total;
}

/** Hits to KO from expected HP fraction lost. Null when no damage. */
export function hitsToKill(hBefore: number, hAfter: number): number | null {
  const damage = hBefore - hAfter;
  if (!(damage > EPS) || !(hBefore > EPS)) return null;
  return Math.ceil(hBefore / damage);
}

/** TTK against current HP from damage on a hitting branch. Null when no damage. */
export function expectedTtk(hBefore: number, damage: number): number | null {
  const ttk = hitsToKill(hBefore, hBefore - damage);
  if (ttk == null) return null;
  return Math.max(1, ttk);
}

/** CTA / TTK. Empty or no-damage branches are 0, never NaN/Inf. */
export function damageScore(ctaVal: number, ttk: number | null): number {
  if (ttk == null || !(ttk >= 1) || !Number.isFinite(ttk) || !Number.isFinite(ctaVal)) return 0;
  return ctaVal / ttk;
}

/** Restored HP / max HP, excluding overheal. */
export function effectiveHeal(hpBefore: number, hpAfter: number, maxHp: number): number {
  if (!(maxHp > EPS) || !Number.isFinite(hpBefore) || !Number.isFinite(hpAfter)) return 0;
  const capBefore = Math.min(Math.max(hpBefore, 0), maxHp);
  const capAfter = Math.min(Math.max(hpAfter, 0), maxHp);
  return Math.max(0, capAfter - capBefore) / maxHp;
}

export function modifierValue(mods: Modifier[]): number {
  return 0.5 * Math.tanh(meanModifier(mods));
}

export function modifierDelta(before: Modifier[], after: Modifier[]): number {
  const d = modifierValue(after) - modifierValue(before);
  return Number.isFinite(d) ? d : 0;
}

export function switchScore(afterState: number, beforeState: number, opponentActionScore: number): number {
  const v = afterState - beforeState - opponentActionScore;
  return Number.isFinite(v) ? v : 0;
}

export function pairTurnScore(ours: number, theirs: number): number {
  const v = ours - theirs;
  return Number.isFinite(v) ? v : 0;
}

export function finiteOrZero(x: number): number {
  return Number.isFinite(x) ? x : 0;
}

export function choiceScore(success: number, expectedImpact: number): number {
  return success * expectedImpact;
}

export interface ScoreWeights {
  health: number;
  modifier: number;
  secondary: number;
  switchRisk: number;
  sacrifice: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  health: 1, modifier: 1, secondary: 1, switchRisk: 1, sacrifice: 1,
};

export const WEIGHT_KEYS = ['health', 'modifier', 'secondary', 'switchRisk', 'sacrifice'] as const;
export type WeightKey = (typeof WEIGHT_KEYS)[number];

export interface ChoiceFeatures {
  health: number;
  modifier: number;
  secondary: number;
  switchRisk: number;
  sacrifice: number;
}

export function emptyFeatures(): ChoiceFeatures {
  return { health: 0, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 };
}

export function choiceFeatures(parts: ImpactParts, extras: { secondary: number; switchRisk: number; sacrifice: number }): ChoiceFeatures {
  return {
    health: parts.health,
    modifier: parts.modifier,
    secondary: extras.secondary,
    switchRisk: extras.switchRisk,
    sacrifice: extras.sacrifice,
  };
}

export function weightedRaw(features: ChoiceFeatures, weights: ScoreWeights): number {
  return weights.health * features.health
    + weights.modifier * features.modifier
    + weights.secondary * features.secondary
    + weights.sacrifice * features.sacrifice
    - weights.switchRisk * features.switchRisk;
}

export function scoredChoice(success: number, features: ChoiceFeatures, weights: ScoreWeights): number {
  return success * weightedRaw(features, weights);
}

export function softmax(scores: number[]): number[] {
  if (!scores.length) return [];
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp(s - m));
  const z = ex.reduce((a, b) => a + b, 0);
  if (!(z > 0)) return scores.map(() => 1 / scores.length);
  return ex.map((e) => e / z);
}

function statusBite(status: string): number {
  if (status === 'slp' || status === 'frz') return 0.35;
  if (status === 'tox') return 0.3;
  if (status === 'psn') return 0.15;
  return 0;
}

function hazardsBite(h: FieldSnapshot['hazards_p1']): number {
  return (h.stealthrock ? 0.12 : 0) + h.spikes * 0.06 + h.toxicspikes * 0.08 + (h.stickyweb ? 0.08 : 0);
}

function sideKey(ourSide: PlayerSide, ours: boolean): 'p1' | 'p2' {
  if (ours) return ourSide;
  return ourSide === 'p1' ? 'p2' : 'p1';
}

/** Residual value (hazards, screens, status not already in M). Positive is good for us. */
export function secondaryDelta(
  beforeOurs: SlotSnapshot[],
  afterOurs: SlotSnapshot[],
  beforeTheirs: SlotSnapshot[],
  afterTheirs: SlotSnapshot[],
  beforeField: FieldSnapshot,
  afterField: FieldSnapshot,
  ourSide: PlayerSide,
): number {
  let s = 0;
  const nOurs = Math.min(beforeOurs.length, afterOurs.length);
  for (let i = 0; i < nOurs; i++) {
    s -= statusBite(afterOurs[i]!.status) - statusBite(beforeOurs[i]!.status);
  }
  const nTheirs = Math.min(beforeTheirs.length, afterTheirs.length);
  for (let i = 0; i < nTheirs; i++) {
    s += statusBite(afterTheirs[i]!.status) - statusBite(beforeTheirs[i]!.status);
  }
  const ourH = sideKey(ourSide, true);
  const theirH = sideKey(ourSide, false);
  const hz = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.hazards_p1 : f.hazards_p2);
  s -= hazardsBite(hz(afterField, ourH)) - hazardsBite(hz(beforeField, ourH));
  s += hazardsBite(hz(afterField, theirH)) - hazardsBite(hz(beforeField, theirH));
  const ref = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.reflect_p1 : f.reflect_p2);
  const ls = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.lightscreen_p1 : f.lightscreen_p2);
  s += 0.08 * Math.sign((ref(afterField, ourH) || 0) - (ref(beforeField, ourH) || 0));
  s -= 0.08 * Math.sign((ref(afterField, theirH) || 0) - (ref(beforeField, theirH) || 0));
  s += 0.08 * Math.sign((ls(afterField, ourH) || 0) - (ls(beforeField, ourH) || 0));
  s -= 0.08 * Math.sign((ls(afterField, theirH) || 0) - (ls(beforeField, theirH) || 0));
  return s;
}

export function roundScore(postScores: number[]): number {
  if (!postScores.length) return 0;
  return postScores.reduce((a, b) => a + b, 0) / postScores.length;
}

export interface ForcedReply {
  pWin: number;
  pLoss: number;
}

export function mateFromForced(choices: ForcedReply[][]): { forcedOutcome: ForcedOutcome; mateProbability: number } {
  if (!choices.length) return { forcedOutcome: 'none', mateProbability: 0 };
  let winP = 0;
  for (const replies of choices) {
    if (!replies.length) continue;
    const minWin = Math.min(...replies.map((r) => r.pWin));
    if (minWin > winP) winP = minWin;
  }
  let lossP = 0;
  const replyCount = Math.max(...choices.map((c) => c.length), 0);
  for (let r = 0; r < replyCount; r++) {
    let minLoss = 1;
    for (const choice of choices) {
      const row = choice[r];
      if (!row) continue;
      if (row.pLoss < minLoss) minLoss = row.pLoss;
    }
    if (minLoss > lossP) lossP = minLoss;
  }
  if (winP > 0 && winP >= lossP) return { forcedOutcome: 'win', mateProbability: winP };
  if (lossP > 0) return { forcedOutcome: 'loss', mateProbability: lossP };
  return { forcedOutcome: 'none', mateProbability: 0 };
}

export function stageMultiplier(stages: number): number {
  if (stages >= 0) return (2 + stages) / 2;
  return 2 / (2 - stages);
}

export function modifiersFromSlot(slot: SlotSnapshot, fieldWeather = ''): Modifier[] {
  const mods: Modifier[] = [];
  for (const [stat, stages] of Object.entries(slot.boosts)) {
    if (stat === 'accuracy' || stat === 'evasion') continue;
    if (!stages) continue;
    mods.push({ name: `boost:${stat}`, multiplier: stageMultiplier(stages), remainingTurns: 6 });
  }
  if (slot.status === 'brn') mods.push({ name: 'burn', multiplier: 0.5, remainingTurns: 3 });
  if (slot.status === 'par') mods.push({ name: 'para', multiplier: 0.5, remainingTurns: 3 });
  if (fieldWeather === 'sunny' || fieldWeather === 'sun') {
    mods.push({ name: 'sun', multiplier: 1.5, remainingTurns: 3 });
  }
  if (fieldWeather === 'rain') mods.push({ name: 'rain', multiplier: 1.5, remainingTurns: 3 });
  return mods;
}
