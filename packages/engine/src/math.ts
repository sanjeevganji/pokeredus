import type { FieldSnapshot, ForcedOutcome, Modifier, MonValue, PlayerSide, SlotSnapshot } from './observation.js';

export const EPS = 1e-9;
export const EXPECTED_VALUE_TURNS = 3;

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

export function impactParts(
  before: MonValue[],
  after: MonValue[],
  expectedValueTurns = EXPECTED_VALUE_TURNS,
): ImpactParts {
  const n = Math.min(before.length, after.length);
  let ourHealth = 0;
  let theirHealth = 0;
  let ourModifier = 0;
  let theirModifier = 0;
  for (let i = 0; i < n; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (!b.revealed && !a.revealed) continue;
    const dh = a.h - b.h;
    const dM = (a.M - b.M) * expectedValueTurns;
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

export function impact(
  before: MonValue[],
  after: MonValue[],
  expectedValueTurns = EXPECTED_VALUE_TURNS,
): number {
  return impactParts(before, after, expectedValueTurns).total;
}

/** Hits to KO from expected HP fraction lost. Null when no damage. */
export function hitsToKill(hBefore: number, hAfter: number): number | null {
  const damage = hBefore - hAfter;
  if (!(damage > EPS) || !(hBefore > EPS)) return null;
  return Math.ceil(hBefore / damage);
}

export function choiceScore(success: number, expectedImpact: number): number {
  return success * expectedImpact;
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
