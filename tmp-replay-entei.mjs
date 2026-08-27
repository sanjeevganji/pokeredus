import * as fs from 'node:fs';
import { BattleTracker, LiveStateWriter } from './packages/bridge/src/index.ts';
import { loadPool } from './packages/engine/src/index.ts';

const log = fs.readFileSync('packages/cli/tests/fixtures/entei-coalossal.txt', 'utf8');
const pool = loadPool();
const tracker = new BattleTracker({ ourName: 'I AM A BOT BTW' });
const hud = new LiveStateWriter({
  path: 'd:/PokeRedus/tmp-live-replay.json',
  room: 'battle-gen9randombattle-2671287078',
  dryRun: true,
  policy: 'softmax',
});
for (const line of log.split('\n')) {
  const ev = tracker.applyLine(line);
  if (!ev) continue;
  hud.noteEvent(ev);
  hud.fromObservation(tracker.toObservation(pool, []), { settle: ev.type === 'turn' });
}
const obs = tracker.toObservation(pool, []);
console.log(JSON.stringify({
  ourSide: obs.ourSide,
  turn: obs.turn,
  ours: obs.ours.filter((s) => s.revealed).map((s) => ({
    id: s.speciesId, active: s.active, complete: s.setComplete, source: s.setSource,
    moves: s.knownMoves, item: s.set?.item, ability: s.set?.ability,
  })),
  theirs: obs.theirs.filter((s) => s.revealed).map((s) => ({
    id: s.speciesId, active: s.active, complete: s.setComplete, source: s.setSource,
    moves: s.knownMoves, item: s.set?.item,
  })),
  points: hud.state.points,
  events: hud.state.events?.length,
}, null, 2));
