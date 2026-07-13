import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadKnowledgePack } from '@pokeredus/pack/load';
import { DEFAULT_BIASES } from '@pokeredus/biases';
import {
  recommendActions,
  renderScene,
  exportTrainingCorpus,
  stateFromSets,
  type TrainingSample,
} from '@pokeredus/core';
import { findRepoRoot } from './export-pack.js';

export interface ExportTrainingOptions {
  packPath: string;
  outPath: string;
  maxPairs?: number;
}

/** ponytail: demo corpus from pack set pairs — not full team-store mining yet. */
export function exportTrainingData(opts: ExportTrainingOptions): { samples: number; outPath: string } {
  const pack = loadKnowledgePack(opts.packPath);
  const setIds = [...pack.sets.keys()];
  const maxPairs = opts.maxPairs ?? 20;
  const samples: TrainingSample[] = [];

  for (let i = 0; i < setIds.length && samples.length < maxPairs; i++) {
    for (let j = i + 1; j < setIds.length && samples.length < maxPairs; j++) {
      const state = stateFromSets(setIds[i]!, setIds[j]!, pack);
      const recs = recommendActions(state, pack, DEFAULT_BIASES, 1);
      if (!recs.length) continue;
      samples.push({
        scene_text: renderScene(state, pack),
        action_text: recs[0]!.label,
        reward: recs[0]!.score,
      });
    }
  }

  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  exportTrainingCorpus(samples, opts.outPath);
  return { samples: samples.length, outPath: opts.outPath };
}

export function resolveTrainingOutPath(out?: string): string {
  const root = findRepoRoot();
  return out ?? path.join(root, 'data', 'training', 'gen9ou_demo.jsonl');
}

export function defaultTrainingPackPath(): string {
  return path.join(findRepoRoot(), 'pokeredus', 'data', 'knowledge-pack', 'knowledge-pack-mini.json');
}
