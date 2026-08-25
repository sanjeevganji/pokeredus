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
const pool = loadPool(join(dir, '../../engine/data/gen9randombattle-pool.v1.json'));

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
  });
});
