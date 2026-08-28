import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  clamp,
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  scoredChoice,
  type ChoiceFeatures,
  type ScoreWeights,
  type WeightKey,
} from './math.js';
import { atomicWriteFile } from './set-overrides.js';

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
  atomicWriteFile(filePath, JSON.stringify(sanitizeWeights(w), null, 2) + '\n');
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
  success?: number;
}

export interface ElasticDiagnostics {
  lossBefore: number;
  lossAfter: number;
  changedKeys: WeightKey[];
  boundHit: boolean;
  shrinkageDominated: boolean;
}

function modelScore(weights: ScoreWeights, row: RankedChoice): number {
  return scoredChoice(row.success ?? 1, row.features, weights);
}

function inversionLoss(weights: ScoreWeights, ranked: RankedChoice[]): number {
  let loss = 0;
  for (let i = 0; i < ranked.length - 1; i++) {
    const better = ranked[i]!;
    const worse = ranked[i + 1]!;
    const gap = modelScore(weights, worse) - modelScore(weights, better);
    if (gap > 0) loss += gap;
  }
  return loss;
}

export function elasticUpdate(
  weights: ScoreWeights,
  ranked: RankedChoice[],
  opts?: { lr?: number; lambda?: number },
): { weights: ScoreWeights; diagnostics: ElasticDiagnostics } {
  const lr = opts?.lr ?? ELASTIC_LR;
  const lambda = opts?.lambda ?? ELASTIC_LAMBDA;
  if (!Number.isFinite(lr) || !Number.isFinite(lambda)) {
    throw new Error('lr and lambda must be finite');
  }
  const start: ScoreWeights = { ...weights };
  const lossBefore = inversionLoss(start, ranked);
  const w: ScoreWeights = { ...start };
  for (let i = 0; i < ranked.length - 1; i++) {
    const better = ranked[i]!;
    const worse = ranked[i + 1]!;
    const betterS = modelScore(w, better);
    const worseS = modelScore(w, worse);
    if (!(worseS > betterS)) continue;
    const err = worseS - betterS;
    for (const k of ['health', 'modifier', 'secondary', 'sacrifice'] as const) {
      w[k] -= lr * err * (worse.features[k] - better.features[k]);
    }
    w.switchRisk += lr * err * (worse.features.switchRisk - better.features.switchRisk);
  }
  const afterGrad: ScoreWeights = { ...w };
  for (const k of WEIGHT_KEYS) {
    w[k] = (1 - lambda) * w[k] + lambda * DEFAULT_WEIGHTS[k];
    w[k] = clamp(w[k], WEIGHT_LO, WEIGHT_HI);
  }
  const lossAfter = inversionLoss(w, ranked);
  const changedKeys = WEIGHT_KEYS.filter((k) => Math.abs(w[k] - start[k]) > 1e-12);
  const boundHit = WEIGHT_KEYS.some((k) => w[k] <= WEIGHT_LO + 1e-12 || w[k] >= WEIGHT_HI - 1e-12);
  const preShrinkLoss = inversionLoss(afterGrad, ranked);
  const shrinkageDominated = lossBefore > 0 && lossAfter >= lossBefore - 1e-12 && preShrinkLoss < lossBefore - 1e-12;
  return {
    weights: w,
    diagnostics: { lossBefore, lossAfter, changedKeys, boundHit, shrinkageDominated },
  };
}
