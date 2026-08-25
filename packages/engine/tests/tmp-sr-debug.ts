import { emptyBoosts, emptyField, placeholderSlot, simulateRound, type CanonicalSet, type SlotSnapshot } from '../src/index.js';

function sid(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function asSlot(set: CanonicalSet, i: number, active: boolean): SlotSnapshot {
  return {
    slot: i, speciesId: sid(set.species), revealed: true, hp: 250, maxHp: 250, status: '',
    boosts: emptyBoosts(), fainted: false, active, knownMoves: set.moves, set,
    hypotheses: active ? [{ set, count: 1, probability: 1 }] : [], modifiers: [],
  };
}
const lead: CanonicalSet = { species: 'Garchomp', level: 80, item: '', ability: 'roughskin', moves: ['splash'], nature: 'Jolly' };
const incoming: CanonicalSet = { species: 'Charizard', level: 80, item: '', ability: 'blaze', moves: ['splash'], nature: 'Timid' };
const foe: CanonicalSet = { species: 'Blissey', level: 80, item: '', ability: 'naturalcure', moves: ['splash'], nature: 'Bold' };
const ours = [lead, incoming].map((s, i) => asSlot(s, i, i === 0));
while (ours.length < 6) {
  ours.push({
    ...placeholderSlot(ours.length),
    set: { species: 'Smeargle', level: 100, item: '', ability: 'owntempo', moves: ['splash'], nature: 'Hardy' },
    speciesId: 'smeargle',
    revealed: true,
  });
}
const theirs = [asSlot(foe, 0, true), ...Array.from({ length: 5 }, (_, i) => placeholderSlot(i + 1))];
const field = emptyField();
field.hazards_p1.stealthrock = true;
const obs = {
  turn: 1, format: 'gen9randombattle', ourSide: 'p1' as const, ours, theirs, field,
  legalActions: [{ id: 'switch:2', type: 'switch' as const, slot: 2 }],
  teraUsedOurs: false, teraUsedTheirs: false,
};
const splash = { id: 'move:splash', type: 'move' as const, moveId: 'splash' };
const sw = simulateRound(obs, { id: 'switch:2', type: 'switch', slot: 2 }, splash, [1, 2, 3, 4]);
console.log(JSON.stringify({
  hazards: sw.afterField.hazards_p1,
  after: sw.afterOurs.map((s) => ({ id: s.speciesId, hp: s.hp, max: s.maxHp, active: s.active })),
  oursTel: sw.ours,
}, null, 2));
