import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  BattleTracker,
  LiveStateWriter,
  MAX_LIVE_POINTS,
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
    teraUsedOurs: false,
    teraUsedTheirs: false,
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
  it('writes eval scores, schemaVersion 2, and points into the snapshot file', () => {
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
          minTurnScore: 0.8, maxTurnScore: 1.4, minPostScore: 0.2, maxPostScore: 0.2, sampleCount: 4,
          features: { health: 1, modifier: 0.2, secondary: 0, switchRisk: 0, sacrifice: 0 },
        }],
        replies: [{
          action: { id: 'move:recover', type: 'move', moveId: 'recover' },
          expectedImpact: -0.3, hitsToKillUs: null, choiceScore: 0.3,
        }],
        roundScore: 0.42, expectedRoundScore: 0.42, minRoundScore: 0.42, maxRoundScore: 0.42,
        forcedOutcome: 'none',
        mateProbability: 0,
      },
      probabilities: [1],
      sampledId: 'move:earthquake',
      sent: false,
      diagnostics: { mode: 'quantum', n_qubits: 1, exact: true },
    });

    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(snap.schemaVersion).toBe(2);
    expect(snap.room).toBe('battle-gen9randombattle-1');
    expect(snap.turn).toBe(3);
    expect(snap.field.weather).toBe('rain');
    expect(snap.field.ours.hazards.stealthrock).toBe(false);
    expect(snap.eval.roundScore).toBe(0.42);
    expect(snap.eval.sampledAction).toBe('move:earthquake');
    expect(snap.eval.choices[0].choiceScore).toBe(1.1);
    expect(snap.eval.choices[0].policyWeight).toBe(1);
    expect(snap.eval.choices[0].minTurnScore).toBe(0.8);
    expect(snap.eval.choices[0].maxTurnScore).toBe(1.4);
    expect(snap.eval.choices[0].sampleCount).toBe(4);
    expect(snap.eval.choices[0].hitsToKill).toBe(2);
    expect(snap.eval.choices[0].ourHealth).toBe(0);
    expect(snap.eval.replies[0].id).toBe('move:recover');
    expect(snap.eval.replies[0].choiceScore).toBe(0.3);
    expect(snap.eval.quantum.mode).toBe('quantum');
    expect(snap.eval.quantum.nQubits).toBe(1);
    expect(snap.points).toHaveLength(2);
    expect(snap.points[0].actionId).toBe('start');
    expect(snap.points[0].status).toBe('settled');
    expect(snap.points[1].status).toBe('forecast');
    expect(snap.points[1].expectedDelta).toBe(1.1);
    expect(snap.points[1].minDelta).toBe(0.8);
    expect(snap.points[1].maxDelta).toBe(1.4);
    expect(snap.points[1].samples).toBe(4);
    expect(snap.turns).toHaveLength(2);
    expect(snap.turns[1].roundScore).toBe(1.1);
    expect(snap.ours).toHaveLength(6);
    expect(snap.theirs).toHaveLength(6);
    expect(snap.ours[0].speciesId).toBe('garchomp');
    expect(snap.theirs[0].hp).toBe(80);
    expect(snap.events.some((e: { text: string }) => e.text.includes('Garchomp in'))).toBe(true);
    expect(snap.events.some((e: { text: string }) => e.text.includes('roundScore=0.420'))).toBe(true);
  });

  it('writes player names from the tracker into the HUD', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-9', dryRun: true, policy: 'softmax' });
    const tracker = new BattleTracker({ ourName: 'alice' });
    tracker.applyLine('|player|p1|alice|');
    tracker.applyLine('|player|p2|bob|');
    hud.fromTracker(tracker);
    hud.fromObservation(obs(), { oursName: 'alice', theirsName: 'bob', teraUsedOurs: false, teraUsedTheirs: false });
    expect(hud.state.oursName).toBe('alice');
    expect(hud.state.theirsName).toBe('bob');
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(snap.oursName).toBe('alice');
    expect(snap.theirsName).toBe('bob');
  });

  it('settles prior forecast point when next observation arrives', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-2', dryRun: true, policy: 'softmax' });
    const o1 = obs();
    hud.fromObservation(o1);

    hud.fromDecision({
      evaluation: {
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 0.8, scaledChoiceScore: 0.8, meanPostScore: 0.5,
          minTurnScore: 0.5, maxTurnScore: 1.0, minPostScore: 0.5, maxPostScore: 0.5, sampleCount: 2,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
        }],
        replies: [],
        roundScore: 0.8, expectedRoundScore: 0.8, minRoundScore: 0.5, maxRoundScore: 1.0,
        forcedOutcome: 'none',
        mateProbability: 0,
      },
      probabilities: [1],
      sampledId: 'move:earthquake',
      sent: true,
    });

    expect(hud.state.points![0]!.actionId).toBe('start');
    expect(hud.state.points![0]!.status).toBe('settled');
    expect(hud.state.points![1]!.status).toBe('forecast');

    // Next turn observation: opponent toxapex fainted (hp = 0)
    const o2 = obs();
    o2.turn = 4;
    o2.theirs[0]!.hp = 0;
    o2.theirs[0]!.fainted = true;
    hud.fromObservation(o2);

    expect(hud.state.points![1]!.status).toBe('settled');
    expect(hud.state.points![1]!.realizedDelta).toBeGreaterThan(0);
    expect(hud.state.points![1]!.cumulativeTotal).toBe(
      (hud.state.points![0]!.cumulativeTotal) + hud.state.points![1]!.realizedDelta!,
    );
  });

  it('marks the prior forecast unresolved when no previous observation exists', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-5', dryRun: true, policy: 'softmax' });
    hud.fromDecision({
      evaluation: {
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 0.8, scaledChoiceScore: 0.8, meanPostScore: 0.5,
          minTurnScore: 0.5, maxTurnScore: 1.0, minPostScore: 0.5, maxPostScore: 0.5, sampleCount: 2,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
        }],
        replies: [],
        roundScore: 0.8, expectedRoundScore: 0.8, minRoundScore: 0.5, maxRoundScore: 1.0,
        forcedOutcome: 'none',
        mateProbability: 0,
      },
      probabilities: [1],
      sampledId: 'move:earthquake',
      sent: false,
    });
    expect(hud.state.points![0]!.status).toBe('forecast');
    expect(hud.state.points![0]!.realizedDelta).toBeUndefined();

    hud.fromObservation(obs());
    expect(hud.state.points![0]!.status).toBe('unresolved');
    expect(hud.state.points![0]!.realizedDelta).toBeUndefined();
    expect(hud.state.points![0]!.cumulativeTotal).not.toBe(
      hud.state.points![0]!.expectedTotal,
    );
  });

  it('records a start point and a sync point when turns advance without a decision', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-4', dryRun: true, policy: 'softmax' });
    const o1 = obs();
    o1.turn = 1;
    hud.fromObservation(o1, { settle: true });
    expect(hud.state.points).toHaveLength(1);
    expect(hud.state.points![0]!.actionId).toBe('start');

    const o2 = obs();
    o2.turn = 2;
    o2.theirs[0]!.hp = 40;
    hud.fromObservation(o2, { settle: true });
    expect(hud.state.points).toHaveLength(2);
    expect(hud.state.points![1]!.actionId).toBe('sync');
    expect(hud.state.points![1]!.turn).toBe(2);
    expect(hud.state.points![1]!.status).toBe('settled');
  });

  it('caps points at MAX_LIVE_POINTS (64)', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-3', dryRun: true, policy: 'softmax' });
    const o = obs();
    hud.fromObservation(o);

    for (let i = 0; i < 70; i++) {
      hud.fromDecision({
        evaluation: {
          choices: [{
            action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
            success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
            ourHealth: 0, theirHealth: 0, ourModifier: 0, theirModifier: 0,
            hitsToKill: null, choiceScore: 0.1, scaledChoiceScore: 0.1, meanPostScore: 0.1,
            minTurnScore: 0.1, maxTurnScore: 0.1, minPostScore: 0.1, maxPostScore: 0.1, sampleCount: 1,
            features: { health: 0, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
          }],
          replies: [],
          roundScore: 0.1, expectedRoundScore: 0.1, minRoundScore: 0.1, maxRoundScore: 0.1,
          forcedOutcome: 'none',
          mateProbability: 0,
        },
        probabilities: [1],
        sampledId: 'move:earthquake',
        sent: true,
      });
    }

    expect(hud.state.points!.length).toBe(MAX_LIVE_POINTS);
    expect(hud.state.points!.length).toBe(64);
  });

  it('patchForecast writes outcome counts and ignores a stale turn', () => {
    const file = tmpPath();
    const hud = new LiveStateWriter({ path: file, room: 'battle-gen9randombattle-7', dryRun: true, policy: 'quantum' });
    hud.fromObservation(obs());
    hud.fromDecision({
      evaluation: {
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 0.8, scaledChoiceScore: 0.8, meanPostScore: 0.5,
          minTurnScore: 0.5, maxTurnScore: 1.0, minPostScore: 0.5, maxPostScore: 0.5, sampleCount: 2,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
        }],
        replies: [],
        roundScore: 0.8, expectedRoundScore: 0.8, minRoundScore: 0.5, maxRoundScore: 1.0,
        forcedOutcome: 'none',
        mateProbability: 0,
      },
      probabilities: [1],
      sampledId: 'move:earthquake',
      sent: true,
    });
    hud.patchForecast({
      turn: 3,
      status: 'complete',
      choices: [{
        actionId: 'move:earthquake',
        samples: 4,
        wins: 1,
        losses: 1,
        draws: 2,
        capped: 1,
        unknownFrontiers: 1,
        turnCaps: 1,
        timeCaps: 0,
        errors: 0,
        expectedTerminalScore: 0.2,
        minTerminalScore: -1,
        maxTerminalScore: 1,
        expectedCumulativeDelta: 0.1,
        winRate: 0.5,
        winRateLow: 0.1,
        winRateHigh: 0.9,
      }],
      totalSamples: 4,
      elapsedMs: 10,
      assumptionsComplete: true,
      outcomeCounts: {
        win: 1, loss: 1, 'unknown-frontier': 1, 'turn-cap': 1, 'time-cap': 0, cancelled: 0, error: 0,
      },
      terminalSamples: 2,
      winRate: 0.5,
    });
    expect(hud.state.eval?.choices[0]!.winRate).toBe(0.5);
    expect(hud.state.eval?.choices[0]!.unknownFrontiers).toBe(1);
    expect(hud.state.eval?.forecast?.terminalSamples).toBe(2);

    hud.state.turn = 4;
    hud.patchForecast({
      turn: 3,
      status: 'complete',
      choices: [{
        actionId: 'move:earthquake',
        samples: 99,
        wins: 99,
        losses: 0,
        draws: 0,
        capped: 0,
        unknownFrontiers: 0,
        turnCaps: 0,
        timeCaps: 0,
        errors: 0,
        expectedTerminalScore: 1,
        minTerminalScore: 1,
        maxTerminalScore: 1,
        expectedCumulativeDelta: 1,
        winRate: 1,
        winRateLow: 1,
        winRateHigh: 1,
      }],
      totalSamples: 99,
      elapsedMs: 1,
      assumptionsComplete: true,
      outcomeCounts: {
        win: 99, loss: 0, 'unknown-frontier': 0, 'turn-cap': 0, 'time-cap': 0, cancelled: 0, error: 0,
      },
      terminalSamples: 99,
      winRate: 1,
    });
    expect(hud.state.eval?.choices[0]!.samples).toBe(4);
    expect(hud.state.eval?.forecast?.totalSamples).toBe(4);
  });
});

describe('slotsFromObservation', () => {
  it('keeps six slots including unrevealed', () => {
    const o = obs();
    o.theirs.push({
      slot: 1, speciesId: 'smeargle', revealed: false, hp: 100, maxHp: 100, status: '',
      boosts: emptyBoosts(), fainted: false, active: false, knownMoves: [],
      hypotheses: [], modifiers: [], setComplete: false, setSource: 'incomplete',
    });
    const slots = slotsFromObservation(o, 'theirs');
    expect(slots).toHaveLength(6);
    expect(slots[1]!.revealed).toBe(false);
    expect(slots[1]!.speciesId).toBe('');
    expect(slots[1]!.setComplete).toBe(false);
    expect(slots[1]!.assumedSet).toBeUndefined();
  });

  it('carries provenance and completeness through JSON mapping', () => {
    const o = obs();
    o.theirs[0] = {
      ...o.theirs[0]!,
      setSource: 'manual',
      setComplete: true,
      candidateProbability: 0.3,
      set: {
        species: 'Toxapex', level: 80, item: 'blacksludge', ability: 'regenerator',
        moves: ['recover'], nature: 'Bold',
      },
      setWarning: 'Assumed set for toxapex conflicts with revealed facts; using public candidate',
    };
    const slots = slotsFromObservation(o, 'theirs');
    expect(slots[0]!.setSource).toBe('manual');
    expect(slots[0]!.setComplete).toBe(true);
    expect(slots[0]!.assumedSet?.item).toBe('blacksludge');
    expect(slots[0]!.candidateProbability).toBe(0.3);
    expect(slots[0]!.setWarning).toMatch(/conflicts/);
    expect(slots[0]!.speciesId).toBe('toxapex');
  });
});
