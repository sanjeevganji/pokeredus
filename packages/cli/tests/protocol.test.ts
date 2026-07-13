// Task 11 — protocol.ts: a real-ish Gen9OU transcript folds into the expected
// TurnState. Uses the mini pack (Venusaur/Clefable are present) so set
// resolution is exercised, not just structural folding.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';
import { PackIndex } from '@pokeredus/pack';
import { BattleTracker, resolveSetId } from '@pokeredus/bridge';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = new PackIndex(KnowledgePackSchema.parse(JSON.parse(raw)) as any);

const transcript = readFileSync(new URL('./fixtures/transcript.txt', import.meta.url), 'utf-8');

describe('BattleTracker — transcript → TurnState', () => {
  it('folds the transcript into the expected normalized state', () => {
    const tracker = new BattleTracker();
    for (const line of transcript.split('\n')) tracker.applyLine(line);
    const state = tracker.toTurnState(pack, { allowThin: true });

    expect(state.turn).toBe(1);
    expect(state.myActive.setId).toBe('venusaur_sun-sweeper');
    expect(state.myActive.hp).toBe(100);
    expect(state.myActive.boosts.spa).toBe(1);
    expect(state.myActive.status).toBe('');
    expect(state.oppActive.setId).toBe('clefable_showdown-usage');
    expect(state.oppActive.hp).toBe(42);
    expect(state.oppActive.status).toBe('brn');
    expect(state.myBench).toHaveLength(0);
    expect(state.field.weather).toBe('sunny');
    expect(state.field.hazards_a.stealthrock).toBe(true);
  });

  it('resolveSetId maps Showdown species ids onto pack sets', () => {
    expect(resolveSetId('venusaur', pack)).toBe('venusaur_sun-sweeper');
    expect(resolveSetId('clefable', pack)).toBe('clefable_showdown-usage');
    // regional-form hyphenation: Showdown strips hyphens, pack keeps them
    expect(resolveSetId('arcaninehisui', pack)).toBe('arcanine-hisui_showdown-usage');
    // unknown species → undefined (engine scores it 0, caller logs a warning)
    expect(resolveSetId('missingmon', pack)).toBeUndefined();
  });
});
