import { describe, it, expect } from 'vitest';
import { type MonValue } from '../src/observation.js';
import {
  cta, cts, impact, impactParts, hitsToKill, pokemonValue, stateScore, choiceScore, roundScore, mateFromForced, signedLog1p, clamp,
} from '../src/math.js';

function mon(side: 'ours' | 'theirs', h: number, L = 1, M = 0, revealed = true): MonValue {
  return { side, revealed, h, L, M };
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
});

describe('CTA / CTS', () => {
  it('clamps CTA to [0,1] and zeros faint-before-action', () => {
    expect(cta(1, 1, 0)).toBe(0);
    expect(cta(1, 0.8, 1)).toBeCloseTo(0.8);
    expect(cta(2, 2, 2)).toBe(1);
  });

  it('forced switch CTS is 1', () => {
    expect(cts(0, 0, true)).toBe(1);
  });

  it('CTS uses epsilon when stay score is 0', () => {
    const v = cts(1, 0, false);
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThanOrEqual(1);
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

  it('roundScore is the uniform mean', () => {
    expect(roundScore([1, 3, 5])).toBe(3);
    expect(roundScore([])).toBe(0);
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
