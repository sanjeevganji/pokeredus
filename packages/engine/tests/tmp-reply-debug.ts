import { evaluateRound, type CanonicalSet, type SlotSnapshot } from '../src/index.js';

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
    slot: i, speciesId: sid(set.species), revealed: true, hp: 250, maxHp: 250, status: '',
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
    fainted: false, active, knownMoves: set.moves, set,
    hypotheses: active ? [{ set, count: 1, probability: 1 }] : [], modifiers: [], ...extra,
  };
}

function bench(lead: CanonicalSet): SlotSnapshot[] {
  const team: CanonicalSet[] = [lead];
  while (team.length < 6) {
    team.push({ species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' });
  }
  return team.slice(0, 6).map((set, i) => slot(set, i, i === 0, i === 0 ? undefined : { revealed: set.species !== 'Smeargle' }));
}

const obs = {
  turn: 1, format: 'gen9randombattle', ourSide: 'p1' as const,
  ours: bench(toxapex),
  theirs: [
    slot(garchomp, 0, true),
    ...Array.from({ length: 5 }, (_, i) => slot(
      { species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' },
      i + 1, false, { revealed: false, hypotheses: [] },
    )),
  ],
  field: {
    weather: '', terrain: '', trickroom: false,
    hazards_p1: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    hazards_p2: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    reflect_p1: 0, reflect_p2: 0, lightscreen_p1: 0, lightscreen_p2: 0,
  },
  legalActions: toxapex.moves.map((moveId) => ({ id: `move:${moveId}`, type: 'move' as const, moveId })),
  teraUsedOurs: false, teraUsedTheirs: false,
};

const ev = await evaluateRound(obs, { chanceSeeds: 1 });
console.log('replies', ev.replies.map((r) => ({ id: r.action.id, score: r.choiceScore, p: r.probability, htk: r.hitsToKillUs })));
console.log('choices', ev.choices.map((c) => ({ id: c.action.id, score: c.choiceScore, p: c.probability })));
console.log('pairs', ev.pairs);
