import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { KnowledgePackSchema, PackIndex } from '@pokeredus/pack';
import {
  KnowledgeGraph,
  BattleSimulator,
  ProbabilisticEngine,
  MCTSSearcher,
} from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packPath = join(__dirname, '../../../pokeredus/data/knowledge-pack/knowledge-pack-mini.json');

let kg: KnowledgeGraph;
let engine: ProbabilisticEngine;

beforeAll(() => {
  const raw = readFileSync(packPath, 'utf8');
  const pack = KnowledgePackSchema.parse(JSON.parse(raw));
  kg = KnowledgeGraph.fromPackIndex(new PackIndex(pack));
  const sim = new BattleSimulator(kg);
  engine = new ProbabilisticEngine(kg, sim, 10, 50, 42);
});

describe('MCTSSearcher — deterministic seeded', () => {
  it('produces identical root_value and best_path length for same seed', () => {
    const state = engine.createStateFromSets(
      ['venusaur_sun-sweeper'],
      ['clefable_showdown-usage'],
    );

    const run = () => {
      const searcher = new MCTSSearcher(engine, 40, 2.0, 12345);
      return searcher.search(state.clone(), 'a');
    };

    const g1 = run();
    const g2 = run();

    expect(g1.root_value).toBe(g2.root_value);
    expect(g1.root.visits).toBe(g2.root.visits);
    expect(g1.best_path.length).toBe(g2.best_path.length);
    expect(g1.best_path.length).toBeGreaterThan(0);
  });

  it('BattleSimulator scores Venusaur favorably vs Clefable', () => {
    const sim = new BattleSimulator(kg);
    const result = sim.simulateById('venusaur', 'clefable');
    expect(result.score).toBeGreaterThan(0);
    expect(result.our_effective_ttk).toBeGreaterThan(0);
    expect(result.their_effective_ttk).toBeGreaterThan(0);
  });
});
