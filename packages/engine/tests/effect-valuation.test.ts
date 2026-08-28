import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  loadEffectValuations,
  parseValuation,
  parseEffectsFile,
  valuationOrNeutral,
  onceProbability,
  emptyValuationRegistry,
  type EffectValuationRegistry,
} from '../src/effect-valuation.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
  tmpDirs.push(d);
  return d;
}

function writeTrio(dir: string, moves: unknown, abilities: unknown, items: unknown): void {
  fs.writeFileSync(path.join(dir, 'moves.json'), JSON.stringify(moves));
  fs.writeFileSync(path.join(dir, 'abilities.json'), JSON.stringify(abilities));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items));
}

describe('parseValuation', () => {
  it('rejects multiplier <= 0, probability outside [0,1], non-finite values, and bad turns', () => {
    expect(() => parseValuation({ multiplier: 0, expectedTurns: 3 }, 'moves.x.valuation')).toThrow(/moves\.x\.valuation\.multiplier/);
    expect(() => parseValuation({ multiplier: -1, expectedTurns: 3 }, 'moves.x.valuation')).toThrow(/multiplier/);
    expect(() => parseValuation({ multiplier: 1.5, expectedTurns: -1 }, 'moves.x.valuation')).toThrow(/expectedTurns/);
    expect(() => parseValuation({ multiplier: 1.5, expectedTurns: 33 }, 'moves.x.valuation')).toThrow(/expectedTurns/);
    expect(() => parseValuation({ multiplier: 1.5, expectedTurns: Number.NaN }, 'moves.x.valuation')).toThrow(/expectedTurns/);
    expect(() => parseValuation({ multiplier: '1.5', expectedTurns: 3 }, 'moves.scald.valuation')).toThrow(/moves\.scald\.valuation\.multiplier/);
    expect(() => parseValuation({ multiplier: 0.5, expectedTurns: 3, probabilityOverride: 1.2 }, 'm.v')).toThrow(/probabilityOverride/);
    expect(() => parseValuation({ multiplier: 0.5, expectedTurns: 3, probabilityOverride: Number.NaN }, 'm.v')).toThrow(/probabilityOverride/);
  });

  it('accepts explicit zero and one probability', () => {
    expect(parseValuation({ multiplier: 0.5, expectedTurns: 3, probabilityOverride: 0 }, 'v').probabilityOverride).toBe(0);
    expect(parseValuation({ multiplier: 0.5, expectedTurns: 3, probabilityOverride: 1 }, 'v').probabilityOverride).toBe(1);
  });

  it('treats absent probabilityOverride as Showdown/default (undefined)', () => {
    expect(parseValuation({ multiplier: 2, expectedTurns: 6 }, 'v').probabilityOverride).toBeUndefined();
  });
});

describe('parseEffectsFile', () => {
  it('does not mistake a mechanics field for a valuation field', () => {
    const parsed = parseEffectsFile({
      moves: {
        lifeorbish: {
          attribute_type: 'damage_mod',
          params: { multiplier: 1.3 },
        },
      },
    }, 'moves');
    expect(parsed.get('lifeorbish')).toEqual([]);
  });

  it('reads valuation on the entry and on each effect object', () => {
    const parsed = parseEffectsFile({
      moves: {
        swordsdance: { valuation: { multiplier: 2, expectedTurns: 6 } },
        scald: {
          effects: [{ valuation: { multiplier: 0.5, expectedTurns: 3, probabilityOverride: 0.3 } }],
        },
      },
    }, 'moves');
    expect(parsed.get('swordsdance')?.[0]?.multiplier).toBe(2);
    expect(parsed.get('scald')?.[0]?.probabilityOverride).toBe(0.3);
  });
});

describe('loadEffectValuations', () => {
  it('loads representative repo files', () => {
    const reg = loadEffectValuations();
    expect(reg.moves.get('swordsdance')?.[0]?.multiplier).toBe(2);
    expect(reg.moves.get('scald')?.[0]?.probabilityOverride).toBe(0.3);
    expect(reg.moves.get('stealthrock')?.length).toBeGreaterThan(0);
    expect(reg.abilities.get('intimidate')?.[0]?.expectedTurns).toBe(6);
    expect(reg.items.get('leftovers')?.[0]?.multiplier).toBeCloseTo(1.0625);
  });

  it('rejects malformed explicit valuation with a path', () => {
    const dir = tmpDir();
    writeTrio(dir, { moves: { scald: { valuation: { multiplier: 0.5, expectedTurns: '3' } } } }, { abilities: {} }, { items: {} });
    expect(() => loadEffectValuations(dir)).toThrow(/moves\.scald\.valuation\.expectedTurns/);
  });
});

describe('coverage', () => {
  it('an absent entry returns neutral value plus a coverage diagnostic', () => {
    const reg: EffectValuationRegistry = emptyValuationRegistry();
    const hit = valuationOrNeutral(reg, 'moves', 'earthquake');
    expect(hit.valuations).toEqual([]);
    expect(hit.coverage).toBe('moves.earthquake');
    reg.moves.set('swordsdance', [{ multiplier: 2, expectedTurns: 6 }]);
    const known = valuationOrNeutral(reg, 'moves', 'Swords Dance');
    expect(known.valuations[0]?.multiplier).toBe(2);
    expect(known.coverage).toBeUndefined();
  });
});

describe('onceProbability', () => {
  it('does not square a 30% chance', () => {
    expect(onceProbability(true, 0.3)).toBe(1);
    expect(onceProbability(false, 0.3)).toBe(0.3);
    expect(onceProbability(false, undefined)).toBe(1);
  });
});
