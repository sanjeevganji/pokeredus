import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { KnowledgePackSchema } from '@pokeredus/pack';
import { PackIndex } from '@pokeredus/pack';
import { DEFAULT_BIASES } from '@pokeredus/biases';
import {
  recommendActions,
  renderScene,
  exportTrainingCorpus,
  stateFromSets,
  type TrainingSample,
} from '../src/unified/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packPath = join(__dirname, '../../../pokeredus/data/knowledge-pack/knowledge-pack-mini.json');

let pack: PackIndex;

beforeAll(() => {
  const raw = readFileSync(packPath, 'utf8');
  pack = new PackIndex(KnowledgePackSchema.parse(JSON.parse(raw)));
});

describe('unified recommend/export', () => {
  it('recommendActions returns up to topN scored actions', () => {
    const sets = [...pack.sets.keys()];
    expect(sets.length).toBeGreaterThan(1);
    const state = stateFromSets(sets[0]!, sets[1]!, pack);
    const recs = recommendActions(state, pack, DEFAULT_BIASES, 3);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.length).toBeLessThanOrEqual(3);
    expect(recs[0]!.is_recommended).toBe(true);
    expect(recs[0]!.label.length).toBeGreaterThan(0);
  });

  it('renderScene includes active set names', () => {
    const sets = [...pack.sets.keys()];
    const state = stateFromSets(sets[0]!, sets[1]!, pack);
    const scene = renderScene(state, pack);
    expect(scene).toContain('Turn 1');
    expect(scene).toContain('You:');
    expect(scene).toContain('Opp:');
  });

  it('exportTrainingCorpus writes JSONL lines', () => {
    const sets = [...pack.sets.keys()];
    const state = stateFromSets(sets[0]!, sets[1]!, pack);
    const recs = recommendActions(state, pack, DEFAULT_BIASES, 1);
    const samples: TrainingSample[] = [{
      scene_text: renderScene(state, pack),
      action_text: recs[0]!.label,
      reward: recs[0]!.score,
    }];
    const dir = mkdtempSync(join(tmpdir(), 'pokeredus-unified-'));
    const out = join(dir, 'corpus.jsonl');
    exportTrainingCorpus(samples, out);
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!) as TrainingSample;
    expect(row.scene_text).toContain('Turn 1');
    expect(row.action_text).toBe(recs[0]!.label);
    rmSync(dir, { recursive: true, force: true });
  });
});
