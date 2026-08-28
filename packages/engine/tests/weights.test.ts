import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_WEIGHTS, emptyBoosts, emptyField, emptyFeatures, scoredChoice } from '../src/math.js';
import { elasticUpdate, loadWeights, resetWeights, saveWeights, WEIGHT_HI, WEIGHT_LO, type RankedChoice } from '../src/weights.js';
import { evaluateJointStatePolicy, evaluateRound } from '../src/evaluate.js';
import type { BattleObservation, CanonicalSet, SlotSnapshot } from '../src/observation.js';

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

  it('persisted human corrections change pair deltas, policies, and roundScore', async () => {
    const garchomp: CanonicalSet = {
      species: 'Garchomp', level: 80, item: '', ability: 'roughskin',
      moves: ['earthquake', 'splash'], nature: 'Jolly',
    };
    const slot = (set: CanonicalSet, i: number, active: boolean, extra?: Partial<SlotSnapshot>): SlotSnapshot => ({
      slot: i,
      speciesId: set.species.toLowerCase().replace(/[^a-z0-9]/g, ''),
      revealed: true,
      hp: 250,
      maxHp: 250,
      status: '',
      boosts: emptyBoosts(),
      fainted: false,
      active,
      knownMoves: set.moves,
      set,
      hypotheses: active ? [{ set, count: 1, probability: 1 }] : [],
      modifiers: [],
      ...extra,
    });
    const team = (lead: CanonicalSet): SlotSnapshot[] => {
      const rest: CanonicalSet[] = Array.from({ length: 5 }, () => ({
        species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy',
      }));
      return [slot(lead, 0, true), ...rest.map((s, i) => slot(s, i + 1, false, { revealed: false, hypotheses: [] }))];
    };
    const obs: BattleObservation = {
      turn: 1,
      format: 'gen9randombattle',
      ourSide: 'p1',
      ours: team(garchomp),
      theirs: team(garchomp),
      field: emptyField(),
      legalActions: garchomp.moves.map((moveId) => ({ id: `move:${moveId}`, type: 'move' as const, moveId })),
      teraUsedOurs: false,
      teraUsedTheirs: false,
    };
    const file = tmp();
    const before = await evaluateRound(obs, { policy: 'softmax', weights: DEFAULT_WEIGHTS, chanceSeeds: 1 });
    const eq = before.choices.find((c) => c.action.id === 'move:earthquake')!;
    const splash = before.choices.find((c) => c.action.id === 'move:splash')!;
    const ranked: RankedChoice[] = [
      { id: splash.action.id, score: splash.choiceScore, features: splash.features, success: splash.success },
      { id: eq.action.id, score: eq.choiceScore, features: eq.features, success: eq.success },
    ];
    let w = { ...DEFAULT_WEIGHTS };
    for (let i = 0; i < 12; i++) w = elasticUpdate(w, ranked).weights;
    saveWeights(w, file);
    const after = await evaluateRound(obs, { policy: 'softmax', weights: loadWeights(file), chanceSeeds: 1 });
    const eqAfter = after.choices.find((c) => c.action.id === 'move:earthquake')!;
    const splashAfter = after.choices.find((c) => c.action.id === 'move:splash')!;
    expect(eqAfter.probability ?? 0).toBeLessThan(eq.probability ?? 1);
    expect(splashAfter.probability ?? 0).toBeGreaterThan(splash.probability ?? 0);
    const pairBefore = before.pairs?.find((p) => p.ourId === 'move:earthquake' && p.theirId === 'move:splash')?.score;
    const pairAfter = after.pairs?.find((p) => p.ourId === 'move:earthquake' && p.theirId === 'move:splash')?.score;
    expect(pairBefore).toBeDefined();
    expect(pairAfter).toBeDefined();
    expect(pairAfter).not.toBeCloseTo(pairBefore!, 8);
    expect(after.roundScore).not.toBeCloseTo(before.roundScore, 8);
    const joint = await evaluateJointStatePolicy(obs, { policy: 'softmax', weights: loadWeights(file), chanceSeeds: 1 });
    expect(joint.hypotheses[0]!.probabilities.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    const byUtil = [...after.replies].sort((a, b) => (b.expectedUtility ?? 0) - (a.expectedUtility ?? 0));
    const byProb = [...after.replies].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0));
    expect(byUtil.map((r) => r.action.id)).toEqual(byProb.map((r) => r.action.id));
    const restored = resetWeights(file);
    expect(restored).toEqual(DEFAULT_WEIGHTS);
    const again = await evaluateRound(obs, { policy: 'softmax', weights: loadWeights(file), chanceSeeds: 1 });
    expect(again.roundScore).toBeCloseTo(before.roundScore, 8);
    expect(again.choices.find((c) => c.action.id === 'move:earthquake')!.probability)
      .toBeCloseTo(eq.probability ?? 0, 8);
  }, 40_000);
});
