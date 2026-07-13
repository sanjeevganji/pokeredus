// export-pack.test.ts — TS knowledge pack exporter
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgePackSchema } from '@pokeredus/pack/schema';
import {
  buildKnowledgePack,
  exportKnowledgePack,
  filterPackSource,
  resolveExportPaths,
} from '../src/export-pack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../..');
const miniTemplate = join(repoRoot, 'pokeredus/data/knowledge-pack/knowledge-pack-mini.json');
const fullTemplate = join(repoRoot, 'pokeredus/data/knowledge-pack/knowledge-pack-v1.json');
const fixtureMini = join(__dirname, 'fixtures/pack.mini.json');

let templatePack: ReturnType<typeof KnowledgePackSchema.parse>;
let fixturePack: ReturnType<typeof KnowledgePackSchema.parse>;

beforeAll(() => {
  templatePack = KnowledgePackSchema.parse(JSON.parse(readFileSync(miniTemplate, 'utf8')));
  fixturePack = KnowledgePackSchema.parse(JSON.parse(readFileSync(fixtureMini, 'utf8')));
});

describe('resolveExportPaths', () => {
  it('defaults to pokeredus knowledge-pack paths', () => {
    const { templatePath, outPath } = resolveExportPaths({ repoRoot });
    expect(templatePath).toContain('knowledge-pack-v1.json');
    expect(outPath).toContain('knowledge-pack-v1.json');
  });

  it('uses mini output when --mini', () => {
    const { outPath } = resolveExportPaths({ repoRoot, mini: true });
    expect(outPath).toContain('knowledge-pack-mini.json');
  });
});

describe('filterPackSource', () => {
  it('keeps all species when maxSpecies is omitted', () => {
    const { species, sets } = filterPackSource(templatePack);
    expect(species.length).toBe(templatePack.species.length);
    expect(sets.length).toBe(templatePack.sets.length);
  });

  it('slices to first N species and their sets', () => {
    const { species, sets } = filterPackSource(templatePack, 3);
    expect(species).toHaveLength(3);
    const pids = new Set(species.map((s) => s.id));
    expect(sets.every((s) => pids.has(s.pokemon_id))).toBe(true);
    expect(sets.length).toBeLessThan(templatePack.sets.length);
  });
});

describe('buildKnowledgePack (--mini)', () => {
  it('produces a valid KnowledgePackSchema v1 document', () => {
    const pack = buildKnowledgePack(miniTemplate, { mini: true });
    expect(pack.version).toBe(1);
    expect(pack.species).toHaveLength(5);
    expect(pack.edges.length).toBeGreaterThan(0);
    expect(pack.moves.length).toBe(templatePack.moves.length);
    expect(KnowledgePackSchema.parse(pack)).toBeDefined();
  });

  it('emits 20 primary-set edges for 5 species', () => {
    const pack = buildKnowledgePack(miniTemplate, { mini: true });
    expect(pack.edges).toHaveLength(20);
  });

  it('matches Python fixture edge: Venusaur vs Clefable Showdown Usage', () => {
    const pack = buildKnowledgePack(miniTemplate, { mini: true });
    const got = pack.edges.find(
      (e) => e.a_set_id === 'venusaur_sun-sweeper' && e.b_set_id === 'clefable_showdown-usage',
    );
    const expected = fixturePack.edges.find(
      (e) => e.a_set_id === 'venusaur_sun-sweeper' && e.b_set_id === 'clefable_showdown-usage',
    );
    expect(got).toBeDefined();
    expect(expected).toBeDefined();
    expect(got!.score).toBeCloseTo(expected!.score, 1);
    expect(got!.best_move_a_id).toBe(expected!.best_move_a_id);
    expect(got!.ttk_a).toBeGreaterThan(0);
    expect(got!.ttk_b).toBeGreaterThan(0);
  });
});

describe('exportKnowledgePack', () => {
  it('writes JSON to disk with expected stats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'export-pack-'));
    try {
      const outPath = join(dir, 'out-mini.json');
      const result = exportKnowledgePack({
        templatePath: miniTemplate,
        outPath,
        mini: true,
      });
      expect(result.stats.species).toBe(5);
      expect(result.stats.edges).toBe(20);
      expect(result.stats.byteSize).toBeGreaterThan(1000);
      const written = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(KnowledgePackSchema.parse(written).version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildKnowledgePack (full template)', () => {
  it('recomputes edges for the full pack when template exists', () => {
    try {
      readFileSync(fullTemplate, 'utf8');
    } catch {
      return; // skip if full pack not present in CI
    }
    const pack = buildKnowledgePack(fullTemplate);
    expect(pack.species.length).toBeGreaterThan(50);
    expect(pack.edges.length).toBeGreaterThan(10000);
    expect(KnowledgePackSchema.parse(pack)).toBeDefined();
  }, 120_000);
});
