import { describe, it, expect } from 'vitest';
import {
  cloneBattle,
  createBattle,
  emptyBoosts,
  emptyField,
  IllegalSimChoiceError,
  legalFromSlots,
  simulateRound,
  type BattleObservation,
  type CanonicalSet,
  type LegalAction,
  type SlotSnapshot,
} from '../src/index.js';

const SEED = [1, 2, 3, 4];

function setOf(species: string, moves: string[], extra?: Partial<CanonicalSet>): CanonicalSet {
  return { species, level: 80, item: '', ability: 'owntempo', moves, nature: 'Hardy', ...extra };
}

function speciesId(set: CanonicalSet): string {
  return set.species.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slotOf(set: CanonicalSet, i: number, extra?: Partial<SlotSnapshot>): SlotSnapshot {
  return {
    slot: i,
    speciesId: speciesId(set),
    revealed: set.species.toLowerCase() !== 'smeargle',
    hp: 250,
    maxHp: 250,
    status: '',
    boosts: emptyBoosts(),
    fainted: false,
    active: false,
    knownMoves: set.moves,
    set,
    hypotheses: extra?.active ? [{ set, count: 1, probability: 1 }] : [],
    modifiers: [],
    ...extra,
  };
}

function team(sets: CanonicalSet[], activeSlot: number, extras: Array<Partial<SlotSnapshot> | undefined> = []): SlotSnapshot[] {
  const padded = [...sets];
  while (padded.length < 6) {
    padded.push({ species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' });
  }
  return padded.slice(0, 6).map((set, i) => slotOf(set, i, { active: i === activeSlot, ...extras[i] }));
}

function obsOf(ours: SlotSnapshot[], theirs: SlotSnapshot[], field = emptyField(), legal: LegalAction[] = []): BattleObservation {
  return {
    turn: 1,
    format: 'gen9randombattle',
    ourSide: 'p1',
    ours,
    theirs,
    field,
    legalActions: legal,
    teraUsedOurs: ours.some((s) => s.terastallized),
    teraUsedTheirs: theirs.some((s) => s.terastallized),
  };
}

const splash: LegalAction = { id: 'move:splash', type: 'move', moveId: 'splash' };
const foe = setOf('Blissey', ['splash'], { ability: 'naturalcure', nature: 'Bold' });

describe('simulator state reconstruction', () => {
  it('executes a move from a non-zero observed active slot and translates external switches', () => {
    const snorlax = setOf('Snorlax', ['rest'], { ability: 'thickfat', nature: 'Adamant' });
    const toxapex = setOf('Toxapex', ['recover'], { ability: 'regenerator', nature: 'Bold' });
    const clefable = setOf('Clefable', ['moonblast'], { ability: 'unaware', nature: 'Modest' });
    const garchomp = setOf('Garchomp', ['earthquake'], { ability: 'roughskin', nature: 'Jolly' });
    const ours = team([snorlax, toxapex, clefable, garchomp], 3);
    const theirs = team([foe], 0);
    const obs = obsOf(ours, theirs, emptyField(), [
      { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
      { id: 'switch:2', type: 'switch', slot: 2 },
    ]);
    const moved = simulateRound(obs, { id: 'move:earthquake', type: 'move', moveId: 'earthquake' }, splash, SEED);
    expect(moved.ours.executed).toBe(true);
    expect(moved.afterOurs.find((s) => s.active)?.slot).toBe(3);
    expect(moved.afterOurs.find((s) => s.active)?.speciesId).toBe('garchomp');
    expect(moved.afterTheirs[0]!.hp).toBeLessThan(moved.afterTheirs[0]!.maxHp);

    const sw = simulateRound(obs, { id: 'switch:2', type: 'switch', slot: 2 }, splash, SEED);
    expect(sw.afterOurs.find((s) => s.active)?.slot).toBe(1);
    expect(sw.afterOurs.find((s) => s.active)?.speciesId).toBe('toxapex');
  });

  it('clones accuracy and evasion boosts', () => {
    const lead = setOf('Garchomp', ['splash'], { ability: 'roughskin', nature: 'Jolly' });
    const ours = team([lead], 0, [{ boosts: { ...emptyBoosts(), accuracy: 2, evasion: -1 } }]);
    const obs = obsOf(ours, team([foe], 0));
    const battle = createBattle(obs, SEED);
    const cloned = cloneBattle(battle) as { p1: { pokemon: Array<{ boosts: Record<string, number> }> } };
    expect(cloned.p1.pokemon[0]!.boosts.accuracy).toBe(2);
    expect(cloned.p1.pokemon[0]!.boosts.evasion).toBe(-1);
    const after = simulateRound(obs, splash, splash, SEED);
    expect(after.afterOurs.find((s) => s.active)?.boosts.accuracy).toBe(2);
    expect(after.afterOurs.find((s) => s.active)?.boosts.evasion).toBe(-1);
  });

  it('keeps cleared weather and terrain empty instead of restoring the previous snapshot', () => {
    const lead = setOf('Garchomp', ['splash'], { ability: 'roughskin', nature: 'Jolly' });
    const field = { ...emptyField(), weather: 'rain', terrain: 'electric', weatherTurns: 1, terrainTurns: 1 };
    const after = simulateRound(obsOf(team([lead], 0), team([foe], 0), field), splash, splash, SEED);
    expect(after.afterField.weather).toBe('');
    expect(after.afterField.terrain).toBe('');
  });

  it('drops 0-PP and disabled moves and decrements PP across a round', () => {
    const garchomp = setOf('Garchomp', ['earthquake', 'swordsdance', 'scaleshot'], {
      ability: 'roughskin', nature: 'Jolly',
    });
    const ours = team([garchomp], 0, [{
      moveSlots: [
        { id: 'earthquake', pp: 0, maxpp: 16 },
        { id: 'swordsdance', pp: 10, maxpp: 16, disabled: true },
        { id: 'scaleshot', pp: 5, maxpp: 16 },
      ],
    }]);
    expect(legalFromSlots(ours).filter((a) => a.type === 'move').map((a) => a.moveId)).toEqual(['scaleshot']);
    const after = simulateRound(
      obsOf(ours, team([foe], 0)),
      { id: 'move:scaleshot', type: 'move', moveId: 'scaleshot' },
      splash,
      SEED,
    );
    const shot = after.afterOurs[0]!.moveSlots?.find((m) => m.id === 'scaleshot');
    expect(shot?.pp).toBe(4);
  });

  it('does not refill a consumed item from the assumed set', () => {
    const carp = setOf('Magikarp', ['splash'], { ability: 'swiftswim', item: 'leftovers', nature: 'Hardy' });
    const consumed = team([carp], 0, [{ item: '', hp: 100, maxHp: 200 }]);
    const holding = team([carp], 0, [{ item: 'leftovers', hp: 100, maxHp: 200 }]);
    const afterEmpty = simulateRound(obsOf(consumed, team([foe], 0)), splash, splash, SEED);
    const afterHeld = simulateRound(obsOf(holding, team([foe], 0)), splash, splash, SEED);
    expect(afterEmpty.afterOurs.find((s) => s.active)?.item).toBe('');
    expect(afterEmpty.afterOurs.find((s) => s.active)!.hp).toBeLessThan(afterHeld.afterOurs.find((s) => s.active)!.hp);
  });

  it('restores already-terastallized defensive typing and one-use legality', () => {
    const zard = setOf('Charizard', ['splash'], { ability: 'blaze', teraType: 'Fire', nature: 'Timid' });
    const chomp = setOf('Garchomp', ['earthquake'], { ability: 'roughskin', nature: 'Jolly' });
    const eq: LegalAction = { id: 'move:earthquake', type: 'move', moveId: 'earthquake' };
    const teraOurs = team([zard], 0, [{ terastallized: true, teraType: 'Fire' }]);
    const rawOurs = team([zard], 0, [{ terastallized: false, teraType: 'Fire' }]);
    const theirs = team([chomp], 0);
    const teraHit = simulateRound(obsOf(teraOurs, theirs), splash, eq, SEED);
    const immune = simulateRound(obsOf(rawOurs, theirs), splash, eq, SEED);
    expect(teraHit.afterOurs[0]!.hp).toBeLessThan(teraHit.afterOurs[0]!.maxHp);
    expect(immune.afterOurs[0]!.hp).toBe(immune.afterOurs[0]!.maxHp);
    expect(legalFromSlots(teraOurs, false).some((a) => a.tera)).toBe(false);
  });

  it('throws on an invalid Showdown choice with both action ids', () => {
    const lead = setOf('Garchomp', ['earthquake'], { ability: 'roughskin', nature: 'Jolly' });
    const obs = obsOf(team([lead], 0), team([foe], 0));
    expect(() => simulateRound(obs, { id: 'move:notarealmove', type: 'move', moveId: 'notarealmove' }, splash, SEED))
      .toThrow(IllegalSimChoiceError);
    try {
      simulateRound(obs, { id: 'move:notarealmove', type: 'move', moveId: 'notarealmove' }, splash, SEED);
    } catch (err) {
      expect(String(err)).toMatch(/move:notarealmove/);
      expect(String(err)).toMatch(/move:splash/);
    }
  });
});
