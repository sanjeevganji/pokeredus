// export-pack.ts — TS knowledge pack exporter (Phase D).
// Loads species/moves/sets/abilities/items from an existing pack template,
// recomputes primary-set edges via @pokeredus/core computeMatchup (@pokeredus/calc).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeGraph, computeMatchup, TYPE_CHART } from '@pokeredus/core';
import { loadKnowledgePack } from '@pokeredus/pack/load';
import { PackIndex } from '@pokeredus/pack';
import {
  KnowledgePackSchema,
  type KnowledgePack,
  type Edge,
} from '@pokeredus/pack/schema';
import type { SetClass } from '@pokeredus/core';

export const PACK_VERSION = 1 as const;

export interface ExportPackOptions {
  /** Existing pack JSON used as species/moves/sets source. */
  templatePath: string;
  outPath: string;
  mini?: boolean;
  maxSpecies?: number;
}

export interface ExportPackResult {
  pack: KnowledgePack;
  outPath: string;
  stats: {
    species: number;
    sets: number;
    moves: number;
    abilities: number;
    items: number;
    edges: number;
    byteSize: number;
    elapsedMs: number;
  };
}

/** Walk up from cwd to find the monorepo root (package.json with workspaces). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (j.workspaces) return dir;
      } catch { /* continue */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function defaultKnowledgePackDir(repoRoot = findRepoRoot()): string {
  return path.join(repoRoot, 'pokeredus', 'data', 'knowledge-pack');
}

export function resolveExportPaths(opts: {
  template?: string;
  out?: string;
  mini?: boolean;
  repoRoot?: string;
}): { templatePath: string; outPath: string } {
  const root = opts.repoRoot ?? findRepoRoot();
  const dir = defaultKnowledgePackDir(root);
  const templatePath = opts.template ?? path.join(dir, 'knowledge-pack-v1.json');
  const outPath = opts.out ?? path.join(
    dir,
    opts.mini ? 'knowledge-pack-mini.json' : `knowledge-pack-v${PACK_VERSION}.json`,
  );
  return { templatePath, outPath };
}

function primarySet(kg: KnowledgeGraph, pokemonId: string): SetClass | undefined {
  const sets = kg.getSets(pokemonId);
  if (!sets.length) return undefined;
  return sets.find((s) => s.set_name.toLowerCase().includes('showdown usage')) ?? sets[0];
}

function buildEdges(kg: KnowledgeGraph, speciesIds: Iterable<string>): Edge[] {
  const primaries: SetClass[] = [];
  for (const pid of speciesIds) {
    const p = primarySet(kg, pid);
    if (p) primaries.push(p);
  }

  const edges: Edge[] = [];
  for (const a of primaries) {
    for (const b of primaries) {
      if (a === b) continue;
      const mr = computeMatchup(a, b, kg);
      edges.push({
        a_set_id: mr.set_a_id,
        b_set_id: mr.set_b_id,
        score: Math.round(mr.score * 10000) / 10000,
        best_move_a_id: mr.best_move_a_id,
        ttk_a: mr.turns_to_kill_a || 0,
        ttk_b: mr.turns_to_kill_b || 0,
        dmg_pct_lo: Number.isFinite(mr.damage_pct_a_to_b_lo) ? Math.round(mr.damage_pct_a_to_b_lo * 100) / 100 : 0,
        dmg_pct_hi: Number.isFinite(mr.damage_pct_a_to_b_hi) ? Math.round(mr.damage_pct_a_to_b_hi * 100) / 100 : 0,
      });
    }
  }
  return edges;
}

/** Slice species/sets; keep full move/ability/item pools (matches Python exporter). */
export function filterPackSource(
  source: KnowledgePack,
  maxSpecies?: number,
): Pick<KnowledgePack, 'species' | 'sets'> {
  if (maxSpecies == null) {
    return { species: source.species, sets: source.sets };
  }
  const species = source.species.slice(0, maxSpecies);
  const pids = new Set(species.map((s) => s.id));
  const sets = source.sets.filter((s) => pids.has(s.pokemon_id));
  return { species, sets };
}

export function buildKnowledgePack(
  templatePath: string,
  opts: { mini?: boolean; maxSpecies?: number } = {},
): KnowledgePack {
  const source = loadKnowledgePack(templatePath).pack;
  const maxSpecies = opts.mini ? 5 : opts.maxSpecies;
  const { species, sets } = filterPackSource(source, maxSpecies);

  const kg = KnowledgeGraph.fromPackIndex(new PackIndex({
    ...source,
    species,
    sets,
    edges: [],
  }));

  const edges = buildEdges(kg, species.map((s) => s.id));

  const pack: KnowledgePack = {
    version: PACK_VERSION,
    generated_at: new Date().toISOString(),
    types: TYPE_CHART,
    species,
    moves: source.moves,
    abilities: source.abilities,
    items: source.items,
    sets,
    edges,
  };

  return KnowledgePackSchema.parse(pack);
}

export function writeKnowledgePack(pack: KnowledgePack, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack), 'utf8');
}

export function exportKnowledgePack(opts: ExportPackOptions): ExportPackResult {
  const t0 = Date.now();
  const maxSpecies = opts.mini ? 5 : opts.maxSpecies;
  const pack = buildKnowledgePack(opts.templatePath, { maxSpecies });
  writeKnowledgePack(pack, opts.outPath);
  const byteSize = fs.statSync(opts.outPath).size;

  return {
    pack,
    outPath: opts.outPath,
    stats: {
      species: pack.species.length,
      sets: pack.sets.length,
      moves: pack.moves.length,
      abilities: pack.abilities.length,
      items: pack.items.length,
      edges: pack.edges.length,
      byteSize,
      elapsedMs: Date.now() - t0,
    },
  };
}

export function formatExportSummary(result: ExportPackResult): string {
  const { stats, outPath } = result;
  const mb = stats.byteSize / 1024 / 1024;
  return [
    `[pack] wrote ${path.basename(outPath)}`,
    `  species=${stats.species} sets=${stats.sets} moves=${stats.moves} `,
    `abilities=${stats.abilities} items=${stats.items} edges=${stats.edges}`,
    `  size=${mb.toFixed(2)} MB  (${(stats.elapsedMs / 1000).toFixed(1)}s)`,
  ].join('\n');
}
