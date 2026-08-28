import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { BattleTracker, resolveSetId } from '@pokeredus/bridge';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';
import { PackIndex } from '@pokeredus/pack';
import { loadPool, type CanonicalSet, type RandomSetPool } from '@pokeredus/engine';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = new PackIndex(KnowledgePackSchema.parse(JSON.parse(raw)) as never);
const transcript = readFileSync(new URL('./fixtures/transcript.txt', import.meta.url), 'utf-8');
const dir = dirname(fileURLToPath(import.meta.url));
const pool = loadPool(join(dir, '../../engine/data/gen9randombattle.json'));

describe('BattleTracker — transcript → observation', () => {
  it('folds the transcript into an observation with legal actions', () => {
    const tracker = new BattleTracker();
    for (const line of transcript.split('\n')) tracker.applyLine(line);
    const obs = tracker.toObservation(pool, []);
    expect(obs.turn).toBe(1);
    expect(obs.ours.some((s) => s.speciesId.includes('venusaur') || s.hp > 0)).toBe(true);
    expect(obs.field.weather).toBe('sunny');
  });

  it('keeps the full request team instead of collapsing onto p1a', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p1a: Garchomp|Garchomp, L80, M|100/100');
    tracker.applyLine('|switch|p2a: Toxapex|Toxapex, L80, F|100/100');
    tracker.apply({
      type: 'request',
      json: {
        side: {
          id: 'p1',
          name: 'me',
          pokemon: [
            { ident: 'p1: Garchomp', details: 'Garchomp, L80', condition: '100/100', active: true, moves: [], baseAbility: '', item: '' },
            { ident: 'p1: Venusaur', details: 'Venusaur, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
            { ident: 'p1: Clefable', details: 'Clefable, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
            { ident: 'p1: Dragapult', details: 'Dragapult, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
            { ident: 'p1: Kingambit', details: 'Kingambit, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
            { ident: 'p1: Slowking-Galar', details: 'Slowking-Galar, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
          ],
        },
        active: [{ moves: [{ move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false }] }],
      },
    });
    const obs = tracker.toObservation(pool, []);
    const ours = obs.ours.filter((s) => s.revealed && s.speciesId !== 'smeargle');
    expect(ours.map((s) => s.speciesId)).toEqual([
      'garchomp', 'venusaur', 'clefable', 'dragapult', 'kingambit', 'slowkinggalar',
    ]);
    expect(ours.find((s) => s.active)?.speciesId).toBe('garchomp');
  });

  it('resolveSetId maps Showdown species ids onto pack sets', () => {
    expect(resolveSetId('venusaur', pack)).toBe('venusaur_sun-sweeper');
    expect(resolveSetId('clefable', pack)).toBe('clefable_showdown-usage');
    expect(resolveSetId('arcaninehisui', pack)).toBe('arcanine-hisui_showdown-usage');
    expect(resolveSetId('missingmon', pack)).toBeUndefined();
  });

  it('parses screens from sidestart and Trick Room from fieldstart', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p1a: Alakazam|Alakazam, L80, M|100/100');
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L80, M|100/100');
    tracker.applyLine('|-sidestart|p1: Player|move: Reflect');
    tracker.applyLine('|-sidestart|p1: Player|move: Light Screen');
    tracker.applyLine('|-fieldstart|move: Trick Room|[of] p1a: Alakazam');
    const obs = tracker.toObservation(pool, []);
    expect(obs.field.reflect_p1).toBe(5);
    expect(obs.field.lightscreen_p1).toBe(5);
    expect(obs.field.trickroom).toBe(true);
    tracker.applyLine('|-fieldend|move: Trick Room');
    tracker.applyLine('|-sideend|p1: Player|Reflect');
    const after = tracker.toObservation(pool, []);
    expect(after.field.trickroom).toBe(false);
    expect(after.field.reflect_p1).toBe(0);
  });

  it('retains cumulative opponent moves and revealed item/ability/tera facts', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L78, M|100/100');
    tracker.applyLine('|move|p2a: Garchomp|Earthquake|p1a: Toxapex');
    tracker.applyLine('|move|p2a: Garchomp|Outrage|p1a: Toxapex');
    tracker.applyLine('|-item|p2a: Garchomp|Loaded Dice');
    tracker.applyLine('|-ability|p2a: Garchomp|Rough Skin');
    tracker.applyLine('|-terastallize|p2a: Garchomp|Ground');
    const obs = tracker.toObservation(pool, []);
    const foe = obs.theirs.find((s) => s.speciesId === 'garchomp');
    expect(foe?.knownMoves).toEqual(expect.arrayContaining(['earthquake', 'outrage']));
    expect(foe?.item).toBe('loadeddice');
    expect(foe?.ability).toBe('roughskin');
    expect(foe?.teraType).toBe('Ground');
    expect(obs.teraUsedTheirs).toBe(true);
    expect(obs.teraUsedOurs).toBe(false);
  });

  it('tracks our Tera used separately from theirs', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p1a: Garchomp|Garchomp, L80, M|100/100');
    tracker.applyLine('|-terastallize|p1a: Garchomp|Dragon');
    const obs = tracker.toObservation(pool, []);
    expect(obs.teraUsedOurs).toBe(true);
    expect(obs.teraUsedTheirs).toBe(false);
    expect(obs.ours.find((s) => s.speciesId === 'garchomp')?.terastallized).toBe(true);
  });
});

describe('BattleTracker — reconstructed live facts', () => {
  it('emits moveSlots, trapped, and request PP/disabled for our active', () => {
    const tracker = new BattleTracker();
    tracker.apply({
      type: 'request',
      json: {
        side: {
          id: 'p1', name: 'me',
          pokemon: [
            { ident: 'p1: Garchomp', details: 'Garchomp, L80', condition: '100/100', active: true, moves: [], baseAbility: 'Rough Skin', item: 'Leftovers' },
            { ident: 'p1: Toxapex', details: 'Toxapex, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
          ],
        },
        active: [{
          trapped: true,
          moves: [
            { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false },
            { move: 'Outrage', id: 'outrage', pp: 0, maxpp: 16, disabled: false },
            { move: 'Swords Dance', id: 'swordsdance', pp: 8, maxpp: 16, disabled: true },
          ],
        }],
      },
    });
    const obs = tracker.toObservation(miniPool, []);
    const us = obs.ours.find((s) => s.active);
    expect(us?.trapped).toBe(true);
    expect(us?.moveSlots).toEqual(expect.arrayContaining([
      { id: 'earthquake', pp: 10, maxpp: 16, disabled: false },
      { id: 'outrage', pp: 0, maxpp: 16, disabled: false },
      { id: 'swordsdance', pp: 8, maxpp: 16, disabled: true },
    ]));
  });

  it('clears a consumed item while keeping the revealed fact for beliefs', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L78, M|100/100');
    tracker.applyLine('|-item|p2a: Garchomp|Loaded Dice');
    tracker.applyLine('|-enditem|p2a: Garchomp|Loaded Dice|[from] item: Loaded Dice');
    const obs = tracker.toObservation(miniPool, []);
    const foe = obs.theirs.find((s) => s.speciesId === 'garchomp');
    expect(foe?.item).toBe('');
    expect(foe?.set?.item.toLowerCase().replace(/[^a-z0-9]/g, '')).toBe('loadeddice');
  });

  it('clears choice lock on switch-out and when a later request lists multiple enabled moves', () => {
    const tracker = new BattleTracker();
    tracker.apply({
      type: 'request',
      json: {
        side: {
          id: 'p1', name: 'me',
          pokemon: [
            { ident: 'p1: Garchomp', details: 'Garchomp, L80', condition: '100/100', active: true, moves: [], baseAbility: '', item: 'Choice Scarf' },
            { ident: 'p1: Toxapex', details: 'Toxapex, L80', condition: '100/100', active: false, moves: [], baseAbility: '', item: '' },
          ],
        },
        active: [{
          moves: [
            { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false },
            { move: 'Outrage', id: 'outrage', pp: 8, maxpp: 16, disabled: true },
            { move: 'Stone Edge', id: 'stoneedge', pp: 8, maxpp: 16, disabled: true },
          ],
        }],
      },
    });
    expect(tracker.toObservation(miniPool, []).ours.find((s) => s.active)?.choiceLock).toBe('earthquake');
    tracker.applyLine('|switch|p1a: Toxapex|Toxapex, L80|100/100');
    expect(tracker.toObservation(miniPool, []).ours.find((s) => s.active)?.choiceLock).toBeUndefined();
  });

  it('decrements screen durations once per new turn and clears them on sideend', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p1a: Alakazam|Alakazam, L80, M|100/100');
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L80, M|100/100');
    tracker.applyLine('|-sidestart|p1: Player|move: Reflect');
    tracker.applyLine('|turn|1');
    expect(tracker.toObservation(pool, []).field.reflect_p1).toBe(5);
    tracker.applyLine('|turn|2');
    expect(tracker.toObservation(pool, []).field.reflect_p1).toBe(4);
    tracker.applyLine('|-sideend|p1: Player|Reflect');
    expect(tracker.toObservation(pool, []).field.reflect_p1).toBe(0);
  });
});

const dice: CanonicalSet = {
  species: 'Garchomp',
  level: 78,
  item: 'loadeddice',
  ability: 'roughskin',
  moves: ['earthquake', 'swordsdance', 'scaleshot', 'firefang'],
  nature: 'Jolly',
};
const scarf: CanonicalSet = {
  species: 'Garchomp',
  level: 78,
  item: 'choicescarf',
  ability: 'roughskin',
  moves: ['earthquake', 'outrage', 'stoneedge', 'firefang'],
  nature: 'Jolly',
};
const miniPool: RandomSetPool = {
  format: 'gen9randombattle',
  version: 1,
  samples: 10,
  seed: 1,
  species: {
    garchomp: [
      { set: dice, count: 7 },
      { set: scarf, count: 3 },
    ],
  },
};

describe('BattleTracker — assumed set overrides', () => {
  it('lets a compatible manual override win over the public top candidate', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L78, M|100/100');
    tracker.applyLine('|move|p2a: Garchomp|Earthquake|p1a: Toxapex');
    const obs = tracker.toObservation(miniPool, [], {
      version: 1,
      overrides: { gen9randombattle: { garchomp: scarf } },
    });
    const foe = obs.theirs.find((s) => s.speciesId === 'garchomp');
    expect(foe?.set?.item).toBe('choicescarf');
    expect(foe?.setSource).toBe('manual');
    expect(foe?.setComplete).toBe(true);
    expect(foe?.hypotheses[0]?.set.item).toBe('loadeddice');
  });

  it('rejects a conflicting override for that observation and keeps the public candidate', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L78, M|100/100');
    tracker.applyLine('|move|p2a: Garchomp|Swords Dance|p2a: Garchomp');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const obs = tracker.toObservation(miniPool, [], {
      version: 1,
      overrides: { gen9randombattle: { garchomp: scarf } },
    });
    const foe = obs.theirs.find((s) => s.speciesId === 'garchomp');
    expect(foe?.set?.item).toBe('loadeddice');
    expect(foe?.setSource).toBe('public');
    expect(foe?.setWarning).toMatch(/conflicts with revealed facts/);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('keeps the public top candidate when no override is stored', () => {
    const tracker = new BattleTracker();
    tracker.applyLine('|switch|p2a: Garchomp|Garchomp, L78, M|100/100');
    const obs = tracker.toObservation(miniPool, []);
    const foe = obs.theirs.find((s) => s.speciesId === 'garchomp');
    expect(foe?.set?.item).toBe('loadeddice');
    expect(foe?.setSource).toBe('public');
    expect(foe?.candidateProbability).toBeCloseTo(0.7);
  });

  it('uses a public randbats set instead of Smeargle when request moves are empty', () => {
    const tracker = new BattleTracker();
    tracker.apply({
      type: 'request',
      json: {
        side: {
          id: 'p1',
          name: 'me',
          pokemon: [
            { ident: 'p1: Garchomp', details: 'Garchomp, L80', condition: '100/100', active: true, moves: [], baseAbility: 'Rough Skin', item: 'Leftovers' },
          ],
        },
        active: [{ moves: [{ move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false }] }],
      },
    });
    const obs = tracker.toObservation(miniPool, []);
    const us = obs.ours.find((s) => s.speciesId === 'garchomp');
    expect(us?.speciesId).toBe('garchomp');
    expect(us?.set?.species).not.toBe('smeargle');
    expect(us?.setComplete).toBe(true);
    expect(us?.knownMoves).toEqual(expect.arrayContaining(['earthquake']));
    expect(obs.ours.filter((s) => !s.revealed).every((s) => s.setComplete === false)).toBe(true);
  });

  it('treats request.moves as string ids so our full team is complete', () => {
    const tracker = new BattleTracker();
    tracker.apply({
      type: 'request',
      json: {
        side: {
          id: 'p1',
          name: 'me',
          pokemon: [{
            ident: 'p1: Garchomp', details: 'Garchomp, L78, M', condition: '200/200', active: true,
            moves: ['earthquake', 'swordsdance', 'scaleshot', 'firefang'],
            baseAbility: 'Rough Skin', item: 'Loaded Dice',
          }],
        },
        active: [{ moves: [{ move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 16, disabled: false }] }],
      },
    });
    const obs = tracker.toObservation(miniPool, []);
    const us = obs.ours.find((s) => s.speciesId === 'garchomp');
    expect(us?.knownMoves).toEqual(expect.arrayContaining(['earthquake', 'swordsdance', 'scaleshot', 'firefang']));
    expect(us?.setComplete).toBe(true);
    expect(us?.setSource).toBe('revealed');
    expect(us?.set?.item.toLowerCase().replace(/[^a-z0-9]/g, '')).toBe('loadeddice');
  });
});

describe('BattleTracker — live gen9randombattle-2671287078 log', () => {
  it('puts Entei on our side vs Coalossal at turn 2 when we are p2', () => {
    const tracker = new BattleTracker({ ourName: 'I AM A BOT BTW' });
    const log = readFileSync(new URL('./fixtures/entei-coalossal.txt', import.meta.url), 'utf-8');
    for (const line of log.split('\n')) tracker.applyLine(line);
    const obs = tracker.toObservation(pool, []);
    expect(obs.ourSide).toBe('p2');
    expect(obs.turn).toBe(2);
    expect(obs.ours.find((s) => s.active)?.speciesId).toBe('entei');
    expect(obs.theirs.find((s) => s.active)?.speciesId).toBe('coalossal');
    expect(obs.ours.find((s) => s.speciesId === 'entei')?.setComplete).toBe(true);
    expect(obs.theirs.find((s) => s.speciesId === 'coalossal')?.setComplete).toBe(true);
    expect(obs.ours.find((s) => s.speciesId === 'entei')?.knownMoves).toContain('flareblitz');
    expect(obs.theirs.find((s) => s.speciesId === 'ironvaliant')?.revealed).toBe(true);
  });

  it('enumerates assumed-set moves with no |request|', () => {
    const tracker = new BattleTracker({ ourName: 'alice' });
    tracker.applyLine('|player|p1|alice|');
    tracker.applyLine('|player|p2|bob|');
    tracker.applyLine('|switch|p1a: Garchomp|Garchomp, L78|100/100');
    tracker.applyLine('|switch|p2a: Toxapex|Toxapex, L88|100/100');
    const obs = tracker.toObservation(pool, []);
    expect(obs.request).toBeUndefined();
    expect(obs.legalActions.some((a) => a.type === 'move')).toBe(true);
    expect(obs.ours.find((s) => s.active)?.set?.moves.length).toBeGreaterThan(0);
    expect(tracker.spectatorNote()).toBeUndefined();
  });

  it('warns when the logged-in name is not a player', () => {
    const tracker = new BattleTracker({ ourName: 'I AM BOT BTW' });
    tracker.applyLine('|player|p1|wtfamidoinginlife|');
    tracker.applyLine('|player|p2|I AM A BOT BTW|');
    expect(tracker.spectatorNote()).toMatch(/No private team/);
  });
});

