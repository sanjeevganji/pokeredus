import { describe, it, expect, afterEach } from 'vitest';
import { QuantumPolicyProcess, sampleAction, transformSidePolicy } from '../src/policy.js';
import {
  emptyBoosts,
  emptyField,
  placeholderSet,
  placeholderSlot,
  type BattleObservation,
  type CanonicalSet,
  type LegalAction,
  type SlotSnapshot,
} from '../src/observation.js';
import { evaluateJointStatePolicy, evaluateRound, simulationAssumptions } from '../src/evaluate.js';
import { softmax } from '../src/math.js';

describe('QuantumPolicyProcess hardening', () => {
  let proc: QuantumPolicyProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.close();
      proc = null;
    }
  });

  it('rejects illegal distribution with non-matching length', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 10_000 });
    await expect(proc.decide({
      actions: ['a', 'b', 'c'],
      scores: [1.0, 2.0], // mismatch length
      mode: 'softmax',
    })).rejects.toThrow();
  }, 20_000);

  it('times out and cleans up pending waiter', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 50 });
    // Intentionally request with very short timeout
    await expect(proc.decide({
      actions: ['a', 'b'],
      scores: [0.1, 0.2],
      mode: 'quantum',
      timeoutMs: 1,
    })).rejects.toThrow(/timed out/);
  }, 20_000);

  it('returns valid normalized probabilities in softmax mode', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 10_000 });
    const res = await proc.decide({
      actions: ['m1', 'm2', 'm3'],
      scores: [0.1, 0.5, 0.2],
      mode: 'softmax',
    });
    expect(res.probabilities).toHaveLength(3);
    const sum = res.probabilities.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  }, 20_000);

  it('sampleAction rejects empty or invalid probabilities', () => {
    expect(() => sampleAction([], [])).toThrow('no legal actions');
    expect(() => sampleAction(['a'], [0])).toThrow('illegal probability distribution');
    expect(() => sampleAction(['a', 'b'], [0.5])).toThrow('illegal probability distribution');
  });
});

function asSet(species: string, moves: string[], extra?: Partial<CanonicalSet>): CanonicalSet {
  return { species, level: 80, item: '', ability: 'owntempo', moves, nature: 'Hardy', ...extra };
}

function move(id: string): LegalAction {
  return { id: `move:${id}`, type: 'move', moveId: id };
}

function activeSlot(set: CanonicalSet, extra?: Partial<SlotSnapshot>): SlotSnapshot {
  return {
    slot: 0,
    speciesId: set.species.toLowerCase().replace(/[^a-z0-9]/g, ''),
    revealed: true,
    hp: 250,
    maxHp: 250,
    status: '',
    boosts: emptyBoosts(),
    fainted: false,
    active: true,
    knownMoves: set.moves,
    set,
    hypotheses: [],
    modifiers: [],
    ...extra,
  };
}

function fixtureObs(args: {
  ourMoves: string[];
  theirHyps: Array<{ set: CanonicalSet; probability: number }>;
  extra?: Partial<SlotSnapshot>;
}): BattleObservation {
  const lead = args.theirHyps[0]!.set;
  return {
    turn: 1,
    format: 'gen9randombattle',
    ourSide: 'p1',
    ours: [activeSlot(asSet('Garchomp', args.ourMoves))],
    theirs: [
      activeSlot(lead, {
        hypotheses: args.theirHyps.map((h) => ({ set: h.set, count: 1, probability: h.probability })),
        ...args.extra,
      }),
      ...Array.from({ length: 5 }, (_, i) => placeholderSlot(i + 1)),
    ],
    field: emptyField(),
    legalActions: args.ourMoves.map(move),
    teraUsedOurs: false,
    teraUsedTheirs: false,
  };
}

describe('simulationAssumptions', () => {
  it('collapses a compatible manual override to probability one', () => {
    const set = placeholderSet();
    const hyps = simulationAssumptions(activeSlot(set, {
      setSource: 'manual',
      hypotheses: [
        { set, count: 1, probability: 0.6 },
        { set: asSet('Smeargle', ['splash'], { item: 'leftovers' }), count: 1, probability: 0.4 },
      ],
    }));
    expect(hyps).toHaveLength(1);
    expect(hyps[0]!.probability).toBe(1);
    expect(hyps[0]!.set).toEqual(set);
  });

  it('normalizes public hypothesis mass', () => {
    const a = asSet('Blissey', ['splash']);
    const b = asSet('Blissey', ['softboiled'], { item: 'leftovers' });
    const hyps = simulationAssumptions(activeSlot(a, {
      hypotheses: [
        { set: a, count: 9, probability: 0.45 },
        { set: b, count: 1, probability: 0.05 },
      ],
    }));
    expect(hyps.reduce((s, h) => s + h.probability, 0)).toBeCloseTo(1);
    expect(hyps[0]!.probability).toBeCloseTo(0.9);
  });

  it('falls back to one complete selected set when hypotheses are absent', () => {
    const set = placeholderSet();
    const hyps = simulationAssumptions(activeSlot(set, { hypotheses: [] }));
    expect(hyps).toHaveLength(1);
    expect(hyps[0]!.probability).toBe(1);
  });

  it('throws on zero or NaN mass and on no complete assumption', () => {
    const set = placeholderSet();
    expect(() => simulationAssumptions(activeSlot(set, {
      hypotheses: [{ set, count: 1, probability: 0 }],
    }))).toThrow(/zero or non-finite/);
    expect(() => simulationAssumptions(activeSlot(set, {
      hypotheses: [{ set, count: 1, probability: Number.NaN }],
    }))).toThrow(/zero or non-finite/);
    expect(() => simulationAssumptions(placeholderSlot(0))).toThrow(/no complete simulation assumption/);
  });
});

describe('transformSidePolicy', () => {
  it('softmax-normalizes actor-positive scores in order', async () => {
    const scores = [0.2, -0.1, 0.5];
    const res = await transformSidePolicy(undefined, ['a', 'b', 'c'], scores, { policy: 'softmax' }, { actor: 'ours' });
    expect(res.probs).toEqual(softmax(scores));
    expect(res.probs.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    expect(res.diagnostics.mode).toBe('softmax');
  });

  it('rejects non-finite scores with actor context and no hidden set details', async () => {
    await expect(transformSidePolicy(
      undefined, ['a'], [Number.NaN], { policy: 'softmax' }, { actor: 'theirs', hypothesis: true },
    )).rejects.toThrow(/theirs hypothesis/);
    await expect(transformSidePolicy(
      undefined, ['a'], [Number.NaN], { policy: 'softmax' }, { actor: 'theirs', hypothesis: true },
    )).rejects.not.toThrow(/leftovers|garchomp|smeargle/i);
  });

  it('validates a mock quantum response then normalizes', async () => {
    const process = {
      decide: async (req: { actions: string[] }) => ({
        probabilities: req.actions.map(() => 2),
        diagnostics: { mode: 'quantum', n_qubits: 1 },
      }),
    } as unknown as QuantumPolicyProcess;
    const res = await transformSidePolicy(process, ['x', 'y'], [0.1, -0.2], { policy: 'quantum' }, { actor: 'ours' });
    expect(res.probs).toEqual([0.5, 0.5]);
    expect(res.diagnostics.mode).toBe('quantum');
  });
});

describe('two-sided hypothesis policy', () => {
  const common = asSet('Blissey', ['splash']);
  const rareSet = asSet('Blissey', ['splash', 'earthquake'], { item: 'leftovers' });

  async function evalGrid(extra?: Partial<SlotSnapshot>, nOur = 1) {
    const ourMoves = nOur === 1 ? ['tackle'] : Array.from({ length: nOur }, (_, i) => `move${i}`);
    const obs = fixtureObs({
      ourMoves,
      theirHyps: [
        { set: common, probability: 0.9 },
        { set: rareSet, probability: 0.1 },
      ],
      extra,
    });
    return evaluateJointStatePolicy(obs, {
      policy: 'softmax',
      pairDelta: (ourId, theirId) => (theirId === 'move:earthquake' ? -0.8 : 0.1),
    });
  }

  it('keeps rare-set-only availability at the prior mass', async () => {
    const res = await evalGrid();
    const rare = res.evaluation.replies.find((r) => r.action.id === 'move:earthquake');
    expect(rare).toBeTruthy();
    expect(rare!.availability).toBeCloseTo(0.1);
    expect(rare!.probability ?? 0).toBeLessThanOrEqual(0.1 + 1e-12);
  });

  it('normalizes hypothesis and conditional action probabilities', async () => {
    const res = await evalGrid();
    expect(res.hypotheses.reduce((s, h) => s + h.probability, 0)).toBeCloseTo(1);
    expect(res.pOur.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    for (const h of res.hypotheses) {
      expect(h.probabilities.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    }
    expect(res.evaluation.replies.reduce((s, r) => s + (r.probability ?? 0), 0)).toBeCloseTo(1);
    expect(res.evaluation.roundScore).toBeGreaterThanOrEqual(-1);
    expect(res.evaluation.roundScore).toBeLessThanOrEqual(1);
    expect(res.evaluation.roundScore).toBeCloseTo(res.evaluation.expectedRoundScore);
  });

  it('makes a manual override assumption mass one without erasing public candidates', async () => {
    const publicHyps = [
      { set: common, count: 1, probability: 0.9 },
      { set: rareSet, count: 1, probability: 0.1 },
    ];
    const res = await evalGrid({ setSource: 'manual', set: rareSet, hypotheses: publicHyps });
    expect(res.hypotheses).toHaveLength(1);
    expect(res.hypotheses[0]!.probability).toBeCloseTo(1);
    expect(res.hypotheses[0]!.actions.some((a) => a.id === 'move:earthquake')).toBe(true);
    const rare = res.evaluation.replies.find((r) => r.action.id === 'move:earthquake');
    expect(rare!.availability).toBeCloseTo(1);
    expect(res.evaluation.choices[0]).toBeTruthy();
    const obs = fixtureObs({
      ourMoves: ['tackle'],
      theirHyps: [
        { set: common, probability: 0.9 },
        { set: rareSet, probability: 0.1 },
      ],
      extra: { setSource: 'manual', set: rareSet, hypotheses: publicHyps },
    });
    await evaluateRound(obs, { policy: 'softmax', pairDelta: () => 0 });
    expect(obs.theirs[0]!.hypotheses).toEqual(publicHyps);
  });

  it('negates pair delta for opponent utility and favors harm to us', async () => {
    const obs = fixtureObs({
      ourMoves: ['tackle'],
      theirHyps: [{ set: asSet('Blissey', ['earthquake', 'splash']), probability: 1 }],
    });
    const res = await evaluateJointStatePolicy(obs, {
      policy: 'softmax',
      pairDelta: (_o, theirId) => (theirId === 'move:earthquake' ? -0.8 : 0.8),
    });
    const hurt = res.evaluation.replies.find((r) => r.action.id === 'move:earthquake')!;
    const help = res.evaluation.replies.find((r) => r.action.id === 'move:splash')!;
    expect(hurt.expectedUtility ?? 0).toBeGreaterThan(help.expectedUtility ?? 0);
    expect(hurt.probability ?? 0).toBeGreaterThan(help.probability ?? 0);
    expect(hurt.expectedUtility).toBeCloseTo(0.8, 5);
    expect(help.expectedUtility).toBeCloseTo(-0.8, 5);
    const ourU = res.evaluation.choices[0]!.expectedUtility ?? 0;
    expect(ourU).toBeCloseTo(res.evaluation.roundScore, 8);
    expect(ourU).toBeCloseTo(
      (hurt.probability ?? 0) * -0.8 + (help.probability ?? 0) * 0.8,
      5,
    );
  });

  it('represents every our action when the pair count exceeds 32', async () => {
    const their = asSet('Blissey', ['a', 'b', 'c', 'd', 'e']);
    const ours = Array.from({ length: 8 }, (_, i) => `m${i}`);
    const obs = fixtureObs({
      ourMoves: ours,
      theirHyps: [{ set: their, probability: 1 }],
    });
    expect(8 * 5).toBeGreaterThan(32);
    const res = await evaluateJointStatePolicy(obs, {
      policy: 'softmax',
      pairDelta: () => 0.01,
    });
    expect(res.pOur).toHaveLength(8);
    expect(res.diagnostics.legalPairCount).toBe(40);
    expect(res.pOur.every((p) => p > 0)).toBe(true);
    expect(res.pOur.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
    expect(res.evaluation.choices).toHaveLength(8);
  });

  it('QAOA coverage stays finite and includes every legal our action', async () => {
    const process = {
      decide: async (req: { actions: string[] }) => ({
        probabilities: req.actions.map(() => 1),
        diagnostics: { mode: 'quantum', n_qubits: 3 },
      }),
    } as unknown as QuantumPolicyProcess;
    const their = asSet('Blissey', ['a', 'b', 'c', 'd', 'e']);
    const ours = Array.from({ length: 8 }, (_, i) => `m${i}`);
    const res = await evaluateJointStatePolicy(fixtureObs({
      ourMoves: ours,
      theirHyps: [{ set: their, probability: 1 }],
    }), {
      refine: process,
      policy: 'quantum',
      pairDelta: () => 0.01,
    });
    expect(res.pOur).toHaveLength(8);
    expect(res.pOur.every((p) => Number.isFinite(p) && p > 0)).toBe(true);
    expect(res.pOur.reduce((s, p) => s + p, 0)).toBeCloseTo(1);
  });
});

