import * as fs from 'node:fs';
import { KnowledgePackSchema, type KnowledgePack } from './schema.js';
import { PackIndex } from './index.js';

export function loadKnowledgePack(path: string): PackIndex {
  const raw = fs.readFileSync(path, 'utf8');
  const pack = KnowledgePackSchema.parse(JSON.parse(raw)) as KnowledgePack;
  return new PackIndex(pack);
}
