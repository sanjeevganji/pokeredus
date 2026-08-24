import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  BattleTracker,
  LiveStateWriter,
  summarizeEvent,
  slotsFromObservation,
  type BattleEvent,
} from '@pokeredus/bridge';
import { emptyBoosts, emptyField, type BattleObservation } from '@pokeredus/engine';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmpPath(): string {
  const p = path.join(os.tmpdir(), `pokelink-live-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

function obs(): BattleObservation {
  return {
    turn: 3,
    format: 'gen9randombattle',
    ourSide: 'p1',
    ours: [{
      slot: 0, speciesId: 'garchomp', revealed: true, hp: 200, maxHp: 250, status: '',
      boosts: emptyBoosts(), fainted: false, active: true, knownMoves: ['earthquake'],
      hypotheses: [], modifiers: [],
    }],
    theirs: [{
      slot: 0, speciesId: 'toxapex', revealed: true, hp: 80, maxHp: 250, status: 'tox',
      boosts: emptyBoosts(), fainted: false, active: true, knownMoves: ['recover'],
      hypotheses: [], modifiers: [],
    }],
    field: { ...emptyField(), weather: 'rain' },
    legalActions: [{ id: 'move:earthquake', type: 'move', moveId: 'earthquake' }],
    teraUsed: false,
  };
}

describe('summarizeEvent', () => {
  it('formats turn, move, faint, and win; skips request', () => {
    expect(summarizeEvent({ type: 'turn', num: 4 })).toBe('Turn 4');
    expect(summarizeEvent({
      type: 'move', side: 'p1', slot: 'p1a', identity: 'p1a: Garchomp', moveId: 'earthquake',
    })).toBe('Garchomp used earthquake');
    expect(summarizeEvent({ type: 'faint', side: 'p2', slot: 'p2a', identity: 'p2a: Toxapex' }))
      .toBe('Toxapex fainted');
    expect(summarizeEvent({ type: 'win', winner: 'alice' })).toBe('alice wins');
    expect(summarizeEvent({ type: 'request', json: { side: { id: 'p1', name: 'x', pokemon: [] } } })).toBeNull();
  });
});

describe('LiveStateWriter', () => {
  it('writes eval scores and tracker HP into the snapshot file', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-1', dryRun: true, policy: 'quantum' });
    const tracker = new BattleTracker();
    const switchEv: BattleEvent = {
      type: 'switch', side: 'p1', slot: 'p1a', identity: 'p1a: Garchomp',
      speciesId: 'garchomp', details: 'Garchomp, L80', hp: 200, maxHp: 250, status: '',
    };
    tracker.apply(switchEv);
    hud.noteEvent(switchEv);
    hud.fromTracker(tracker);
    hud.fromObservation(obs());
    hud.fromDecision({
      evaluation: {
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 0.9, expectedImpact: 1.2, expectedHealthDelta: 1.0, expectedModifierDelta: 0.2,
          ourHealth: 0, theirHealth: -1, ourModifier: 0.2, theirModifier: 0,
          hitsToKill: 2, choiceScore: 1.1, scaledChoiceScore: 0.7, meanPostScore: 0.2,
          features: { health: 1, modifier: 0.2, secondary: 0, switchRisk: 0, sacrifice: 0 },
        }],
        replies: [{
          action: { id: 'move:recover', type: 'move', moveId: 'recover' },
          expectedImpact: -0.3, hitsToKillUs: null, choiceScore: 0.3,
        }],
        roundScore: 0.42,
        forcedOutcome: 'none',
        mateProbability: 0,
      },
      probabilities: [1],
      sampledId: 'move:earthquake',
      sent: false,
      diagnostics: { mode: 'quantum', n_qubits: 1, exact: true },
    });
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(snap.room).toBe('battle-gen9randombattle-1');
    expect(snap.turn).toBe(3);
    expect(snap.field.weather).toBe('rain');
    expect(snap.field.ours.hazards.stealthrock).toBe(false);
    expect(snap.eval.roundScore).toBe(0.42);
    expect(snap.eval.sampledAction).toBe('move:earthquake');
    expect(snap.eval.choices[0].choiceScore).toBe(1.1);
    expect(snap.eval.choices[0].hitsToKill).toBe(2);
    expect(snap.eval.choices[0].ourHealth).toBe(0);
    expect(snap.eval.replies[0].id).toBe('move:recover');
    expect(snap.eval.replies[0].choiceScore).toBe(0.3);
    expect(snap.eval.quantum.mode).toBe('quantum');
    expect(snap.eval.quantum.nQubits).toBe(1);
    expect(snap.turns).toHaveLength(1);
    expect(snap.turns[0].roundScore).toBe(0.42);
    expect(snap.ours).toHaveLength(6);
    expect(snap.theirs).toHaveLength(6);
    expect(snap.ours[0].speciesId).toBe('garchomp');
    expect(snap.theirs[0].hp).toBe(80);
    expect(snap.events.some((e: { text: string }) => e.text.includes('Garchomp in'))).toBe(true);
    expect(snap.events.some((e: { text: string }) => e.text.includes('roundScore=0.420'))).toBe(true);
    const obsFile = path.join(path.dirname(file), 'live-observation.json');
    tmpFiles.push(obsFile);
    hud.fromObservation(obs());
    expect(JSON.parse(fs.readFileSync(obsFile, 'utf8')).turn).toBe(3);
  });
});

describe('slotsFromObservation', () => {
  it('keeps six slots including unrevealed', () => {
    const o = obs();
    o.theirs.push({
      slot: 1, speciesId: 'smeargle', revealed: false, hp: 100, maxHp: 100, status: '',
      boosts: emptyBoosts(), fainted: false, active: false, knownMoves: [],
      hypotheses: [], modifiers: [],
    });
    const slots = slotsFromObservation(o, 'theirs');
    expect(slots).toHaveLength(6);
    expect(slots[1]!.revealed).toBe(false);
  });
});
