import { evaluateRound, emptyBoosts, emptyField, placeholderSlot, simulateRound } from '../src/index.js';

function setOf(species: string, moves: string[], extra: Record<string, unknown> = {}) {
  return { species, level: 80, item: '', ability: String(extra.ability || 'owntempo'), moves, nature: String(extra.nature || 'Hardy'), ...extra };
}
function ourSlots(team: ReturnType<typeof setOf>[]) {
  const n = team.length;
  const padded = [...team];
  while (padded.length < 6) padded.push({ species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' });
  return padded.slice(0, 6).map((set, i) => ({
    slot: i, speciesId: set.species.toLowerCase().replace(/[^a-z0-9]+/g, ''), revealed: i < n, hp: 250, maxHp: 250, status: '',
    boosts: emptyBoosts(), fainted: false, active: i === 0, knownMoves: set.moves, set, hypotheses: [] as never[], modifiers: [] as never[],
  }));
}
function theirSlots(team: ReturnType<typeof setOf>[]) {
  const lead = team[0]!;
  const active = {
    slot: 0, speciesId: lead.species.toLowerCase().replace(/[^a-z0-9]+/g, ''), revealed: true, hp: 250, maxHp: 250, status: '',
    boosts: emptyBoosts(), fainted: false, active: true, knownMoves: lead.moves, set: lead,
    hypotheses: [{ set: lead, count: 1, probability: 1 }], modifiers: [] as never[],
  };
  return [active, ...Array.from({ length: 5 }, (_, i) => placeholderSlot(i + 1))];
}

const fast = setOf('Garchomp', ['earthquake'], { ability: 'roughskin', nature: 'Jolly' });
const carp = setOf('Magikarp', ['splash', 'tackle'], { ability: 'swiftswim', nature: 'Hardy' });
const ourTeam = ourSlots([fast]); ourTeam[0]!.hp = 250;
const theirTeam = theirSlots([carp]); theirTeam[0]!.hp = 8; theirTeam[0]!.maxHp = 250;
const obs = {
  turn: 1, format: 'gen9randombattle', ourSide: 'p1' as const, ours: ourTeam, theirs: theirTeam, field: emptyField(),
  legalActions: [{ id: 'move:earthquake', type: 'move' as const, moveId: 'earthquake' }], teraUsedOurs: false, teraUsedTheirs: false,
};
const sim = simulateRound(obs, { id: 'move:earthquake', type: 'move', moveId: 'earthquake' }, { id: 'move:splash', type: 'move', moveId: 'splash' }, [1, 2, 3, 4]);
console.log('sim splash', {
  weWin: sim.weWin, theyWin: sim.theyWin, pHit: sim.pHit, pExecute: sim.pExecute, alive: sim.aliveAtExecution,
  theirHp: sim.afterTheirs[0]!.hp, ourHp: sim.afterOurs[0]!.hp,
  ourActive: sim.afterOurs.find((s) => s.active)?.speciesId,
  theirActive: sim.afterTheirs.find((s) => s.active)?.speciesId,
});
const ev = await evaluateRound(obs, { chanceSeeds: 1, policy: 'softmax' });
console.log(JSON.stringify({
  choices: ev.choices.map((c) => ({ id: c.action.id, cta: c.cta, success: c.success, score: c.choiceScore, p: c.probability, util: c.expectedUtility, samples: c.sampleCount })),
  replies: ev.replies.map((r) => ({ id: r.action.id, p: r.probability, avail: r.availability, util: r.expectedUtility, choice: r.choiceScore })),
  round: ev.roundScore, diag: ev.diagnostics, pairs: ev.pairs,
}, null, 2));
