import type { FieldSnapshot, ForcedOutcome, Modifier, MonValue, PlayerSide, SlotSnapshot } from './observation.js';

export const EPS = 1e-9;

/**
 * Score contract (our perspective: positive favors us).
 * CTA/CTS are branch-mass probabilities, not editable coefficients.
 * moveScore = CTA × E[weighted actor-local features | success], clamped to [-1, +1].
 * switchScore = CTS × E[weighted actor-local features | completed switch].
 * logModifier = Σ ln(multiplier) × probability × expectedTurns (no average).
 * actor features are (Δactor − Δfoe) / 6 for health and slot modifiers.
 * signedLog1p is Hamiltonian/display only. hitsToKill is a UI diagnostic.
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

export const TEAM_SIZE = 6;

/** Σ ln(multiplier) × probability × expectedTurns. Independent effects add; a 1× term does not dilute. */
export function logModifier(mods: Modifier[]): number {
  let s = 0;
  for (const m of mods) {
    const mult = m.multiplier;
    if (!(mult > 0) || !Number.isFinite(mult)) continue;
    const turns = Number.isFinite(m.remainingTurns) ? m.remainingTurns : 0;
    const p = m.probability == null ? 1 : m.probability;
    if (!Number.isFinite(p)) continue;
    s += Math.log(Math.max(mult, EPS)) * clamp(p, 0, 1) * turns;
  }
  return s;
}

/** @deprecated name; composition is a summed log, not a mean. */
export function meanModifier(mods: Modifier[]): number {
  return logModifier(mods);
}

export function slotToMonValue(slot: SlotSnapshot, side: 'ours' | 'theirs'): MonValue {
  const maxHp = slot.maxHp > 0 ? slot.maxHp : 1;
  return {
    side,
    revealed: slot.revealed,
    h: slot.fainted ? 0 : clamp(slot.hp / maxHp, 0, 1),
    L: slot.fainted || slot.hp <= 0 ? 0 : 1,
    M: logModifier(slot.modifiers),
  };
}

export function pokemonValue(mon: MonValue): number {
  if (mon.L <= 0) return 0;
  return mon.L * (clamp(mon.h, 0, 1) + 0.5 * Math.tanh(mon.M));
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

/** Branch-mass CTS. A forced legal switch is 1; otherwise 1 iff the switch completed. */
export function cts(completed: boolean, forced: boolean): number {
  if (forced) return 1;
  return completed ? 1 : 0;
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

/** Per-slot HP-fraction and modifier deltas for diagnostics. Not the elasticUpdate feature vector. */
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
  return 0.5 * Math.tanh(logModifier(mods));
}

export function sideHealth(mons: MonValue[], side: 'ours' | 'theirs'): number {
  let s = 0;
  for (const m of mons) {
    if (m.side !== side) continue;
    if (m.L <= 0) continue;
    s += clamp(m.h, 0, 1);
  }
  return s;
}

export function sideModifier(mons: MonValue[], side: 'ours' | 'theirs'): number {
  let s = 0;
  for (const m of mons) {
    if (m.side !== side) continue;
    if (m.L <= 0) continue;
    s += 0.5 * Math.tanh(m.M);
  }
  return s;
}

/** Actor-positive health feature: ((Δactor − Δfoe) / 6) ∈ [-1, +1]. */
export function actorHealthFeature(before: MonValue[], after: MonValue[], actorSide: 'ours' | 'theirs'): number {
  const foe: 'ours' | 'theirs' = actorSide === 'ours' ? 'theirs' : 'ours';
  const dActor = sideHealth(after, actorSide) - sideHealth(before, actorSide);
  const dFoe = sideHealth(after, foe) - sideHealth(before, foe);
  return clamp((dActor - dFoe) / TEAM_SIZE, -1, 1);
}

/** Actor-positive modifier feature: ((Δactor − Δfoe) / 6) ∈ [-1, +1]. */
export function actorModifierFeature(before: MonValue[], after: MonValue[], actorSide: 'ours' | 'theirs'): number {
  const foe: 'ours' | 'theirs' = actorSide === 'ours' ? 'theirs' : 'ours';
  const dActor = sideModifier(after, actorSide) - sideModifier(before, actorSide);
  const dFoe = sideModifier(after, foe) - sideModifier(before, foe);
  return clamp((dActor - dFoe) / TEAM_SIZE, -1, 1);
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

export function boundFeature(x: number, lo = -1, hi = 1): number {
  return clamp(Number.isFinite(x) ? x : 0, lo, hi);
}

export function boundFeatures(f: ChoiceFeatures): ChoiceFeatures {
  return {
    health: boundFeature(f.health),
    modifier: boundFeature(f.modifier),
    secondary: boundFeature(f.secondary),
    switchRisk: boundFeature(f.switchRisk, 0, 1),
    sacrifice: boundFeature(f.sacrifice, 0, 1),
  };
}

export function choiceFeatures(parts: ImpactParts, extras: { secondary: number; switchRisk: number; sacrifice: number }): ChoiceFeatures {
  return boundFeatures({
    health: parts.health,
    modifier: parts.modifier,
    secondary: extras.secondary,
    switchRisk: extras.switchRisk,
    sacrifice: extras.sacrifice,
  });
}

export function weightedRaw(features: ChoiceFeatures, weights: ScoreWeights): number {
  const f = boundFeatures(features);
  return weights.health * f.health
    + weights.modifier * f.modifier
    + weights.secondary * f.secondary
    + weights.sacrifice * f.sacrifice
    - weights.switchRisk * f.switchRisk;
}

export function scoredChoice(success: number, features: ChoiceFeatures, weights: ScoreWeights): number {
  const p = clamp(Number.isFinite(success) ? success : 0, 0, 1);
  return clamp(p * clamp(weightedRaw(features, weights), -1, 1), -1, 1);
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

/** Residual field value (hazards, screens). Status lives in modifierFeature. Positive is good for us. */
export function secondaryDelta(
  beforeOurs: SlotSnapshot[],
  afterOurs: SlotSnapshot[],
  beforeTheirs: SlotSnapshot[],
  afterTheirs: SlotSnapshot[],
  beforeField: FieldSnapshot,
  afterField: FieldSnapshot,
  ourSide: PlayerSide,
): number {
  return actorSecondaryFeature(beforeOurs, afterOurs, beforeTheirs, afterTheirs, beforeField, afterField, ourSide, true);
}

/** Actor-positive field feature (hazards, screens, weather, terrain). Status is not included. */
export function actorSecondaryFeature(
  beforeOurs: SlotSnapshot[],
  afterOurs: SlotSnapshot[],
  beforeTheirs: SlotSnapshot[],
  afterTheirs: SlotSnapshot[],
  beforeField: FieldSnapshot,
  afterField: FieldSnapshot,
  ourSide: PlayerSide,
  actorOurs: boolean,
): number {
  const selfIsP1 = actorOurs ? ourSide === 'p1' : ourSide !== 'p1';
  const selfKey: 'p1' | 'p2' = selfIsP1 ? 'p1' : 'p2';
  const foeKey: 'p1' | 'p2' = selfIsP1 ? 'p2' : 'p1';
  const hz = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.hazards_p1 : f.hazards_p2);
  const ref = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.reflect_p1 : f.reflect_p2);
  const ls = (f: FieldSnapshot, k: 'p1' | 'p2') => (k === 'p1' ? f.lightscreen_p1 : f.lightscreen_p2);
  let s = 0;
  s -= hazardsBite(hz(afterField, selfKey)) - hazardsBite(hz(beforeField, selfKey));
  s += hazardsBite(hz(afterField, foeKey)) - hazardsBite(hz(beforeField, foeKey));
  s += 0.08 * Math.sign((ref(afterField, selfKey) || 0) - (ref(beforeField, selfKey) || 0));
  s -= 0.08 * Math.sign((ref(afterField, foeKey) || 0) - (ref(beforeField, foeKey) || 0));
  s += 0.08 * Math.sign((ls(afterField, selfKey) || 0) - (ls(beforeField, selfKey) || 0));
  s -= 0.08 * Math.sign((ls(afterField, foeKey) || 0) - (ls(beforeField, foeKey) || 0));
  const weatherOn = (f: FieldSnapshot) => (f.weather ? 1 : 0);
  const terrainOn = (f: FieldSnapshot) => (f.terrain ? 1 : 0);
  s += 0.05 * (weatherOn(afterField) - weatherOn(beforeField));
  s += 0.05 * (terrainOn(afterField) - terrainOn(beforeField));
  void beforeOurs;
  void afterOurs;
  void beforeTheirs;
  void afterTheirs;
  return clamp(finiteOrZero(s), -1, 1);
}

export function roundScore(postScores: number[]): number {
  if (!postScores.length) return 0;
  return postScores.reduce((a, b) => a + b, 0) / postScores.length;
}

/** Policy-weighted mean. Missing/zero weights are skipped; empty → 0. */
export function weightedMean(values: number[], weights: number[]): number {
  let s = 0;
  let w = 0;
  const n = Math.min(values.length, weights.length);
  for (let i = 0; i < n; i++) {
    const p = weights[i] ?? 0;
    const v = values[i] ?? 0;
    if (!(p > 0) || !Number.isFinite(v)) continue;
    s += p * v;
    w += p;
  }
  return w > 0 ? s / w : 0;
}

export function scoreExtrema(values: number[]): { min: number; max: number } {
  const xs = values.filter((v) => Number.isFinite(v));
  if (!xs.length) return { min: 0, max: 0 };
  return { min: Math.min(...xs), max: Math.max(...xs) };
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

export function modifiersFromSlot(slot: SlotSnapshot, _fieldWeather = ''): Modifier[] {
  const mods: Modifier[] = [];
  for (const [stat, stages] of Object.entries(slot.boosts)) {
    if (stat === 'accuracy' || stat === 'evasion') continue;
    if (!stages) continue;
    mods.push({ name: `boost:${stat}`, multiplier: stageMultiplier(stages), remainingTurns: MODIFIER_TURNS.boost });
  }
  if (slot.status === 'brn') mods.push({ name: 'burn', multiplier: 0.5, remainingTurns: MODIFIER_TURNS.burn });
  if (slot.status === 'par') mods.push({ name: 'para', multiplier: 0.5, remainingTurns: MODIFIER_TURNS.para });
  return mods;
}

/**
 * Wilson score interval for a binomial proportion at 95% confidence (z = 1.95996).
 * Returns { low, high } bounded in [0, 1].
 */
export function wilsonScoreInterval(successes: number, total: number, z = 1.95996): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const p = clamp(successes / total, 0, 1);
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return {
    low: clamp(center - margin, 0, 1),
    high: clamp(center + margin, 0, 1),
  };
}

/** Simple linear congruential generator / mulberry32 for deterministic pseudo-random sequences. */
export function createSeededRng(seed: number): () => number {
  let s = Math.floor(seed) >>> 0;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
