import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KnowledgePackSchema } from '@pokeredus/pack';
import { PackIndex } from '@pokeredus/pack';
import {
  KnowledgeGraph,
  computeMatchup,
  computeTtkScore,
  getEffectiveness,
  SetClass,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packPath = join(__dirname, '../../../pokeredus/data/knowledge-pack/knowledge-pack-mini.json');

let kg: KnowledgeGraph;

beforeAll(() => {
  const raw = readFileSync(packPath, 'utf8');
  const pack = KnowledgePackSchema.parse(JSON.parse(raw));
  kg = KnowledgeGraph.fromPackIndex(new PackIndex(pack));
});

describe('computeTtkScore', () => {
  it('returns 0 when neither side can kill', () => {
    expect(computeTtkScore(0, 0, 'tie')).toBe(0);
  });

  it('returns +1 when only A can kill', () => {
    expect(computeTtkScore(2, 0, 'a')).toBe(1);
  });

  it('returns -1 when only B can kill', () => {
    expect(computeTtkScore(0, 3, 'b')).toBe(-1);
  });

  it('favors faster mon on TTK tie', () => {
    const score = computeTtkScore(2, 2, 'a');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.15);
  });

  it('uses tanh for TTK differential', () => {
    const score = computeTtkScore(1, 3, 'tie');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe('getEffectiveness', () => {
  it('Poison vs Fairy is 2x', () => {
    expect(getEffectiveness('Poison', ['Fairy'])).toBe(2);
  });

  it('Ground vs Flying is immune', () => {
    expect(getEffectiveness('Ground', ['Flying'])).toBe(0);
  });
});

describe('computeMatchup', () => {
  it('returns zero-confidence relation when pokemon missing', () => {
    const setA = kg.getSet('venusaur_sun-sweeper')!;
    const fakeSet = new SetClass({
      id: 'fake', pokemon_id: 'missingmon', set_name: 'Fake',
      ability: setA.ability, item: setA.item, nature: setA.nature,
      evs: setA.evs, moves: setA.moves,
    });
    const rel = computeMatchup(fakeSet, setA, kg);
    expect(rel.score).toBe(0);
    expect(rel.confidence).toBe(0);
    expect(rel.source).toBe('ttk_calc');
  });

  it('Venusaur Sun Sweeper vs Clefable Showdown Usage — A favored (Poison SE)', () => {
    const venu = kg.getSet('venusaur_sun-sweeper')!;
    const clef = kg.getSet('clefable_showdown-usage')!;
    const rel = computeMatchup(venu, clef, kg);

    expect(rel.source).toBe('ttk_calc');
    expect(rel.turns_to_kill_a).toBeGreaterThan(0);
    expect(rel.score).toBeGreaterThan(0);
    expect(rel.best_move_a_id).toBeTruthy();
    expect(rel.tags.some((t) => t.includes('HKO') || t === 'faster')).toBe(true);
  });

  it('Clefable vs Venusaur — A disadvantaged', () => {
    const venu = kg.getSet('venusaur_sun-sweeper')!;
    const clef = kg.getSet('clefable_showdown-usage')!;
    const rel = computeMatchup(clef, venu, kg);

    expect(rel.score).toBeLessThan(0);
    expect(rel.turns_to_kill_b).toBeGreaterThan(0);
  });

  it('Arcanine-Hisui Choice Band vs Venusaur — hard win for Arcanine', () => {
    const arc = kg.getSet('arcanine-hisui_choice-band')!;
    const venu = kg.getSet('venusaur_sun-sweeper')!;
    const rel = computeMatchup(arc, venu, kg);

    expect(rel.score).toBeGreaterThan(0.4);
    expect(rel.turns_to_kill_a).toBeLessThanOrEqual(2);
    expect(rel.tags.some((t) => t === 'OHKO' || t === '2HKO' || t === 'faster')).toBe(true);
  });

  it('characterization: pairwise matchup graph scores stay in [-1, 1] for the mini pack', () => {
    for (const setA of kg.getAllSets()) {
      for (const setB of kg.getAllSets()) {
        if (setA.id === setB.id) continue;
        const rel = computeMatchup(setA, setB, kg);
        expect(rel.score).toBeGreaterThanOrEqual(-1);
        expect(rel.score).toBeLessThanOrEqual(1);
        expect(rel.confidence).toBeGreaterThanOrEqual(0);
        expect(rel.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('KnowledgeGraph', () => {
  it('loads mini pack with expected counts', () => {
    expect(kg.pokemonCount).toBe(5);
    expect(kg.setCount).toBe(10);
    expect(kg.moveCount).toBeGreaterThan(50);
  });

  it('builds composite set with union move pool', () => {
    const composite = kg.buildCompositeSet('clefable');
    expect(composite).toBeDefined();
    expect(composite!.moves.length).toBeGreaterThan(4);
    expect(composite!.id).toBe('clefable__composite');
  });
});
