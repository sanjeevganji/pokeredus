import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  clamp,
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  type ChoiceFeatures,
  type ScoreWeights,
} from './math.js';

export const ELASTIC_LR = 0.25;
export const ELASTIC_LAMBDA = 0.15;
export const WEIGHT_LO = 0.15;
export const WEIGHT_HI = 4;

export function defaultWeightsPath(): string {
  return process.env.POKEREDUS_WEIGHTS || path.resolve('score-weights.json');
}

export function sanitizeWeights(raw: unknown): ScoreWeights {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out: ScoreWeights = { ...DEFAULT_WEIGHTS };
  for (const k of WEIGHT_KEYS) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(v, WEIGHT_LO, WEIGHT_HI);
  }
  return out;
}

export function loadWeights(filePath = defaultWeightsPath()): ScoreWeights {
  try {
    return sanitizeWeights(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function saveWeights(w: ScoreWeights, filePath = defaultWeightsPath()): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sanitizeWeights(w), null, 2) + '\n', 'utf8');
}

export function resetWeights(filePath = defaultWeightsPath()): ScoreWeights {
  const w = { ...DEFAULT_WEIGHTS };
  saveWeights(w, filePath);
  return w;
}

export interface RankedChoice {
  id: string;
  score: number;
  features: ChoiceFeatures;
}

export function elasticUpdate(
  weights: ScoreWeights,
  ranked: RankedChoice[],
  opts?: { lr?: number; lambda?: number },
): ScoreWeights {
  const lr = opts?.lr ?? ELASTIC_LR;
  const lambda = opts?.lambda ?? ELASTIC_LAMBDA;
  const w: ScoreWeights = { ...weights };
  for (let i = 0; i < ranked.length - 1; i++) {
    const better = ranked[i]!;
    const worse = ranked[i + 1]!;
    if (!(worse.score > better.score)) continue;
    const err = worse.score - better.score;
    for (const k of ['health', 'modifier', 'secondary', 'sacrifice'] as const) {
      w[k] -= lr * err * (worse.features[k] - better.features[k]);
    }
    w.switchRisk += lr * err * (worse.features.switchRisk - better.features.switchRisk);
  }
  for (const k of WEIGHT_KEYS) {
    w[k] = (1 - lambda) * w[k] + lambda * DEFAULT_WEIGHTS[k];
    w[k] = clamp(w[k], WEIGHT_LO, WEIGHT_HI);
  }
  return w;
}
