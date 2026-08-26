import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalSet } from './observation.js';
import { isRandbatsJson, randbatsToPool } from './randbats.js';

export interface PoolRow {
  set: CanonicalSet;
  count: number;
}

export interface RandomSetPool {
  format: string;
  version: number;
  samples: number;
  seed: number;
  species: Record<string, PoolRow[]>;
}

const DEFAULT_REL = ['data', 'gen9randombattle.json'];

export function defaultPoolPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', ...DEFAULT_REL);
}

export function loadPool(poolPath = defaultPoolPath()): RandomSetPool {
  const parsed = JSON.parse(fs.readFileSync(poolPath, 'utf8')) as unknown;
  if (isRandbatsJson(parsed)) return randbatsToPool(parsed);
  const pool = parsed as RandomSetPool;
  if (!pool?.species || typeof pool.species !== 'object') {
    throw new Error(`invalid random-set pool: ${poolPath}`);
  }
  return pool;
}

export function speciesKey(species: string): string {
  return species.toLowerCase().replace(/[^a-z0-9]/g, '');
}
