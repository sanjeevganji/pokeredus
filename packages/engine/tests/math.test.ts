import { describe, it, expect } from 'vitest';
import { type MonValue } from '../src/observation.js';
import {
  cta, cts, impact, impactParts, hitsToKill, pokemonValue, stateScore, choiceScore, roundScore, mateFromForced, signedLog1p, clamp,
  expectedTtk, effectiveHeal, modifierValue, modifierDelta, switchScore, pairTurnScore,
  logModifier, actorHealthFeature, actorModifierFeature, scoredChoice, DEFAULT_WEIGHTS, emptyFeatures, TEAM_SIZE,
} from '../src/math.js';

function mon(side: 'ours' | 'theirs', h: number, L = 1, M = 0, revealed = true): MonValue {
  return { side, revealed, h, L, M };
}

function six(side: 'ours' | 'theirs', h = 1, L = 1, M = 0): MonValue[] {
  return Array.from({ length: TEAM_SIZE }, () => mon(side, h, L, M));
}

describe('stateScore', () => {
  it('is bounded to [-6, 6] for six-on-six', () => {
    const ours = Array.from({ length: 6 }, () => mon('ours', 1, 1, 10));
    const theirs = Array.from({ length: 6 }, () => mon('theirs', 0, 0, 0));
    const s = stateScore([...ours, ...theirs]);
    expect(s).toBeLessThanOrEqual(6);
    expect(s).toBeGreaterThanOrEqual(-6);
  });

  it('fainted pokemon contribute 0', () => {
    expect(pokemonValue(mon('ours', 1, 0, 5))).toBe(0);
  });

  it('a positive setup modifier retains positive value at full HP', () => {
    const full = pokemonValue(mon('ours', 1, 1, 0));
    const setup = pokemonValue(mon('ours', 1, 1, Math.log(2) * 6));
    expect(setup).toBeGreaterThan(full);
    expect(modifierValue([{ name: 'boost:atk', multiplier: 2, remainingTurns: 6 }])).toBeGreaterThan(0);
  });
});

describe('CTA / CTS', () => {
  it('clamps CTA to [0,1] and zeros faint-before-action', () => {
    expect(cta(1, 1, 0)).toBe(0);
    expect(cta(1, 0.8, 1)).toBeCloseTo(0.8);
    expect(cta(2, 2, 2)).toBe(1);
  });

  it('forced switch CTS is 1', () => {
    expect(cts(false, true)).toBe(1);
    expect(cts(true, true)).toBe(1);
  });

  it('unforced CTS is 1 iff the switch completed', () => {
    expect(cts(true, false)).toBe(1);
    expect(cts(false, false)).toBe(0);
  });
});

describe('logModifier composition', () => {
  it('two independent 1.5× modifiers for two turns compose as 1.5^(2+2)', () => {
    const mods = [
      { name: 'a', multiplier: 1.5, remainingTurns: 2 },
      { name: 'b', multiplier: 1.5, remainingTurns: 2 },
    ];
    expect(Math.exp(logModifier(mods))).toBeCloseTo(1.5 ** 4);
  });

  it('a neutral 1× modifier does not dilute another modifier', () => {
    const strong = [{ name: 'a', multiplier: 2, remainingTurns: 3 }];
    const withNeutral = [...strong, { name: 'n', multiplier: 1, remainingTurns: 5 }];
    expect(logModifier(withNeutral)).toBeCloseTo(logModifier(strong));
    expect(modifierValue(withNeutral)).toBeCloseTo(modifierValue(strong));
  });

  it('branch mass and metadata-only probability are not squared', () => {
    const realized = { name: 'burn', multiplier: 0.5, remainingTurns: 3, probability: 1 };
    const metadata = { name: 'burn', multiplier: 0.5, remainingTurns: 3, probability: 0.3 };
    expect(0.3 * logModifier([realized])).toBeCloseTo(logModifier([metadata]));
    expect(logModifier([metadata])).not.toBeCloseTo(0.3 * 0.3 * Math.log(0.5) * 3);
  });
});

describe('normalized health / modifier features', () => {
  it('six-Pokémon health delta is /6 and bounded to [-1, +1]', () => {
    const before = [...six('ours'), ...six('theirs')];
    const after = [...six('ours'), mon('theirs', 0, 0), ...six('theirs').slice(1)];
    const f = actorHealthFeature(before, after, 'ours');
    expect(f).toBeCloseTo(1 / 6);
    expect(f).toBeGreaterThanOrEqual(-1);
    expect(f).toBeLessThanOrEqual(1);
    const wipe = actorHealthFeature(before, [...six('ours'), ...six('theirs', 0, 0)], 'ours');
    expect(wipe).toBeCloseTo(1);
  });

  it('swapping ours/theirs negates the actor-local health delta', () => {
    const before = [...six('ours'), ...six('theirs')];
    const after = [...six('ours'), mon('theirs', 0, 0), ...six('theirs').slice(1)];
    const ours = actorHealthFeature(before, after, 'ours');
    const theirs = actorHealthFeature(before, after, 'theirs');
    expect(theirs).toBeCloseTo(-ours);
  });

  it('empty and no-op branches are finite zero', () => {
    const mons = [...six('ours'), ...six('theirs')];
    expect(actorHealthFeature(mons, mons, 'ours')).toBe(0);
    expect(actorModifierFeature(mons, mons, 'ours')).toBe(0);
    expect(Number.isFinite(actorHealthFeature([], [], 'ours'))).toBe(true);
    expect(pairTurnScore(Number.NaN, 1)).toBe(0);
  });
});

describe('impact and choice/round', () => {
  it('our healing is positive and opponent healing is negative', () => {
    const before = [mon('ours', 0.4), mon('theirs', 0.4)];
    const afterHealUs = [mon('ours', 0.8), mon('theirs', 0.4)];
    const afterHealThem = [mon('ours', 0.4), mon('theirs', 0.8)];
    expect(impact(before, afterHealUs)).toBeGreaterThan(0);
    expect(impact(before, afterHealThem)).toBeLessThan(0);
  });

  it('unrevealed slots are skipped', () => {
    const before = [mon('ours', 1), mon('theirs', 1, 1, 0, false)];
    const after = [mon('ours', 1), mon('theirs', 0.1, 1, 0, false)];
    expect(impact(before, after)).toBe(0);
  });

  it('choiceScore multiplies success by expected impact', () => {
    expect(choiceScore(0.5, 2)).toBe(1);
  });

  it('impactParts splits health and modifier and totals to impact', () => {
    const before = [mon('ours', 0.5, 1, 0), mon('theirs', 1, 1, 0)];
    const after = [mon('ours', 0.5, 1, 0.2), mon('theirs', 0.4, 1, 0)];
    const parts = impactParts(before, after);
    expect(parts.total).toBe(impact(before, after));
    expect(parts.health).toBeCloseTo(0.6);
    expect(parts.modifier).toBeCloseTo(0.5 * Math.tanh(0.2));
    expect(parts.health + parts.modifier).toBeCloseTo(parts.total);
    expect(parts.ourHealth).toBeCloseTo(0);
    expect(parts.theirHealth).toBeCloseTo(-0.6);
    expect(parts.ourModifier).toBeCloseTo(0.5 * Math.tanh(0.2));
    expect(parts.theirModifier).toBeCloseTo(0);
  });

  it('hitsToKill is a display diagnostic', () => {
    expect(hitsToKill(1, 0.4)).toBe(2);
    expect(hitsToKill(1, 0)).toBe(1);
    expect(hitsToKill(0.5, 0.5)).toBeNull();
    expect(hitsToKill(0.5, 0.8)).toBeNull();
    expect(expectedTtk(1, 1)).toBe(1);
    expect(expectedTtk(1, 0)).toBeNull();
  });

  it('roundScore is the uniform mean', () => {
    expect(roundScore([1, 3, 5])).toBe(3);
    expect(roundScore([])).toBe(0);
  });
});

describe('weighted scoredChoice', () => {
  const z = emptyFeatures();

  it('80% hit with conditional value 0.5 yields 0.4', () => {
    expect(scoredChoice(0.8, { ...z, health: 0.5 }, DEFAULT_WEIGHTS)).toBeCloseTo(0.4);
  });

  it('faint-before-action has CTA and score zero', () => {
    expect(cta(1, 1, 0)).toBe(0);
    expect(scoredChoice(0, { ...z, health: 1 }, DEFAULT_WEIGHTS)).toBe(0);
  });

  it('default weights preserve expected sign', () => {
    expect(scoredChoice(1, { ...z, health: 0.2 }, DEFAULT_WEIGHTS)).toBeGreaterThan(0);
    expect(scoredChoice(1, { ...z, modifier: 0.2 }, DEFAULT_WEIGHTS)).toBeGreaterThan(0);
    expect(scoredChoice(1, { ...z, secondary: 0.2 }, DEFAULT_WEIGHTS)).toBeGreaterThan(0);
    expect(scoredChoice(1, { ...z, sacrifice: 0.2 }, DEFAULT_WEIGHTS)).toBeGreaterThan(0);
    expect(scoredChoice(1, { ...z, switchRisk: 0.5 }, DEFAULT_WEIGHTS)).toBeLessThan(0);
  });

  it('changing one weight changes only rows with that feature', () => {
    const healthRow = { ...z, health: 0.3 };
    const modRow = { ...z, modifier: 0.3 };
    const boosted = { ...DEFAULT_WEIGHTS, health: 2 };
    expect(scoredChoice(1, healthRow, boosted)).not.toBe(scoredChoice(1, healthRow, DEFAULT_WEIGHTS));
    expect(scoredChoice(1, modRow, boosted)).toBe(scoredChoice(1, modRow, DEFAULT_WEIGHTS));
  });

  it('min/mean/max stay within [-1, +1]', () => {
    const huge = scoredChoice(1, { health: 4, modifier: 4, secondary: 4, switchRisk: 0, sacrifice: 4 }, DEFAULT_WEIGHTS);
    expect(huge).toBeLessThanOrEqual(1);
    expect(scoredChoice(1, { ...z, health: -4 }, DEFAULT_WEIGHTS)).toBeGreaterThanOrEqual(-1);
  });
});

describe('mate', () => {
  it('forced win is max_c min_r P(win)', () => {
    const r = mateFromForced([
      [{ pWin: 1, pLoss: 0 }, { pWin: 0.2, pLoss: 0 }],
      [{ pWin: 0.9, pLoss: 0 }, { pWin: 0.9, pLoss: 0 }],
    ]);
    expect(r.forcedOutcome).toBe('win');
    expect(r.mateProbability).toBeCloseTo(0.9);
  });

  it('forced loss is symmetric', () => {
    const r = mateFromForced([
      [{ pWin: 0, pLoss: 1 }, { pWin: 0, pLoss: 0.4 }],
      [{ pWin: 0, pLoss: 1 }, { pWin: 0, pLoss: 0.2 }],
    ]);
    expect(r.forcedOutcome).toBe('loss');
    expect(r.mateProbability).toBeGreaterThan(0);
  });
});

describe('signedLog1p', () => {
  it('preserves sign and is defined at 0', () => {
    expect(signedLog1p(0)).toBe(0);
    expect(signedLog1p(1)).toBeGreaterThan(0);
    expect(signedLog1p(-1)).toBeLessThan(0);
    expect(clamp(-10, -6, 6)).toBe(-6);
  });
});

describe('score contract helpers', () => {
  it('healing excludes overheal', () => {
    expect(effectiveHeal(80, 120, 100)).toBeCloseTo(0.2);
    expect(effectiveHeal(100, 100, 100)).toBe(0);
    expect(effectiveHeal(40, 70, 100)).toBeCloseTo(0.3);
  });

  it('modifier duration and sign', () => {
    const up = modifierValue([{ name: 'boost:atk', multiplier: 1.5, remainingTurns: 6 }]);
    const down = modifierValue([{ name: 'boost:atk', multiplier: 2 / 3, remainingTurns: 6 }]);
    const short = modifierValue([{ name: 'boost:atk', multiplier: 1.5, remainingTurns: 1 }]);
    expect(up).toBeGreaterThan(0);
    expect(down).toBeLessThan(0);
    expect(up).toBeGreaterThan(short);
    expect(modifierDelta(
      [{ name: 'boost:atk', multiplier: 1, remainingTurns: 6 }],
      [{ name: 'boost:atk', multiplier: 1.5, remainingTurns: 6 }],
    )).toBeGreaterThan(0);
  });

  it('switch formula subtracts opponent action from state delta', () => {
    expect(switchScore(1, 0, 0.3)).toBeCloseTo(0.7);
    expect(switchScore(0, 0, 0)).toBe(0);
  });
});
