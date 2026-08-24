import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_WEIGHTS } from '../src/math.js';
import { elasticUpdate, loadWeights, resetWeights, saveWeights, type RankedChoice } from '../src/weights.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmp(): string {
  const p = path.join(os.tmpdir(), `weights-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

describe('score weights', () => {
  it('loads defaults when the file is missing', () => {
    expect(loadWeights(path.join(os.tmpdir(), 'no-such-score-weights.json'))).toEqual(DEFAULT_WEIGHTS);
  });

  it('reset writes defaults', () => {
    const file = tmp();
    saveWeights({ ...DEFAULT_WEIGHTS, health: 2 }, file);
    expect(resetWeights(file)).toEqual(DEFAULT_WEIGHTS);
    expect(loadWeights(file)).toEqual(DEFAULT_WEIGHTS);
  });

  it('elastic update moves the responsible weight and shrinks an inverted pair', () => {
    const better: RankedChoice = {
      id: 'move:eq',
      score: 0.2,
      features: { health: 0.8, modifier: 0, secondary: 0.1, switchRisk: 0.1, sacrifice: 0.6 },
    };
    const worse: RankedChoice = {
      id: 'switch:2',
      score: 1.0,
      features: { health: 0.1, modifier: 0, secondary: 0, switchRisk: 0.5, sacrifice: 0 },
    };
    const next = elasticUpdate(DEFAULT_WEIGHTS, [better, worse]);
    expect(next.sacrifice).toBeGreaterThan(DEFAULT_WEIGHTS.sacrifice);
    const score = (w: typeof next, f: RankedChoice['features']) =>
      w.health * f.health + w.modifier * f.modifier + w.secondary * f.secondary + w.sacrifice * f.sacrifice - w.switchRisk * f.switchRisk;
    const gapBefore = worse.score - better.score;
    const gapAfter = score(next, worse.features) - score(next, better.features);
    expect(gapAfter).toBeLessThan(gapBefore);
  });
});
