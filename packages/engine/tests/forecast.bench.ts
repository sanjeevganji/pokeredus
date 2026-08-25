import { describe, it, expect } from 'vitest';
import {
  forecastBattle,
  loadShowdown,
  prngSeedFromInt,
  emptyField,
  emptyBoosts,
  placeholderSlot,
  QuantumPolicyProcess,
  type BattleObservation,
  type CanonicalSet,
  type SlotSnapshot,
} from '../src/index.js';

function asSet(raw: Record<string, unknown>): CanonicalSet {
  const moves = Array.isArray(raw.moves) ? raw.moves.map(String) : [];
  return {
    species: String(raw.species ?? raw.name ?? ''),
    level: Number(raw.level ?? 100),
    item: String(raw.item ?? ''),
    ability: String(raw.ability ?? ''),
    moves,
    nature: String(raw.nature ?? 'Hardy'),
    gender: raw.gender ? String(raw.gender) : undefined,
    teraType: raw.teraType ? String(raw.teraType) : undefined,
  };
}

function speciesId(set: CanonicalSet): string {
  return set.species.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function fullSlots(team: CanonicalSet[]): SlotSnapshot[] {
  return team.map((set, i) => ({
    slot: i,
    speciesId: speciesId(set),
    revealed: true,
    hp: 250,
    maxHp: 250,
    status: '',
    boosts: emptyBoosts(),
    fainted: false,
    active: i === 0,
    knownMoves: set.moves,
    set,
    hypotheses: [{ set, count: 1, probability: 1 }],
    modifiers: [],
  }));
}

describe('forecast benchmark', () => {
  it('measures complete 6v6 scenario rollout metrics', async () => {
    const PS = loadShowdown();
    const ours = (PS.Teams.generate!('gen9randombattle', { seed: prngSeedFromInt(100) }) as Record<string, unknown>[]).map(asSet);
    const theirs = (PS.Teams.generate!('gen9randombattle', { seed: prngSeedFromInt(200) }) as Record<string, unknown>[]).map(asSet);

    const legal = ours[0]!.moves.filter(Boolean).slice(0, 4).map((moveId) => ({
      id: `move:${moveId}`, type: 'move' as const, moveId,
    }));

    const obs: BattleObservation = {
      turn: 1,
      format: 'gen9randombattle',
      ourSide: 'p1',
      ours: fullSlots(ours),
      theirs: fullSlots(theirs),
      field: emptyField(),
      legalActions: legal,
      teraUsedOurs: false,
      teraUsedTheirs: false,
    };

    // Cold and warm per-state QAOA latency
    const proc = new QuantumPolicyProcess({ timeoutMs: 30_000 });
    let coldMs = 0;
    let warmMs = 0;
    try {
      const t0 = Date.now();
      await proc.decide({ actions: ['m1', 'm2'], scores: [0.1, 0.2], mode: 'quantum', seed: 1 });
      coldMs = Date.now() - t0;
      const t1 = Date.now();
      await proc.decide({ actions: ['m1', 'm2'], scores: [0.1, 0.2], mode: 'quantum', seed: 1 });
      warmMs = Date.now() - t1;
    } finally {
      proc.close();
    }

    let firstProgressMs = 0;
    const start = Date.now();

    const forecast = await forecastBattle(obs, {
      rolloutsPerChoice: 2,
      maxTurns: 16,
      timeBudgetMs: 10_000,
      seed: 42,
      chanceSeeds: 1,
      onProgress: () => {
        if (!firstProgressMs) firstProgressMs = Date.now() - start;
      },
    });

    const elapsed = Date.now() - start;
    const rolloutsPerSec = forecast.totalSamples / (elapsed / 1000);
    const hits = (forecast.diagnostics?.cacheHits as number) ?? 0;
    const misses = (forecast.diagnostics?.cacheMisses as number) ?? 0;
    const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0;

    console.log('\n--- 6v6 Forecast Benchmark ---');
    console.log(`Cold per-state QAOA latency: ${coldMs}ms`);
    console.log(`Warm per-state QAOA latency: ${warmMs}ms`);
    console.log(`Total rollouts: ${forecast.totalSamples}`);
    console.log(`Elapsed ms: ${elapsed}ms`);
    console.log(`Rollouts/sec: ${rolloutsPerSec.toFixed(2)}`);
    console.log(`Cache hit rate: ${hitRate.toFixed(1)}% (${hits} hits / ${misses} misses)`);
    console.log(`Time to first partial: ${firstProgressMs}ms`);
    console.log(`Cache stats:`, forecast.diagnostics);
    console.log(`Status: ${forecast.status}`);

    expect(forecast.totalSamples).toBeGreaterThan(0);
    expect(forecast.choices.length).toBe(legal.length);
  }, 40_000);
});
