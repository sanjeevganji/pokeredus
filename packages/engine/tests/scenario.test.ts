import { describe, it, expect } from 'vitest';
import {
  emptyBoosts,
  emptyField,
  estimateWinrate,
  evaluateRound,
  flipObservation,
  forecastBattle,
  playTurn,
  type BattleObservation,
  type CanonicalSet,
  type SlotSnapshot,
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

describe('scenario helpers', () => {
  it('flipObservation yields a finite eval', async () => {
    const flipped = flipObservation(obs(toxapex, garchomp));
    expect(flipped.ourSide).toBe('p2');
    const ev = await evaluateRound(flipped, { chanceSeeds: 1 });
    expect(ev.choices.length).toBeGreaterThan(0);
    expect(Number.isFinite(ev.roundScore)).toBe(true);
  }, 20_000);

  it('weights damaging opponent replies above splash', async () => {
    const ev = await evaluateRound(obs(toxapex, garchomp), { chanceSeeds: 1 });
    const eq = ev.replies.find((r) => r.action.id === 'move:earthquake');
    const splash = ev.replies.find((r) => r.action.id === 'move:splash');
    expect(eq).toBeTruthy();
    expect(splash).toBeTruthy();
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
    const r = await estimateWinrate(obs(garchomp, toxapex), { n: 2, maxTurns: 1, chanceSeeds: 1, rng: () => 0 });
    expect(r.wins + r.losses + r.draws).toBe(2);
    expect(r.n).toBe(2);
  }, 30_000);

  describe('forecastBattle terminal rollouts', () => {
    it('is deterministic under fixed seed', async () => {
      const o = obs(garchomp, toxapex);
      const f1 = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 42, chanceSeeds: 1 });
      const f2 = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 42, chanceSeeds: 1 });
      expect(f1.status).toBe('complete');
      expect(f2.status).toBe('complete');
      expect(f1.totalSamples).toBe(f2.totalSamples);
      expect(f1.choices.length).toBe(f2.choices.length);
      for (let i = 0; i < f1.choices.length; i++) {
        expect(f1.choices[i]!.expectedTerminalScore).toBeCloseTo(f2.choices[i]!.expectedTerminalScore, 5);
        expect(f1.choices[i]!.wins).toBe(f2.choices[i]!.wins);
        expect(f1.choices[i]!.losses).toBe(f2.choices[i]!.losses);
      }
    }, 40_000);

    it('allocates samples to all root actions and satisfies score bounds & Wilson intervals', async () => {
      const o = obs(garchomp, toxapex);
      const f = await forecastBattle(o, { rolloutsPerChoice: 2, maxTurns: 3, seed: 123, chanceSeeds: 1 });
      expect(f.status).toBe('complete');
      expect(f.choices.length).toBeGreaterThan(0);
      for (const c of f.choices) {
        expect(c.samples).toBe(2);
        expect(c.wins + c.losses + c.draws).toBe(c.samples);
        expect(c.minTerminalScore).toBeLessThanOrEqual(c.expectedTerminalScore);
        expect(c.expectedTerminalScore).toBeLessThanOrEqual(c.maxTerminalScore);
        expect(c.winRateLow).toBeLessThanOrEqual(c.winRate);
        expect(c.winRate).toBeLessThanOrEqual(c.winRateHigh);
      }
    }, 40_000);

    it('fails with incomplete-assumptions when unrevealed slot without hypotheses is marked incomplete', async () => {
      const o = obs(garchomp, toxapex);
      o.theirs[0]!.setComplete = false;
      o.theirs[0]!.set = undefined;
      o.theirs[0]!.hypotheses = [];
      const f = await forecastBattle(o, { rolloutsPerChoice: 1 });
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
        chanceSeeds: 1,
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

  it.todo('samples a hypothesis then a conditional reply (plan 009)');
});
