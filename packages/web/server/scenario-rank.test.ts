import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_WEIGHTS, emptyFeatures, scoredChoice, type ChoiceFeatures, type ScoreWeights } from '../../engine/src/math.js';
import { loadWeights, resetWeights, saveWeights } from '../../engine/src/weights.js';
import { applyScenarioRank, permutationError } from './scenario-handlers.js';
import type { BattleObservation, ChoiceEvaluation, RoundEvaluation } from '../../engine/src/observation.js';

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
  const p = path.join(os.tmpdir(), `rank-w-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

const z = emptyFeatures();
const setupF: ChoiceFeatures = { ...z, modifier: 0.3 };
const damageF: ChoiceFeatures = { ...z, health: 0.7 };

const obs = {
  turn: 1,
  format: 'gen9randombattle',
  ourSide: 'p1',
  ours: [],
  theirs: [],
  field: { weather: '', terrain: '', trickroom: false, hazards_p1: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false }, hazards_p2: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false }, reflect_p1: 0, reflect_p2: 0, lightscreen_p1: 0, lightscreen_p2: 0 },
  legalActions: [],
  teraUsedOurs: false,
  teraUsedTheirs: false,
} as BattleObservation;

function choice(id: string, features: ChoiceFeatures, weights: ScoreWeights): ChoiceEvaluation {
  const score = scoredChoice(1, features, weights);
  return {
    action: { id, type: 'move', moveId: id.replace(/^move:/, '') },
    success: 1,
    cta: 1,
    expectedImpact: features.health + features.modifier,
    expectedHealthDelta: features.health,
    expectedModifierDelta: features.modifier,
    ourHealth: 0, theirHealth: 0, ourModifier: 0, theirModifier: 0,
    hitsToKill: null,
    choiceScore: score,
    scaledChoiceScore: score,
    meanPostScore: 0, minTurnScore: -1, maxTurnScore: 1, minPostScore: 0, maxPostScore: 0,
    sampleCount: 1,
    features,
  };
}

function fakeEval(_obs: BattleObservation, opts?: { weights?: ScoreWeights }): Promise<RoundEvaluation> {
  const w = opts?.weights ?? DEFAULT_WEIGHTS;
  return Promise.resolve({
    choices: [choice('move:swordsdance', setupF, w), choice('move:earthquake', damageF, w)],
    replies: [choice('move:splash', z, w)],
    roundScore: 0,
    expectedRoundScore: 0,
    minRoundScore: 0,
    maxRoundScore: 0,
    forcedOutcome: 'none',
    mateProbability: 0,
  });
}

describe('permutationError', () => {
  it('rejects unknown, duplicate, omitted, and length-mismatched ids', () => {
    const ids = ['move:a', 'move:b'];
    expect(permutationError(['move:a'], ids)).toMatch(/complete permutation/);
    expect(permutationError(['move:a', 'move:c'], ids)).toMatch(/unknown/);
    expect(permutationError(['move:a', 'move:a'], ids)).toMatch(/duplicate/);
    expect(permutationError(['move:b', 'move:a'], ids)).toBeNull();
  });
});

describe('applyScenarioRank', () => {
  it('returns 400 without writing weights for a malformed order', async () => {
    const file = tmp();
    saveWeights(DEFAULT_WEIGHTS, file);
    const out = await applyScenarioRank({
      observation: obs,
      side: 'ours',
      order: ['move:swordsdance'],
      weightsPath: file,
      evaluate: fakeEval,
    });
    expect(out.status).toBe(400);
    expect(loadWeights(file)).toEqual(DEFAULT_WEIGHTS);
  });

  it('a preferred setup over damage changes persisted weights and the reevaluated gap', async () => {
    const file = tmp();
    saveWeights(DEFAULT_WEIGHTS, file);
    const before = await fakeEval(obs, { weights: DEFAULT_WEIGHTS });
    const setupBefore = before.choices.find((c) => c.action.id === 'move:swordsdance')!.choiceScore;
    const dmgBefore = before.choices.find((c) => c.action.id === 'move:earthquake')!.choiceScore;
    const gapBefore = dmgBefore - setupBefore;

    const out = await applyScenarioRank({
      observation: obs,
      side: 'ours',
      order: ['move:swordsdance', 'move:earthquake'],
      weightsPath: file,
      evaluate: fakeEval,
    });
    expect(out.status).toBe(200);
    const next = (out.body.weights as ScoreWeights);
    expect(next.modifier).toBeGreaterThan(DEFAULT_WEIGHTS.modifier);
    expect(loadWeights(file).modifier).toBe(next.modifier);

    const after = out.body.eval as RoundEvaluation;
    const setupAfter = after.choices.find((c) => c.action.id === 'move:swordsdance')!.choiceScore;
    const dmgAfter = after.choices.find((c) => c.action.id === 'move:earthquake')!.choiceScore;
    expect(dmgAfter - setupAfter).toBeLessThan(gapBefore);

    const reloaded = loadWeights(file);
    expect(reloaded).toEqual(next);
    expect(resetWeights(file)).toEqual(DEFAULT_WEIGHTS);
    const restored = await fakeEval(obs, { weights: loadWeights(file) });
    expect(restored.choices.find((c) => c.action.id === 'move:earthquake')!.choiceScore).toBeCloseTo(dmgBefore);
  });
});
