// Task 10 — Biases loader: defaults, missing file fallback, partial merge, zod rejects.
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiasesSchema } from '../src/biases/schema.js';
import { DEFAULT_BIASES } from '../src/biases/defaults.js';
import { loadBiases } from '../src/biases/loader.js';

describe('Biases', () => {
  it('DEFAULT_BIASES satisfies BiasesSchema (no missing keys)', () => {
    expect(() => BiasesSchema.parse(DEFAULT_BIASES)).not.toThrow();
  });

  it('loadBiases() with no path returns DEFAULT_BIASES verbatim', () => {
    const b = loadBiases();
    expect(b).toEqual(DEFAULT_BIASES);
  });

  it('loadBiases with a missing path falls back to defaults', () => {
    const b = loadBiases('/nonexistent/path/to/biases.json');
    expect(b).toEqual(DEFAULT_BIASES);
  });

  it('a partial JSON file merges with defaults (zod .default() fills gaps)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkb-'));
    const path = join(dir, 'partial.json');
    writeFileSync(path, JSON.stringify({ version: 1, type_eff_weight: 2.0, rollout_count: 8 }));
    const b = loadBiases(path);
    expect(b.type_eff_weight).toBe(2.0);
    expect(b.rollout_count).toBe(8);
    expect(b.stab_weight).toBe(DEFAULT_BIASES.stab_weight); // default filled in
    rmSync(dir, { recursive: true, force: true });
  });

  it('bad weight type throws via zod', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pkb-'));
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ version: 1, stab_weight: 'not-a-number' }));
    expect(() => loadBiases(path)).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it('version !== 1 rejects', () => {
    expect(() => BiasesSchema.parse({ version: 2 })).toThrow();
  });

  it('rollout_count within [0, 1024] is enforced', () => {
    expect(() => BiasesSchema.parse({ version: 1, rollout_count: 9999 })).toThrow();
  });

  it('the shipped biases.json is a valid full biases file', () => {
    const b = loadBiases(new URL('../biases.json', import.meta.url).pathname.replace(/^\//, ''));
    expect(b.version).toBe(1);
    expect(b.edge_prior_weight).toBe(0.4);
  });
});
