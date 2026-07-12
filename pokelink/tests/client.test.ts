// Task 12 — client.ts: mocked `ws`, no real network. A `|challstr|` triggers a
// guest `|/trn`, and a `|request|` is parsed into a BattleEvent that, fed
// through a BattleTracker, yields the expected TurnState.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ws', () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    url: string;
    private handlers: Record<string, ((data?: unknown) => void)[]> = {};
    sent: string[] = [];
    constructor(url: string) {
      this.url = url;
      MockWebSocket.instances.push(this);
    }
    on(ev: string, cb: (data?: unknown) => void) {
      (this.handlers[ev] ??= []).push(cb);
    }
    send(msg: string) {
      this.sent.push(msg);
    }
    trigger(ev: string, data?: unknown) {
      for (const h of this.handlers[ev] ?? []) h(data);
    }
    close() {}
  }
  return { WebSocket: MockWebSocket, default: MockWebSocket };
});

import { WebSocket } from 'ws';
import { ShowdownClient } from '../src/bridge/client.js';
import { BattleTracker } from '../src/bridge/protocol.js';
import { KnowledgePackSchema } from '../src/pack/schema.js';
import { PackIndex } from '../src/pack/index.js';

const REQUEST_JSON = JSON.stringify({
  side: {
    id: 'p1',
    name: 'Player',
    pokemon: [
      {
        ident: 'p1: Garchomp', details: 'Garchomp, L78, M', condition: '100/100', active: true,
        moves: [
          { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 10, disabled: false },
          { move: 'Swords Dance', id: 'swordsdance', pp: 8, maxpp: 8, disabled: false },
        ],
        baseAbility: 'Sand Veil', item: 'Leftovers', teraType: 'Fire', terastallized: false,
      },
    ],
  },
  active: [
    { moves: [
      { move: 'Earthquake', id: 'earthquake', pp: 10, maxpp: 10, disabled: false },
      { move: 'Swords Dance', id: 'swordsdance', pp: 8, maxpp: 8, disabled: false },
    ], canTerastallize: true },
  ],
  rqid: 1,
});

const EMPTY_PACK = new PackIndex(
  KnowledgePackSchema.parse({
    version: 1, generated_at: 'x', types: {}, species: [], moves: [], abilities: [], items: [], sets: [], edges: [],
  }) as never,
);

describe('ShowdownClient (mocked ws)', () => {
  beforeEach(() => {
    (WebSocket as unknown as { instances: unknown[] }).instances.length = 0;
  });

  it('connects, auths as guest, and emits a parsed |request| event', async () => {
    const client = new ShowdownClient({ url: 'wss://test', dryRun: true });
    const events: string[] = [];
    client.onEvent((ev) => events.push(ev.type));

    const connected = client.connect();
    const ws = (WebSocket as any).instances[0];
    ws.trigger('open');
    await connected;

    ws.trigger('message', '|challstr|1|abc123');
    ws.trigger('message', `|request|${REQUEST_JSON}`);

    expect(events).toContain('request');
    const trnSent = ws.sent.find((m: string) => m.startsWith('|/trn'));
    expect(trnSent).toBeDefined();
    expect(trnSent).toContain('pokelink'); // guest name prefix
  });

  it('the emitted request event yields the expected TurnState via a tracker', async () => {
    const client = new ShowdownClient({ url: 'wss://test', dryRun: true });
    const events: { type: string; json?: unknown }[] = [];
    client.onEvent((ev) => events.push(ev as { type: string; json?: unknown }));

    const connected = client.connect();
    const ws = (WebSocket as any).instances[0];
    ws.trigger('open');
    await connected;

    ws.trigger('message', `|switch|p2a: Toxapex|Toxapex, L78, F|100/100`);
    ws.trigger('message', `|request|${REQUEST_JSON}`);

    const req = events.find((e) => e.type === 'request');
    expect(req).toBeDefined();
    const tracker = new BattleTracker();
    for (const e of events) tracker.apply(e as never);
    const state = tracker.toTurnState(EMPTY_PACK, { allowThin: true });
    expect(state.myActive.hp).toBe(100);
    expect(state.turn).toBe(0); // no |turn| line was sent
    expect(tracker.oppMons.get('p2a')?.speciesId).toBe('toxapex');
  });
});
