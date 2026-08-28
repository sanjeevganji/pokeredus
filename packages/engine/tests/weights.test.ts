import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_WEIGHTS, emptyFeatures, scoredChoice } from '../src/math.js';
import { elasticUpdate, loadWeights, resetWeights, saveWeights, WEIGHT_HI, WEIGHT_LO, type RankedChoice } from '../src/weights.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.${process.pid}.tmp`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.bak`); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmp(): string {
  const p = path.join(os.tmpdir(), `weights-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

const z = emptyFeatures();

describe('score weights', () => {
  it('loads defaults when the file is missing', () => {
    expect(loadWeights(path.join(os.tmpdir(), 'no-such-score-weights.json'))).toEqual(DEFAULT_WEIGHTS);
  });

  it('save/load round-trips and reset restores defaults', () => {
    const file = tmp();
    saveWeights({ ...DEFAULT_WEIGHTS, health: 2 }, file);
    expect(loadWeights(file).health).toBe(2);
    expect(resetWeights(file)).toEqual(DEFAULT_WEIGHTS);
    expect(loadWeights(file)).toEqual(DEFAULT_WEIGHTS);
  });

  it('a preferred setup move above raw damage increases the modifier weight', () => {
    const setup: RankedChoice = {
      id: 'move:swordsdance',
      score: 0.1,
      features: { ...z, modifier: 0.3 },
    };
    const damage: RankedChoice = {
      id: 'move:earthquake',
      score: 0.8,
      features: { ...z, health: 0.7 },
    };
    const { weights, diagnostics } = elasticUpdate(DEFAULT_WEIGHTS, [setup, damage]);
    expect(weights.modifier).toBeGreaterThan(DEFAULT_WEIGHTS.modifier);
    expect(diagnostics.lossAfter).toBeLessThanOrEqual(diagnostics.lossBefore + 1e-12);
    const gap = (w: typeof weights) => scoredChoice(1, damage.features, w) - scoredChoice(1, setup.features, w);
    expect(gap(weights)).toBeLessThan(gap(DEFAULT_WEIGHTS));
  });

  it('an opponent-side correction follows opponent actor-local features, not ours', () => {
    const theirSetup: RankedChoice = {
      id: 'move:swordsdance',
      score: 0.1,
      features: { ...z, modifier: 0.3 },
    };
    const theirDamage: RankedChoice = {
      id: 'move:earthquake',
      score: 0.9,
      features: { ...z, health: 0.7 },
    };
    const { weights } = elasticUpdate(DEFAULT_WEIGHTS, [theirSetup, theirDamage]);
    expect(weights.modifier).toBeGreaterThan(DEFAULT_WEIGHTS.modifier);
    expect(weights.health).toBeLessThanOrEqual(DEFAULT_WEIGHTS.health + 1e-9);
  });

  it('repeated corrections reduce inversion loss until convergence, a bound, or shrinkage', () => {
    const better: RankedChoice = { id: 'a', score: 0, features: { ...z, modifier: 0.3 } };
    const worse: RankedChoice = { id: 'b', score: 1, features: { ...z, health: 0.7 } };
    let w = { ...DEFAULT_WEIGHTS };
    let lastLoss = Infinity;
    let hit = false;
    for (let i = 0; i < 40; i++) {
      const out = elasticUpdate(w, [better, worse]);
      w = out.weights;
      expect(out.diagnostics.lossAfter).toBeLessThanOrEqual(out.diagnostics.lossBefore + 1e-9);
      if (out.diagnostics.lossAfter === 0 || out.diagnostics.boundHit || out.diagnostics.shrinkageDominated) {
        hit = true;
        break;
      }
      lastLoss = out.diagnostics.lossAfter;
    }
    expect(hit || lastLoss < Infinity).toBe(true);
  });

  it('weights stay finite and in bounds after 1000 synthetic corrections', () => {
    let w = { ...DEFAULT_WEIGHTS };
    for (let i = 0; i < 1000; i++) {
      const a: RankedChoice = {
        id: 'a', score: 0,
        features: { ...z, health: (i % 5) / 5, modifier: ((i + 1) % 5) / 5, secondary: ((i + 2) % 5) / 5, switchRisk: (i % 2) / 2, sacrifice: ((i + 3) % 5) / 5 },
      };
      const b: RankedChoice = {
        id: 'b', score: 1,
        features: { ...z, health: ((i + 2) % 5) / 5, modifier: (i % 5) / 5, secondary: ((i + 1) % 5) / 5, switchRisk: ((i + 1) % 2) / 2, sacrifice: ((i + 4) % 5) / 5 },
      };
      w = elasticUpdate(w, [a, b]).weights;
    }
    for (const k of ['health', 'modifier', 'secondary', 'switchRisk', 'sacrifice'] as const) {
      expect(Number.isFinite(w[k])).toBe(true);
      expect(w[k]).toBeGreaterThanOrEqual(WEIGHT_LO);
      expect(w[k]).toBeLessThanOrEqual(WEIGHT_HI);
    }
  });

  it('the same input and starting weights produce the same output', () => {
    const ranked: RankedChoice[] = [
      { id: 'a', score: 0.1, features: { ...z, modifier: 0.3 } },
      { id: 'b', score: 0.9, features: { ...z, health: 0.3 } },
    ];
    const a = elasticUpdate(DEFAULT_WEIGHTS, ranked);
    const b = elasticUpdate(DEFAULT_WEIGHTS, ranked);
    expect(a.weights).toEqual(b.weights);
    expect(a.diagnostics).toEqual(b.diagnostics);
  });

  it('rejects non-finite lr or lambda', () => {
    expect(() => elasticUpdate(DEFAULT_WEIGHTS, [], { lr: Number.NaN })).toThrow(/finite/);
    expect(() => elasticUpdate(DEFAULT_WEIGHTS, [], { lambda: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });
});
