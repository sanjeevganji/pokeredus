import { describe, it, expect } from 'vitest';
import { decideAndAct } from '@pokeredus/bridge';
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
  async decide() {
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
    teraUsed: false,
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
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0, hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
        }],
        roundScore: 0,
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
          success: 1, cta: 1, expectedImpact: 1, expectedHealthDelta: 1, expectedModifierDelta: 0, hitsToKill: 1, choiceScore: 1, scaledChoiceScore: 1, meanPostScore: 0,
        }],
        roundScore: 0,
        replies: [],
        forcedOutcome: 'none',
        mateProbability: 0,
      }),
    });
    expect(result.sent).toBe(true);
    expect(client.sent[0]).toContain('earthquake');
  });
});
