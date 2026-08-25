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
  simulateRound,
  type BattleObservation,
  type CanonicalSet,
  type LegalAction,
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
    expect(evaluation.roundScore).toBe(evaluation.expectedRoundScore);
    expect(evaluation.minRoundScore).toBeLessThanOrEqual(evaluation.expectedRoundScore);
    expect(evaluation.expectedRoundScore).toBeLessThanOrEqual(evaluation.maxRoundScore);
    expect(evaluation.roundScore).toBeGreaterThanOrEqual(-6);
    expect(evaluation.roundScore).toBeLessThanOrEqual(6);
    for (const c of evaluation.choices) {
      expect(Number.isFinite(c.choiceScore)).toBe(true);
      expect(c.minTurnScore).toBeLessThanOrEqual(c.choiceScore + 1e-9);
      expect(c.choiceScore).toBeLessThanOrEqual(c.maxTurnScore + 1e-9);
      expect(c.sampleCount).toBeGreaterThan(0);
      expect(c.minPostScore).toBeLessThanOrEqual(c.meanPostScore + 1e-9);
      expect(c.meanPostScore).toBeLessThanOrEqual(c.maxPostScore + 1e-9);
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

function setOf(species: string, moves: string[], extra?: Partial<CanonicalSet>): CanonicalSet {
  return {
    species, level: 80, item: '', ability: 'owntempo', moves, nature: 'Hardy', ...extra,
  };
}

function duel(ours: CanonicalSet, theirs: CanonicalSet, hp = { ours: 250, theirs: 250 }, field = emptyField()): BattleObservation {
  const ourTeam = ourSlots([ours]);
  ourTeam[0]!.hp = hp.ours;
  ourTeam[0]!.maxHp = 250;
  const theirTeam = theirSlots([theirs]);
  theirTeam[0]!.hp = hp.theirs;
  theirTeam[0]!.maxHp = 250;
  const legal: LegalAction[] = ours.moves.map((moveId) => ({ id: `move:${moveId}`, type: 'move', moveId }));
  return {
    turn: 1, format: 'gen9randombattle', ourSide: 'p1',
    ours: ourTeam, theirs: theirTeam, field, legalActions: legal,
    teraUsedOurs: false, teraUsedTheirs: false,
  };
}

describe('field fidelity, CTA, and ranges', () => {
  it('sun changes Fire damage versus the same clone without weather', () => {
    const fire = setOf('Arcanine', ['flamethrower'], { ability: 'intimidate', nature: 'Timid' });
    const target = setOf('Blissey', ['splash'], { ability: 'naturalcure', nature: 'Bold' });
    const splash: LegalAction = { id: 'move:splash', type: 'move', moveId: 'splash' };
    const flare: LegalAction = { id: 'move:flamethrower', type: 'move', moveId: 'flamethrower' };
    const clear = simulateRound(duel(fire, target), flare, splash, [1, 2, 3, 4]);
    const sun = simulateRound(duel(fire, target, undefined, { ...emptyField(), weather: 'sunny' }), flare, splash, [1, 2, 3, 4]);
    expect(sun.afterTheirs[0]!.hp).toBeLessThan(clear.afterTheirs[0]!.hp);
  });

  it('Stealth Rock remains after a no-change round and damages a switch-in', () => {
    const lead = setOf('Garchomp', ['splash'], { ability: 'roughskin', nature: 'Jolly' });
    const incoming = setOf('Charizard', ['splash'], { ability: 'blaze', nature: 'Timid' });
    const foe = setOf('Blissey', ['splash'], { ability: 'naturalcure', nature: 'Bold' });
    const ours = ourSlots([lead, incoming]);
    const theirs = theirSlots([foe]);
    const field = emptyField();
    field.hazards_p1.stealthrock = true;
    const obs: BattleObservation = {
      turn: 1, format: 'gen9randombattle', ourSide: 'p1', ours, theirs, field,
      legalActions: [
        { id: 'move:splash', type: 'move', moveId: 'splash' },
        { id: 'switch:2', type: 'switch', slot: 2 },
      ],
      teraUsedOurs: false, teraUsedTheirs: false,
    };
    const splash: LegalAction = { id: 'move:splash', type: 'move', moveId: 'splash' };
    const stay = simulateRound(obs, splash, splash, [1, 2, 3, 4]);
    expect(stay.afterField.hazards_p1.stealthrock).toBe(true);
    const sw = simulateRound(obs, { id: 'switch:2', type: 'switch', slot: 2 }, splash, [1, 2, 3, 4]);
    const char = sw.afterOurs.find((s) => s.speciesId === 'charizard') ?? sw.afterOurs[1];
    expect(char).toBeTruthy();
    expect(char!.hp).toBeLessThan(char!.maxHp);
  });

  it('an 80%-accuracy move has lower CTA than a 100%-accuracy move across seeds', () => {
    const miss = setOf('Blastoise', ['hydropump'], { ability: 'torrent', nature: 'Modest' });
    const hit = setOf('Blastoise', ['surf'], { ability: 'torrent', nature: 'Modest' });
    const wall = setOf('Blissey', ['splash'], { ability: 'naturalcure', nature: 'Bold' });
    const splash: LegalAction = { id: 'move:splash', type: 'move', moveId: 'splash' };
    const n = 20;
    let hits80 = 0;
    let hits100 = 0;
    for (let k = 0; k < n; k++) {
      const seed = [1 + k, 2, 3, 4];
      hits80 += simulateRound(duel(miss, wall), { id: 'move:hydropump', type: 'move', moveId: 'hydropump' }, splash, seed).pHit;
      hits100 += simulateRound(duel(hit, wall), { id: 'move:surf', type: 'move', moveId: 'surf' }, splash, seed).pHit;
    }
    expect(hits100).toBe(n);
    expect(hits80).toBeLessThan(hits100);
  });

  it('a faster guaranteed OHKO scores +1; a slower attacker that faints first has CTA 0', async () => {
    const fast = setOf('Garchomp', ['earthquake'], { ability: 'roughskin', nature: 'Jolly' });
    const carp = setOf('Magikarp', ['splash', 'tackle'], { ability: 'swiftswim', nature: 'Hardy' });
    const splash: LegalAction = { id: 'move:splash', type: 'move', moveId: 'splash' };
    const eq: LegalAction = { id: 'move:earthquake', type: 'move', moveId: 'earthquake' };
    const ohko = await evaluateRound(duel(fast, carp, { ours: 250, theirs: 8 }), { chanceSeeds: 1 });
    const eqChoice = ohko.choices.find((c) => c.action.id === 'move:earthquake');
    expect(eqChoice).toBeTruthy();
    expect(eqChoice!.cta).toBeCloseTo(1);
    expect(eqChoice!.choiceScore).toBeCloseTo(1);
    expect(eqChoice!.scaledChoiceScore).toBeLessThan(eqChoice!.choiceScore);

    const slow = await evaluateRound({
      ...duel(carp, fast, { ours: 8, theirs: 250 }),
      legalActions: [{ id: 'move:tackle', type: 'move', moveId: 'tackle' }],
    }, { chanceSeeds: 1 });
    const tackle = slow.choices.find((c) => c.action.id === 'move:tackle');
    expect(tackle).toBeTruthy();
    expect(tackle!.cta ?? tackle!.success).toBe(0);
  }, 30_000);
});
