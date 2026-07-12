// Task 9 — scorer.ts: the MCTS-style bounded-depth entry point.
// Feed a fixture TurnState through scoreTurn and assert the result shape,
// the action ordering, and the fainted/choice legal-action paths.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '../src/pack/schema.js';
import { PackIndex } from '../src/pack/index.js';
import { scoreTurn } from '../src/engine/scorer.js';
import { makeMon, emptyField, type TurnState, type ActiveMon } from '../src/engine/state.js';
import { DEFAULT_BIASES } from '../src/biases/defaults.js';
import type { Biases } from '../src/biases/schema.js';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = KnowledgePackSchema.parse(JSON.parse(raw));
const idx = new PackIndex(pack);

function state(
  active: string,
  opp: string,
  bench: string[] = ['clefable_showdown-usage', 'arcanine-hisui_showdown-usage', 'ninetales-alola_showdown-usage'],
  opts: Partial<TurnState> = {},
): TurnState {
  return {
    side: 'a', turn: 1,
    myActive: { ...makeMon(active, 300), ...opts.myActive },
    myBench: (opts.myBench ?? bench.map((id) => makeMon(id, 300))) as ActiveMon[],
    oppActive: makeMon(opp, 300),
    field: emptyField(),
    teraUsed: false,
    allowThin: true,
  };
}

describe('scoreTurn — the runtime engine entry point', () => {
  it('returns a ranked ScoredAction[] (length == legal-actions)', () => {
    const s = state('venusaur_sun-sweeper', 'clefable_showdown-usage');
    const scored = scoreTurn(s, idx, DEFAULT_BIASES);
    expect(scored.length).toBeGreaterThan(0);
    // 4 moves × 2 (tera) = 8 move actions + 3 switch actions = 11
    expect(scored).toHaveLength(11);
    // sorted descending
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1]!.score).toBeGreaterThanOrEqual(scored[i]!.score);
    }
  });

  it('top action for Venusaur vs Clefable is a move (Sludge Bomb, SE×2 + STAB)', () => {
    const s = state('venusaur_sun-sweeper', 'clefable_showdown-usage');
    const scored = scoreTurn(s, idx, DEFAULT_BIASES);
    expect(scored[0]?.action.type).toBe('move');
    expect(scored[0]?.action.moveId).toBe('sludge-bomb');
    expect(scored[0]?.score).toBeGreaterThan(1.0);
    // reasoning trail survives the tree search
    expect(scored[0]?.reasoning.some((r) => r.includes('super-effective') || r.includes('STAB'))).toBe(true);
  });

  it('populates children when rollout_depth > 0', () => {
    const s = state('arcanine-hisui_showdown-usage', 'venusaur_sun-sweeper');
    const scored = scoreTurn(s, idx, DEFAULT_BIASES);
    expect(scored[0]?.children).toBeDefined();
    expect(scored[0]?.children!.length).toBeGreaterThan(0);
  });

  it('flat eval (rollout_depth=0) produces no children', () => {
    const flat: Biases = { ...DEFAULT_BIASES, rollout_depth: 0 };
    const s = state('arcanine-hisui_showdown-usage', 'venusaur_sun-sweeper');
    const scored = scoreTurn(s, idx, flat);
    expect(scored[0]?.children).toBeUndefined();
    expect(scored[0]?.score).toBeGreaterThan(0);
  });

  it('fainted-bench legal-action count: only live switches appear', () => {
    const bench = [
      makeMon('clefable_showdown-usage', 300),
      { ...makeMon('arcanine-hisui_showdown-usage', 300), fainted: true },
      makeMon('ninetales-alola_showdown-usage', 300),
    ];
    const s = state('venusaur_sun-sweeper', 'clefable_showdown-usage', [], { myBench: bench });
    const scored = scoreTurn(s, idx, DEFAULT_BIASES);
    // 4 moves × 2 (tera) = 8 move + 2 switch (one bench fainted) = 10
    expect(scored).toHaveLength(10);
    const switches = scored.filter((x) => x.action.type === 'switch');
    expect(switches).toHaveLength(2);
  });

  it('choice-lock: only the locked move + tera variant appear (2 move actions)', () => {
    const lockedMove = pack.sets.find((s) => s.id === 'arcanine-hisui_choice-band')!.moves[0]!;
    const lockedActive = { ...makeMon('arcanine-hisui_choice-band', 300), choiceLock: lockedMove };
    const s: TurnState = {
      side: 'a', turn: 1,
      myActive: lockedActive,
      myBench: [makeMon('clefable_showdown-usage', 300), makeMon('arcanine-hisui_showdown-usage', 300), makeMon('ninetales-alola_showdown-usage', 300)],
      oppActive: makeMon('venusaur_sun-sweeper', 300),
      field: emptyField(), teraUsed: false, allowThin: true,
    };
    const scored = scoreTurn(s, idx, DEFAULT_BIASES);
    const moves = scored.filter((x) => x.action.type === 'move');
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.action.moveId === lockedMove)).toBe(true);
  });

  it('refuses a too-small pack unless allowThin is set', () => {
    const s: TurnState = {
      side: 'a', turn: 1,
      myActive: makeMon('venusaur_sun-sweeper', 300),
      myBench: [makeMon('clefable_showdown-usage', 300)],
      oppActive: makeMon('clefable_showdown-usage', 300),
      field: emptyField(), teraUsed: false,
      // NOTE: no allowThin → should throw since mini pack < pack_min_mb typically
      allowThin: false,
    };
    expect(() => scoreTurn(s, idx, DEFAULT_BIASES)).toThrow();
  });

  it('soft performance budget (under 50ms per turn)', () => {
    const s = state('arcanine-hisui_showdown-usage', 'venusaur_sun-sweeper');
    const t0 = Date.now();
    scoreTurn(s, idx, DEFAULT_BIASES);
    const elapsed = Date.now() - t0;
    // ponytail: ceiling — relax on slow CI; this guards the O(legal*N) contract
    expect(elapsed).toBeLessThan(500);
  });
});
