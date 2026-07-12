// Task 7 — enumerateActions: legal {move, switch} actions per turn.
// Uses real mini-pack sets. Arcanine-Hisui carries Choice Band (choiceLock
// scenario); Venusaur has Growth (Status) for the Taunt scenario.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '../src/pack/schema.js';
import { PackIndex } from '../src/pack/index.js';
import { enumerateActions } from '../src/engine/actions.js';
import { makeMon, emptyField, type TurnState } from '../src/engine/state.js';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = KnowledgePackSchema.parse(JSON.parse(raw));
const idx = new PackIndex(pack);

// Arcanine-Hisui Choice Band set — 4 moves, choice-band item (but
// enumerateActions reads `choiceLock` from the ActiveMon, not the item; we
// simulate the locked state by setting choiceLock manually).
const arcSet = pack.sets.find((s) => s.id === 'arcanine-hisui_choice-band')!;
const venuSet = pack.sets.find((s) => s.id === 'venusaur_sun-sweeper')!;

// Build a TurnState with `setId` active and a bench of [setId, ...fainted].
function build(setId: string, opts: Partial<TurnState> = {}): TurnState {
  return {
    side: 'a',
    turn: 1,
    myActive: { ...makeMon(setId, 300), ...opts.myActive },
    myBench: opts.myBench ?? [makeMon('clefable_showdown-usage', 300), makeMon('ninetales-alola_showdown-usage', 300), makeMon('venusaur_sun-sweeper', 300)],
    oppActive: makeMon('arcanine-hisui_showdown-usage', 300),
    field: emptyField(),
    teraUsed: opts.teraUsed ?? false,
    allowThin: true,
  };
}

describe('enumerateActions', () => {
  it('yields 8 actions for a 4-move set (4 moves × 2 tera variants)', () => {
    const state = build(arcSet.id);
    const actions = enumerateActions(state, idx);
    // 4 moves × 2 (tera false + true) = 8, plus 3 switch actions = 11.
    const moves = actions.filter((a) => a.type === 'move');
    const switches = actions.filter((a) => a.type === 'switch');
    expect(moves).toHaveLength(8);
    expect(switches).toHaveLength(3);
  });

  it('choice-lock — only the locked move + its tera variant = 2 move actions', () => {
    const lockedMove = arcSet.moves[0]!; // head-smash
    const state = build(arcSet.id, { myActive: { choiceLock: lockedMove, pp: {}, boosts: makeMon(arcSet.id, 1).boosts } } as Partial<TurnState>);
    const actions = enumerateActions(state, idx);
    const moves = actions.filter((a) => a.type === 'move');
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.moveId === lockedMove)).toBe(true);
  });

  it('fainted bench excluded from switch actions', () => {
    const bench = [
      { ...makeMon('clefable_showdown-usage', 300), fainted: true },
      { ...makeMon('ninetales-alola_showdown-usage', 300), fainted: false },
      { ...makeMon('venusaur_sun-sweeper', 300), fainted: true },
    ];
    const state = build(arcSet.id, { myBench: bench });
    const actions = enumerateActions(state, idx);
    const switches = actions.filter((a) => a.type === 'switch');
    // Only the non-fainted bench mon (slot 1) is switchable
    expect(switches).toHaveLength(1);
    expect(switches[0]?.slot).toBe(1);
  });

  it('Taunt removes Status moves (Venusaur Growth filtered)', () => {
    // Venusaur moves: growth (Status), giga-drain, weather-ball, sludge-bomb
    const state = build(venuSet.id, { myActive: { tauntTurns: 2 } } as Partial<TurnState>);
    const actions = enumerateActions(state, idx);
    const moves = actions.filter((a) => a.type === 'move');
    // 3 non-status moves × 2 (tera) = 6 move actions; growth is filtered.
    const growth = moves.filter((m) => m.moveId === 'growth');
    expect(growth).toHaveLength(0);
    expect(moves).toHaveLength(6);
    // ensure the non-status moves remain
    expect(moves.some((m) => m.moveId === 'giga-drain')).toBe(true);
    expect(moves.some((m) => m.moveId === 'sludge-bomb')).toBe(true);
  });

  it('teraUsed=true — only one variant per move (no tera duplicates)', () => {
    const state = build(arcSet.id, { teraUsed: true });
    const actions = enumerateActions(state, idx);
    const moves = actions.filter((a) => a.type === 'move');
    expect(moves).toHaveLength(4); // 4 moves, 1 variant each
    expect(moves.every((m) => m.tera === false)).toBe(true);
  });
});
