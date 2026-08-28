import { describe, it, expect } from 'vitest';
import {
  emptyBoosts,
  emptyField,
  estimateWinrate,
  evaluateRound,
  evaluateJointStatePolicy,
  flipObservation,
  forecastBattle,
  forecastCacheKey,
  playTurn,
  classifyRolloutState,
  buildRolloutWorld,
  scoreRealizedPair,
  simulateRound,
  DEFAULT_WEIGHTS,
  emptyValuationRegistry,
  createSeededRng,
  type BattleObservation,
  type CanonicalSet,
  type SlotSnapshot,
  type LegalAction,
  type RoundSimResult,
  type BattleForecast,
  type QuantumPolicyProcess,
} from '../src/index.js';

const garchomp: CanonicalSet = {
  species: 'Garchomp', level: 80, item: '', ability: 'roughskin',
  moves: ['earthquake', 'splash'], nature: 'Jolly',
};
const toxapex: CanonicalSet = {
  species: 'Toxapex', level: 88, item: 'blacksludge', ability: 'regenerator',
  moves: ['recover'], nature: 'Bold',
};

function sid(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slot(set: CanonicalSet, i: number, active: boolean, extra?: Partial<SlotSnapshot>): SlotSnapshot {
  return {
    slot: i,
    speciesId: sid(set.species),
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
  };
}

function bench(lead: CanonicalSet, rest: CanonicalSet[] = []): SlotSnapshot[] {
  const team = [lead, ...rest];
  while (team.length < 6) {
    team.push({ species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' });
  }
  return team.slice(0, 6).map((set, i) => slot(set, i, i === 0, i === 0 ? undefined : { revealed: set.species !== 'Smeargle' }));
}

function obs(ours: CanonicalSet, theirs: CanonicalSet): BattleObservation {
  return {
    turn: 1,
    format: 'gen9randombattle',
    ourSide: 'p1',
    ours: bench(ours),
    theirs: [
      slot(theirs, 0, true),
      ...Array.from({ length: 5 }, (_, i) => slot(
        { species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' },
        i + 1, false, { revealed: false, hypotheses: [] },
      )),
    ],
    field: emptyField(),
    legalActions: ours.moves.map((moveId) => ({ id: `move:${moveId}`, type: 'move' as const, moveId })),
    teraUsedOurs: false,
    teraUsedTheirs: false,
  };
}

function emptyTel(): RoundSimResult['ours'] {
  return {
    announced: true, first: true, missed: false, failed: false,
    executed: true, hit: true, aliveAtExecution: true, effects: [],
  };
}

function passthrough(o: BattleObservation, extra?: Partial<RoundSimResult>): RoundSimResult {
  return {
    afterOurs: o.ours.map((s) => ({ ...s, boosts: { ...s.boosts }, modifiers: [...s.modifiers] })),
    afterTheirs: o.theirs.map((s) => ({ ...s, boosts: { ...s.boosts }, modifiers: [...s.modifiers] })),
    afterField: { ...o.field },
    pHit: 1, pExecute: 1, aliveAtExecution: 1,
    weWin: false, theyWin: false,
    ours: emptyTel(), theirs: emptyTel(),
    ...extra,
  };
}

function faintSide(slots: SlotSnapshot[]): SlotSnapshot[] {
  return slots.map((s) => ({ ...s, hp: 0, fainted: true }));
}

function sampleRecords(f: BattleForecast): Array<{
  actionId: string;
  cumulativeRealizedDelta: number;
  outcome: string;
  terminalUtility: number;
  hypothesisKeys: string[];
  sampledIds: string[];
}> {
  return (f.diagnostics?.sampleRecords ?? []) as ReturnType<typeof sampleRecords>;
}

const soft = { policy: 'softmax' as const, chanceSeeds: 1, timeBudgetMs: 60_000 };

function forceIds(...prefer: string[]): QuantumPolicyProcess {
  return {
    decide: async (req: { actions: string[] }) => ({
      probabilities: req.actions.map((id) => (prefer.some((p) => id.includes(p)) ? 1 : 1e-9)),
      diagnostics: { mode: 'quantum' },
    }),
  } as unknown as QuantumPolicyProcess;
}

describe('scenario helpers', () => {
  it('flipObservation yields a finite eval', async () => {
    const flipped = flipObservation(obs(toxapex, garchomp));
    expect(flipped.ourSide).toBe('p2');
    const ev = await evaluateRound(flipped, { chanceSeeds: 1 });
    expect(ev.choices.length).toBeGreaterThan(0);
    expect(Number.isFinite(ev.roundScore)).toBe(true);
  }, 20_000);

  it('weights damaging opponent replies above splash', async () => {
    const ev = await evaluateRound(obs(garchomp, garchomp), { chanceSeeds: 1, policy: 'softmax' });
    const eq = ev.replies.find((r) => r.action.id === 'move:earthquake');
    const splash = ev.replies.find((r) => r.action.id === 'move:splash');
    expect(eq).toBeTruthy();
    expect(splash).toBeTruthy();
    expect(eq!.expectedUtility ?? 0).toBeGreaterThan(splash!.expectedUtility ?? 0);
    expect(eq!.probability ?? 0).toBeGreaterThan(splash!.probability ?? 0);
  }, 20_000);

  it('playTurn advances HP or ends the round', async () => {
    const start = obs(garchomp, toxapex);
    const before = start.theirs[0]!.hp + start.ours[0]!.hp;
    const played = await playTurn(start, 'move:earthquake', 'ours', { chanceSeeds: 1, rng: () => 0 });
    const after = played.observation.theirs[0]!.hp + played.observation.ours[0]!.hp;
    expect(played.observation.turn).toBe(start.turn + 1);
    expect(after <= before || played.weWin || played.theyWin).toBe(true);
  }, 20_000);

  it('estimateWinrate counts n games', async () => {
    const r = await estimateWinrate(obs(garchomp, toxapex), { n: 2, maxTurns: 1, chanceSeeds: 1, rng: () => 0, policy: 'softmax' });
    expect(r.wins + r.losses + r.draws).toBe(2);
    expect(r.n).toBe(2);
  }, 30_000);

  describe('forecastBattle terminal rollouts', () => {
    it('is deterministic under fixed seed', async () => {
      const o = obs(garchomp, toxapex);
      const f1 = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 42, ...soft });
      const f2 = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 42, ...soft });
      expect(f1.status).toBe('complete');
      expect(f2.status).toBe('complete');
      expect(f1.totalSamples).toBe(f2.totalSamples);
      expect(f1.choices.length).toBe(f2.choices.length);
      expect(sampleRecords(f1)).toEqual(sampleRecords(f2));
      for (let i = 0; i < f1.choices.length; i++) {
        expect(f1.choices[i]!.expectedTerminalScore).toBeCloseTo(f2.choices[i]!.expectedTerminalScore, 5);
        expect(f1.choices[i]!.wins).toBe(f2.choices[i]!.wins);
        expect(f1.choices[i]!.losses).toBe(f2.choices[i]!.losses);
      }
    }, 40_000);

    it('allocates samples to all root actions and satisfies score bounds & Wilson intervals', async () => {
      const o = obs(garchomp, toxapex);
      const f = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 123, ...soft });
      expect(f.status).toBe('complete');
      expect(f.choices.length).toBeGreaterThan(0);
      for (const c of f.choices) {
        expect(c.samples).toBe(2);
        expect(c.wins + c.losses + c.draws + c.errors).toBe(c.samples);
        expect(c.draws).toBe(c.unknownFrontiers + c.turnCaps + c.timeCaps);
        expect(c.capped).toBe(c.turnCaps + c.timeCaps);
        expect(c.minTerminalScore).toBeLessThanOrEqual(c.expectedTerminalScore);
        expect(c.expectedTerminalScore).toBeLessThanOrEqual(c.maxTerminalScore);
        if (c.winRate == null) {
          expect(c.winRateLow).toBeNull();
          expect(c.winRateHigh).toBeNull();
        } else {
          expect(c.winRateLow).toBeLessThanOrEqual(c.winRate);
          expect(c.winRate).toBeLessThanOrEqual(c.winRateHigh!);
        }
      }
    }, 40_000);

    it('fails with incomplete-assumptions when unrevealed slot without hypotheses is marked incomplete', async () => {
      const o = obs(garchomp, toxapex);
      o.theirs[0]!.setComplete = false;
      o.theirs[0]!.set = undefined;
      o.theirs[0]!.hypotheses = [];
      const f = await forecastBattle(o, { rolloutsPerChoice: 1, ...soft });
      expect(f.status).toBe('incomplete-assumptions');
      expect(f.assumptionsComplete).toBe(false);
      expect(f.totalSamples).toBe(0);
    }, 20_000);

    it('cancelling via AbortSignal preserves partial completed samples', async () => {
      const o = obs(garchomp, toxapex);
      const controller = new AbortController();
      let progressCalls = 0;
      const forecastPromise = forecastBattle(o, {
        rolloutsPerChoice: 5,
        maxTurns: 4,
        seed: 1,
        ...soft,
        signal: controller.signal,
        onProgress: () => {
          progressCalls++;
          controller.abort();
        },
      });
      const f = await forecastPromise;
      expect(f.status).toBe('cancelled');
      expect(progressCalls).toBeGreaterThan(0);
      expect(f.totalSamples).toBeGreaterThan(0);
    }, 40_000);
  });

  it('does not reconstruct an independent joint product', async () => {
    const res = await evaluateJointStatePolicy(obs(garchomp, toxapex), { chanceSeeds: 1, policy: 'softmax' });
    expect('jointProbs' in res).toBe(false);
    expect(res.hypotheses.length).toBeGreaterThan(0);
    expect(res.pOur.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(res.hypotheses.reduce((s, h) => s + h.probability, 0)).toBeCloseTo(1, 8);
    for (const h of res.hypotheses) {
      expect(h.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    }
    expect(res.evaluation.replies.reduce((s, r) => s + (r.probability ?? 0), 0)).toBeCloseTo(1, 8);
  }, 20_000);
});

describe('realized pair scoring in rollouts', () => {
  const wall: CanonicalSet = {
    species: 'Blissey', level: 80, item: '', ability: 'naturalcure',
    moves: ['splash', 'earthquake'], nature: 'Bold',
  };
  const carp: CanonicalSet = {
    species: 'Magikarp', level: 80, item: '', ability: 'swiftswim',
    moves: ['tackle'], nature: 'Hardy',
  };

  it('adds the realized pair delta, not the root action expected score', async () => {
    const o = obs(carp, wall);
    const pairDelta = (_our: string, their: string) => (their === 'move:earthquake' ? -0.5 : 0.8);
    const ev = await evaluateRound(o, { ...soft, pairDelta });
    const choice = ev.choices.find((c) => c.action.id === 'move:tackle')!;
    const expected = choice.expectedUtility ?? choice.choiceScore;
    expect(expected).not.toBeCloseTo(-0.5, 5);

    const f = await forecastBattle(o, {
      policy: 'quantum',
      refine: forceIds('tackle', 'earthquake'),
      chanceSeeds: 1,
      timeBudgetMs: 60_000,
      pairDelta,
      rolloutsPerChoice: 1,
      maxTurns: 1,
      seed: 1,
    });
    expect(f.status).toBe('complete');
    const recs = sampleRecords(f).filter((r) => r.actionId === 'move:tackle');
    expect(recs.length).toBe(1);
    expect(recs[0]!.sampledIds).toContain('move:earthquake');
    expect(recs[0]!.cumulativeRealizedDelta).toBeCloseTo(-0.5);
    expect(recs[0]!.cumulativeRealizedDelta).not.toBeCloseTo(expected, 5);
    const row = f.choices.find((c) => c.actionId === 'move:tackle')!;
    expect(row.expectedCumulativeDelta).toBeCloseTo(-0.5);
  });

  it('cumulative delta equals the sum of two realized pair deltas', async () => {
    const o = obs(carp, wall);
    o.theirs[1] = slot(garchomp, 1, false);
    o.theirs[1]!.revealed = true;
    o.theirs[1]!.hypotheses = [{ set: garchomp, count: 1, probability: 1 }];
    const pairDelta = (_our: string, their: string, hyp: string) => {
      if (hyp.includes('blissey')) return their === 'move:earthquake' ? -0.4 : 0.2;
      return 0.3;
    };
    const f = await forecastBattle(o, {
      ...soft,
      pairDelta,
      rolloutsPerChoice: 1,
      maxTurns: 2,
      seed: 1,
      simulate: (state) => {
        const theirs = state.theirs.map((s) => ({ ...s, active: s.slot === 1 }));
        return passthrough({ ...state, theirs });
      },
    });
    const recs = sampleRecords(f).filter((r) => r.actionId === 'move:tackle');
    expect(recs.length).toBe(1);
    expect(recs[0]!.turns).toBe(2);
    expect(recs[0]!.cumulativeRealizedDelta).toBeCloseTo(-0.4 + 0.3, 8);
  });

  it('one represented deterministic branch: evaluateRound pair delta equals scoreRealizedPair', async () => {
    const o = obs(garchomp, toxapex);
    const our: LegalAction = { id: 'move:earthquake', type: 'move', moveId: 'earthquake' };
    const their: LegalAction = { id: 'move:recover', type: 'move', moveId: 'recover' };
    const sim = simulateRound(o, our, their, [1, 2, 3, 4]);
    const realized = scoreRealizedPair(o, our, their, sim, DEFAULT_WEIGHTS);
    const ev = await evaluateRound(o, { chanceSeeds: 1, policy: 'softmax' });
    const pair = ev.pairs?.find((p) => p.ourId === our.id && p.theirId === their.id);
    expect(pair).toBeTruthy();
    expect(pair!.score).toBeCloseTo(realized.pairDelta, 8);
  }, 20_000);
});

describe('rollout world freeze and classification', () => {
  const common: CanonicalSet = {
    species: 'Blissey', level: 80, item: '', ability: 'naturalcure', moves: ['splash'], nature: 'Bold',
  };
  const rare: CanonicalSet = {
    species: 'Blissey', level: 80, item: 'leftovers', ability: 'naturalcure', moves: ['softboiled'], nature: 'Bold',
  };

  function twoHypObs(): BattleObservation {
    const o = obs(garchomp, common);
    o.theirs[0]!.hypotheses = [
      { set: common, count: 9, probability: 0.9 },
      { set: rare, count: 1, probability: 0.1 },
    ];
    o.theirs[1] = slot(garchomp, 1, false);
    o.theirs[1]!.revealed = true;
    o.theirs[1]!.hypotheses = [{ set: garchomp, count: 1, probability: 1 }];
    return o;
  }

  it('samples a 90/10 active-set belief once and keeps it after switch-out/switch-in', async () => {
    const o = twoHypObs();
    const rng = createSeededRng(7);
    const world = buildRolloutWorld(o, rng);
    expect('error' in world).toBe(false);
    if ('error' in world) return;
    expect(world.beliefKeyBySideSlot.get('theirs:0')).toBeTruthy();
    let switched = false;
    const f = await forecastBattle(o, {
      ...soft,
      pairDelta: () => 0.1,
      rolloutsPerChoice: 1,
      maxTurns: 3,
      seed: 7,
      simulate: (state) => {
        const theirs = state.theirs.map((s) => ({ ...s, active: switched ? s.slot === 0 : s.slot === 1 }));
        switched = !switched;
        return passthrough({ ...state, theirs });
      },
    });
    const recs = sampleRecords(f);
    expect(recs.length).toBeGreaterThan(0);
    const first = recs[0]!.hypothesisKeys.slice().sort().join('|');
    for (const r of recs) {
      expect(r.hypothesisKeys.slice().sort().join('|')).toBe(first);
    }
  });

  it('never resamples a manual set override from public hypotheses', async () => {
    const o = twoHypObs();
    o.theirs[0]!.setSource = 'manual';
    o.theirs[0]!.set = rare;
    const f = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.05, rolloutsPerChoice: 8, maxTurns: 1, seed: 3,
    });
    const recs = sampleRecords(f);
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      expect(r.hypothesisKeys.join(' ')).toMatch(/leftovers|softboiled/);
    }
  });

  it('exhausting revealed opponents with a hidden slot is unknown-frontier, not a win', async () => {
    const o = obs(garchomp, toxapex);
    expect(o.theirs.filter((s) => !s.revealed).length).toBe(5);
    const f = await forecastBattle(o, {
      ...soft,
      pairDelta: () => 0.2,
      rolloutsPerChoice: 1,
      maxTurns: 4,
      seed: 1,
      simulate: (state) => passthrough(state, {
        afterTheirs: state.theirs.map((s) => s.revealed && s.active
          ? { ...s, hp: 0, fainted: true }
          : s),
      }),
    });
    expect(f.outcomeCounts['unknown-frontier']).toBeGreaterThan(0);
    expect(f.outcomeCounts.win).toBe(0);
    expect(f.winRate).toBeNull();
    expect(f.terminalSamples).toBe(0);
    for (const r of sampleRecords(f)) {
      expect(r.outcome).toBe('unknown-frontier');
      expect(r.terminalUtility).not.toBe(1);
      expect(r.terminalUtility).not.toBe(-1);
    }
    const cl = classifyRolloutState({
      ...o,
      theirs: o.theirs.map((s) => s.active ? { ...s, hp: 0, fainted: true } : s),
    });
    expect(cl.kind).toBe('unknown-frontier');
  });

  it('revealing and fainting all six opponent slots is a win with utility +1', async () => {
    const unique: CanonicalSet[] = [
      { ...garchomp, species: 'Garchomp' },
      { ...toxapex, species: 'Toxapex' },
      { species: 'Arcanine', level: 80, item: '', ability: 'intimidate', moves: ['flamethrower'], nature: 'Timid' },
      { species: 'Blissey', level: 80, item: '', ability: 'naturalcure', moves: ['softboiled'], nature: 'Bold' },
      { species: 'Magikarp', level: 80, item: '', ability: 'swiftswim', moves: ['splash'], nature: 'Hardy' },
      { species: 'Snorlax', level: 80, item: '', ability: 'thickfat', moves: ['bodyslam'], nature: 'Adamant' },
    ];
    const o = obs(garchomp, unique[0]!);
    o.theirs = unique.map((set, i) => slot(set, i, i === 0));
    o.ours = unique.map((set, i) => slot(set, i, i === 0));
    o.legalActions = [{ id: 'move:earthquake', type: 'move', moveId: 'earthquake' }];
    const f = await forecastBattle(o, {
      ...soft,
      pairDelta: () => 0.4,
      rolloutsPerChoice: 1,
      maxTurns: 2,
      seed: 1,
      simulate: (state) => passthrough(state, { afterTheirs: faintSide(state.theirs) }),
    });
    expect(f.outcomeCounts.win).toBeGreaterThan(0);
    expect(f.winRate).toBe(1);
    expect(f.terminalSamples).toBeGreaterThan(0);
    for (const r of sampleRecords(f)) {
      expect(r.outcome).toBe('win');
      expect(r.terminalUtility).toBe(1);
    }
  });

  it('fainting all six of ours is a loss with utility -1', async () => {
    const unique: CanonicalSet[] = [
      { ...garchomp, species: 'Garchomp' },
      { ...toxapex, species: 'Toxapex' },
      { species: 'Arcanine', level: 80, item: '', ability: 'intimidate', moves: ['flamethrower'], nature: 'Timid' },
      { species: 'Blissey', level: 80, item: '', ability: 'naturalcure', moves: ['softboiled'], nature: 'Bold' },
      { species: 'Magikarp', level: 80, item: '', ability: 'swiftswim', moves: ['splash'], nature: 'Hardy' },
      { species: 'Snorlax', level: 80, item: '', ability: 'thickfat', moves: ['bodyslam'], nature: 'Adamant' },
    ];
    const o = obs(garchomp, unique[0]!);
    o.ours = unique.map((set, i) => slot(set, i, i === 0));
    o.theirs = unique.map((set, i) => slot(set, i, i === 0));
    o.legalActions = [{ id: 'move:earthquake', type: 'move', moveId: 'earthquake' }];
    const f = await forecastBattle(o, {
      ...soft,
      pairDelta: () => -0.4,
      rolloutsPerChoice: 1,
      maxTurns: 2,
      seed: 1,
      simulate: (state) => passthrough(state, { afterOurs: faintSide(state.ours) }),
    });
    expect(f.outcomeCounts.loss).toBeGreaterThan(0);
    expect(f.winRate).toBe(0);
    for (const r of sampleRecords(f)) {
      expect(r.outcome).toBe('loss');
      expect(r.terminalUtility).toBe(-1);
    }
  });

  it('turn cap, time cap, cancellation, and error have distinct counts/status', async () => {
    const o = obs(garchomp, toxapex);
    const turn = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.1, rolloutsPerChoice: 1, maxTurns: 1, seed: 1,
    });
    expect(turn.choices.every((c) => c.turnCaps === c.samples)).toBe(true);
    expect(turn.status).toBe('complete');

    let sims = 0;
    const timed = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.1, rolloutsPerChoice: 1, maxTurns: 8, seed: 1,
      timeBudgetMs: 100,
      now: () => (sims >= 1 ? 1000 : 0),
      simulate: (state) => {
        sims++;
        return passthrough(state);
      },
    });
    expect(timed.outcomeCounts['time-cap']).toBeGreaterThan(0);

    const ac = new AbortController();
    const cancelled = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.1, rolloutsPerChoice: 4, maxTurns: 2, seed: 1,
      signal: ac.signal,
      onProgress: () => ac.abort(),
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.totalSamples).toBeGreaterThan(0);

    const errored = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.1, rolloutsPerChoice: 1, maxTurns: 2, seed: 1,
      simulate: () => { throw new Error('boom'); },
    });
    expect(errored.outcomeCounts.error).toBeGreaterThan(0);
    expect(errored.status).toBe('error');
  });

  it('unknown/cap outcomes are excluded from terminalSamples and Wilson; zero terminals yield null winRate', async () => {
    const o = obs(garchomp, toxapex);
    const f = await forecastBattle(o, {
      ...soft, pairDelta: () => 0.1, rolloutsPerChoice: 2, maxTurns: 1, seed: 2,
    });
    expect(f.terminalSamples).toBe(0);
    expect(f.winRate).toBeNull();
    expect(f.outcomeCounts.win + f.outcomeCounts.loss).toBe(0);
    const draws = f.outcomeCounts['unknown-frontier'] + f.outcomeCounts['turn-cap'] + f.outcomeCounts['time-cap'];
    for (const c of f.choices) {
      expect(c.draws).toBe(c.unknownFrontiers + c.turnCaps + c.timeCaps);
      expect(c.winRate).toBeNull();
      expect(c.winRateLow).toBeNull();
      expect(c.winRateHigh).toBeNull();
      expect(c.draws).toBe(c.samples - c.errors);
    }
    expect(draws).toBe(f.totalSamples - f.outcomeCounts.error - f.outcomeCounts.cancelled);
  });
});

describe('forecast cache key', () => {
  it('differs when modifier duration, item, belief mass, weights, or valuation metadata differ', () => {
    const base = obs(garchomp, toxapex);
    const a = forecastCacheKey(base);
    const mod = obs(garchomp, toxapex);
    mod.ours[0]!.modifiers = [{ name: 'boost:atk', multiplier: 1.5, remainingTurns: 3 }];
    expect(forecastCacheKey(mod)).not.toBe(a);

    const item = obs(garchomp, toxapex);
    item.ours[0]!.item = 'leftovers';
    expect(forecastCacheKey(item)).not.toBe(a);

    const belief = obs(garchomp, toxapex);
    belief.theirs[0]!.hypotheses = [
      { set: toxapex, count: 1, probability: 0.7 },
      { set: { ...toxapex, item: 'blacksludge' }, count: 1, probability: 0.3 },
    ];
    expect(forecastCacheKey(belief)).not.toBe(a);

    const weights = forecastCacheKey(base, { weights: { ...DEFAULT_WEIGHTS, health: 0.5 } });
    expect(weights).not.toBe(a);

    const val = emptyValuationRegistry();
    val.moves.set('earthquake', [{ multiplier: 1.1, expectedTurns: 1 }]);
    expect(forecastCacheKey(base, { valuations: val })).not.toBe(a);

    const policy = forecastCacheKey(base, { policy: 'softmax', shots: 128 });
    expect(policy).not.toBe(a);
  });
});
