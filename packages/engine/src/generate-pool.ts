import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalizeSet } from './beliefs.js';
import { speciesKey, type PoolRow, type RandomSetPool } from './pool.js';
import type { CanonicalSet } from './observation.js';

const require = createRequire(import.meta.url);

export interface GeneratePoolOptions {
  samples: number;
  seed: number;
  outPath: string;
}

function asSet(raw: Record<string, unknown>): CanonicalSet {
  const moves = Array.isArray(raw.moves) ? raw.moves.map(String) : [];
  return {
    species: String(raw.species ?? raw.name ?? ''),
    level: Number(raw.level ?? 100),
    item: String(raw.item ?? ''),
    ability: String(raw.ability ?? ''),
    moves,
    nature: String(raw.nature ?? 'Hardy'),
    gender: raw.gender ? String(raw.gender) : undefined,
    teraType: raw.teraType ? String(raw.teraType) : undefined,
    evs: (raw.evs as CanonicalSet['evs']) ?? undefined,
    ivs: (raw.ivs as CanonicalSet['ivs']) ?? undefined,
  };
}

/** Convert an integer into a Showdown gen5 PRNG seed string. */
export function prngSeedFromInt(n: number): string {
  return `${n >>> 0},${(n * 1103515245 + 12345) >>> 0},${(n * 1664525 + 1013904223) >>> 0},${(n * 214013 + 2531011) >>> 0}`;
}

export function generateRandomSetPool(opts: GeneratePoolOptions): RandomSetPool {
  const PS = require('pokemon-showdown') as {
    Teams: { generate: (format: string, opts?: { seed?: string }) => Record<string, unknown>[] };
  };
  if (typeof PS.Teams?.generate !== 'function') {
    throw new Error('pokemon-showdown Teams.generate is unavailable');
  }
  const counts = new Map<string, Map<string, { set: CanonicalSet; count: number }>>();
  for (let i = 0; i < opts.samples; i++) {
    const team = PS.Teams.generate('gen9randombattle', { seed: prngSeedFromInt(opts.seed + i) });
    for (const raw of team) {
      const set = asSet(raw);
      const spec = speciesKey(set.species);
      const key = canonicalizeSet(set);
      let inner = counts.get(spec);
      if (!inner) {
        inner = new Map();
        counts.set(spec, inner);
      }
      const prev = inner.get(key);
      if (prev) prev.count += 1;
      else inner.set(key, { set, count: 1 });
    }
  }
  const species: Record<string, PoolRow[]> = {};
  for (const [spec, inner] of counts) {
    species[spec] = [...inner.values()].sort((a, b) => b.count - a.count);
  }
  const pool: RandomSetPool = {
    format: 'gen9randombattle',
    version: 1,
    samples: opts.samples,
    seed: opts.seed,
    species,
  };
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
  fs.writeFileSync(opts.outPath, JSON.stringify(pool), 'utf8');
  return pool;
}
