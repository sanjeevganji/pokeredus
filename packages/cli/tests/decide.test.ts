import { describe, it, expect } from 'vitest';
import { decideAndAct, LiveForecastSession } from '@pokeredus/bridge';
import {
  emptyBoosts,
  emptyField,
  type BattleObservation,
  type QuantumPolicyProcess,
} from '@pokeredus/engine';

class MockClient {
  sent: string[] = [];
  send(m: string) { this.sent.push(m); }
}

class MockPolicy {
  calls = 0;
  async decide() {
    this.calls += 1;
    return { probabilities: [1], diagnostics: { mode: 'softmax' } };
  }
  start() {}
  close() {}
}

function obs(): BattleObservation {
  return {
    turn: 1,
    format: 'gen9randombattle',
    ourSide: 'p1',
    ours: [{
      slot: 0, speciesId: 'garchomp', revealed: true, hp: 250, maxHp: 250, status: '',
      boosts: emptyBoosts(), fainted: false, active: true, knownMoves: ['earthquake'],
      set: { species: 'Garchomp', level: 80, item: '', ability: 'roughskin', moves: ['earthquake'], nature: 'Jolly' },
      hypotheses: [], modifiers: [],
    }],
    theirs: [{
      slot: 0, speciesId: 'toxapex', revealed: true, hp: 250, maxHp: 250, status: '',
      boosts: emptyBoosts(), fainted: false, active: true, knownMoves: ['recover'],
      set: { species: 'Toxapex', level: 88, item: '', ability: 'regenerator', moves: ['recover'], nature: 'Bold' },
      hypotheses: [{
        set: { species: 'Toxapex', level: 88, item: '', ability: 'regenerator', moves: ['recover'], nature: 'Bold' },
        count: 1, probability: 1,
      }],
      modifiers: [],
    }],
    field: emptyField(),
    legalActions: [{ id: 'move:earthquake', type: 'move', moveId: 'earthquake' }],
    teraUsedOurs: false,
    teraUsedTheirs: false,
  };
}

describe('decideAndAct', () => {
  it('dry-run logs but does not send', async () => {
    const client = new MockClient();
    const result = await decideAndAct(client, obs(), {
      dryRun: true,
      process: new MockPolicy() as unknown as QuantumPolicyProcess,
      rng: () => 0,
      evaluate: () => ({
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
          minTurnScore: 1, maxTurnScore: 1, minPostScore: 0, maxPostScore: 0, sampleCount: 1,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
          probability: 1,
        }],
        roundScore: 0, expectedRoundScore: 0, minRoundScore: 0, maxRoundScore: 0,
        replies: [],
        forcedOutcome: 'none',
        mateProbability: 0,
      }),
    });
    expect(client.sent).toHaveLength(0);
    expect(result.sent).toBe(false);
    expect(result.sampledId).toBe('move:earthquake');
  });

  it('sends the sampled legal choice', async () => {
    const client = new MockClient();
    const result = await decideAndAct(client, obs(), {
      dryRun: false,
      process: new MockPolicy() as unknown as QuantumPolicyProcess,
      rng: () => 0,
      evaluate: () => ({
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
          minTurnScore: 1, maxTurnScore: 1, minPostScore: 0, maxPostScore: 0, sampleCount: 1,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
          probability: 1,
        }],
        roundScore: 0, expectedRoundScore: 0, minRoundScore: 0, maxRoundScore: 0,
        replies: [],
        forcedOutcome: 'none',
        mateProbability: 0,
      }),
    });
    expect(result.sent).toBe(true);
    expect(client.sent[0]).toContain('earthquake');
  });

    it('sends terastallize when a tera action is sampled', async () => {
    const client = new MockClient();
    const result = await decideAndAct(client, obs(), {
      dryRun: false,
      process: new MockPolicy() as unknown as QuantumPolicyProcess,
      rng: () => 0,
      evaluate: () => ({
        choices: [{
          action: { id: 'move:earthquake:tera', type: 'move', moveId: 'earthquake', tera: true },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
          minTurnScore: 1, maxTurnScore: 1, minPostScore: 0, maxPostScore: 0, sampleCount: 1,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
          probability: 1,
        }],
        roundScore: 0, expectedRoundScore: 0, minRoundScore: 0, maxRoundScore: 0,
        replies: [],
        forcedOutcome: 'none',
        mateProbability: 0,
      }),
    });
    expect(result.sent).toBe(true);
    expect(client.sent[0]).toContain('earthquake');
    expect(client.sent[0]).toContain('terastallize');
  });

  it('samples the returned policy without calling the process a second time', async () => {
    const client = new MockClient();
    const process = new MockPolicy();
    await decideAndAct(client, obs(), {
      dryRun: true,
      process: process as unknown as QuantumPolicyProcess,
      rng: () => 0,
      evaluate: () => ({
        choices: [{
          action: { id: 'move:earthquake', type: 'move', moveId: 'earthquake' },
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0,
          ourHealth: 0, theirHealth: -1, ourModifier: 0, theirModifier: 0,
          hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
          minTurnScore: 1, maxTurnScore: 1, minPostScore: 0, maxPostScore: 0, sampleCount: 1,
          features: { health: 1, modifier: 0, secondary: 0, switchRisk: 0, sacrifice: 0 },
          probability: 1,
        }],
        roundScore: 0, expectedRoundScore: 0, minRoundScore: 0, maxRoundScore: 0,
        replies: [],
        forcedOutcome: 'none',
        mateProbability: 0,
      }),
    });
    expect(process.calls).toBe(0);
  });
});

describe('LiveForecastSession', () => {
  it('start returns without waiting for the forecast and ignores stale turn patches', async () => {
    const patched: number[] = [];
    const hud = {
      state: { turn: 1, room: 'battle-x' },
      patchForecast(f: { turn: number }) {
        patched.push(f.turn);
      },
    };
    const session = new LiveForecastSession(
      new MockPolicy() as unknown as QuantumPolicyProcess,
      hud,
    );
    const o = obs();
    const t0 = Date.now();
    session.start(o, {
      policy: 'softmax',
      pairDelta: () => 0.1,
      rolloutsPerChoice: 1,
      maxTurns: 1,
      seed: 1,
    });
    expect(Date.now() - t0).toBeLessThan(50);
    hud.state.turn = 2;
    await new Promise((r) => setTimeout(r, 80));
    expect(patched.every((t) => t !== 1 || hud.state.turn === 1)).toBe(true);
    expect(patched).toEqual([]);
    session.close();
  });
});
