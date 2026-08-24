import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanonicalSet } from './observation.js';

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

const DEFAULT_REL = ['data', 'gen9randombattle-pool.v1.json'];

export function defaultPoolPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', ...DEFAULT_REL);
}

export function loadPool(poolPath = defaultPoolPath()): RandomSetPool {
  const raw = fs.readFileSync(poolPath, 'utf8');
  const parsed = JSON.parse(raw) as RandomSetPool;
  if (!parsed?.species || typeof parsed.species !== 'object') {
    throw new Error(`invalid random-set pool: ${poolPath}`);
  }
  return parsed;
}

export function speciesKey(species: string): string {
  return species.toLowerCase().replace(/[^a-z0-9]/g, '');
}
