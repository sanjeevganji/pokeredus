// Task 13 — decide.ts: a scored turn posts the expected |/choose command.
// Uses a tiny custom pack (Garchomp w/ Earthquake vs Toxapex) so the engine's
// top move is deterministically Earthquake under flat (rollout_depth=0) eval.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';
import { PackIndex } from '@pokeredus/pack';
import { decideAndAct } from '@pokeredus/bridge';
import { makeMon, emptyField, type TurnState } from '@pokeredus/engine';
import { DEFAULT_BIASES } from '@pokeredus/biases';
import type { Biases } from '@pokeredus/biases';

const raw = readFileSync(new URL('./fixtures/decide-pack.json', import.meta.url), 'utf-8');
const pack = new PackIndex(KnowledgePackSchema.parse(JSON.parse(raw)) as any);

class MockClient {
  sent: string[] = [];
  send(m: string) { this.sent.push(m); }
}

describe('decideAndAct', () => {
  it('posts |/choose move earthquake for Garchomp vs Toxapex', () => {
    const flat: Biases = { ...DEFAULT_BIASES, rollout_depth: 0, dry_run: false };
    const state: TurnState = {
      side: 'a', turn: 1,
      myActive: { ...makeMon('garchomp_set', 303), pp: { earthquake: 10, swordsdance: 8 } },
      myBench: [],
      oppActive: makeMon('toxapex_set', 303),
      field: emptyField(), teraUsed: false, allowThin: true,
    };
    const client = new MockClient();
    const scored = decideAndAct(client, state, pack, flat);

    expect(scored[0]?.action.moveId).toBe('earthquake');
    expect(client.sent).toContain('|/choose move earthquake');
  });

  it('dry-run logs but does not send', () => {
    const dry: Biases = { ...DEFAULT_BIASES, rollout_depth: 0, dry_run: true };
    const state: TurnState = {
      side: 'a', turn: 1,
      myActive: { ...makeMon('garchomp_set', 303), pp: { earthquake: 10, swordsdance: 8 } },
      myBench: [],
      oppActive: makeMon('toxapex_set', 303),
      field: emptyField(), teraUsed: false, allowThin: true,
    };
    const client = new MockClient();
    decideAndAct(client, state, pack, dry);
    expect(client.sent).toHaveLength(0);
  });
});
