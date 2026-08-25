import { describe, it, expect } from 'vitest';
import {
  cloneBattle,
  createBattle,
  emptyBoosts,
  emptyField,
  evaluateRound,
  loadShowdown,
  placeholderSlot,
  probeClone,
  prngSeedFromInt,
  QuantumPolicyProcess,
  sampleAction,
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

function ourSlots(team: CanonicalSet[]): SlotSnapshot[] {
  const padded = [...team];
  while (padded.length < 6) padded.push({
    species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy',
  });
  return padded.slice(0, 6).map((set, i) => ({
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
    hypotheses: [],
    modifiers: [],
  }));
}

function theirSlots(team: CanonicalSet[]): SlotSnapshot[] {
  const lead = team[0]!;
  const active: SlotSnapshot = {
    slot: 0,
    speciesId: speciesId(lead),
    revealed: true,
    hp: 250,
    maxHp: 250,
    status: '',
    boosts: emptyBoosts(),
    fainted: false,
    active: true,
    knownMoves: lead.moves,
    set: lead,
    hypotheses: [{ set: lead, count: 1, probability: 1 }],
    modifiers: [],
  };
  return [active, ...Array.from({ length: 5 }, (_, i) => placeholderSlot(i + 1))];
}

describe('official Showdown one-round sim', () => {
  it('clones battle state for counterfactual branches', () => {
    expect(() => probeClone()).not.toThrow();
    const PS = loadShowdown();
    expect(PS.Battle).toBeTypeOf('function');
    const team = (PS.Teams.generate!('gen9randombattle') as Record<string, unknown>[]).map(asSet);
    const obs: BattleObservation = {
      turn: 1,
      format: 'gen9randombattle',
      ourSide: 'p1',
      ours: ourSlots(team),
      theirs: theirSlots(team),
      field: emptyField(),
      legalActions: team[0]!.moves.map((moveId) => ({ id: `move:${moveId}`, type: 'move' as const, moveId })),
      teraUsedOurs: false,
      teraUsedTheirs: false,
    };
    const b = createBattle(obs, [1, 2, 3, 4]);
    const c = cloneBattle(b);
    expect(c).toBeTruthy();
  });

  it('seeded gen9randombattle round yields a QAOA distribution and dry-run choice', async () => {
    const PS = loadShowdown();
    const ours = (PS.Teams.generate!('gen9randombattle', { seed: prngSeedFromInt(1) }) as Record<string, unknown>[]).map(asSet);
    const theirs = (PS.Teams.generate!('gen9randombattle', { seed: prngSeedFromInt(2) }) as Record<string, unknown>[]).map(asSet);
    const legal = ours[0]!.moves.filter(Boolean).slice(0, 4).map((moveId) => ({
      id: `move:${moveId}`, type: 'move' as const, moveId,
    }));
    const obs: BattleObservation = {
      turn: 1,
      format: 'gen9randombattle',
      ourSide: 'p1',
      ours: ourSlots(ours),
      theirs: theirSlots(theirs),
      field: emptyField(),
      legalActions: legal,
      teraUsedOurs: false,
      teraUsedTheirs: false,
    };
    const evaluation = await evaluateRound(obs, { chanceSeeds: 1 });
    expect(evaluation.choices.length).toBeGreaterThan(0);
    expect(evaluation.replies.length).toBeGreaterThan(0);
    expect(evaluation.roundScore).toBeGreaterThanOrEqual(-6);
    expect(evaluation.roundScore).toBeLessThanOrEqual(6);
    for (const c of evaluation.choices) {
      const raw = c.features.health + c.features.modifier + c.features.secondary + c.features.sacrifice - c.features.switchRisk;
      expect(c.choiceScore).toBeCloseTo(c.success * raw);
      expect(c.expectedHealthDelta + c.expectedModifierDelta).toBeCloseTo(c.expectedImpact);
    }

    const policy = new QuantumPolicyProcess({ timeoutMs: 40_000 });
    try {
      const res = await policy.decide({
        actions: evaluation.choices.map((c) => c.action.id),
        scores: evaluation.choices.map((c) => c.scaledChoiceScore),
        mode: 'quantum',
        seed: 1,
      });
      expect(res.probabilities.length).toBe(evaluation.choices.length);
      const sum = res.probabilities.reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.99);
      expect(sum).toBeLessThan(1.01);
      const sampled = sampleAction(
        evaluation.choices.map((c) => c.action.id),
        res.probabilities,
        () => 0,
      );
      expect(evaluation.choices.map((c) => c.action.id)).toContain(sampled);
    } finally {
      policy.close();
    }
  }, 60_000);
});
