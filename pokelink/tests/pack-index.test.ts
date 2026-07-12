// Task 3 — PackIndex lookup layer, exercised against the real mini fixture
// produced by `python scripts/export_knowledge_pack.py --mini`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { KnowledgePackSchema } from '../src/pack/schema.js';
import { PackIndex } from '../src/pack/index.js';

const raw = readFileSync(new URL('./fixtures/pack.mini.json', import.meta.url), 'utf-8');
const pack = KnowledgePackSchema.parse(JSON.parse(raw));
const idx = new PackIndex(pack);

describe('PackIndex (mini fixture)', () => {
  it('parses the real exported pack as a valid KnowledgePack', () => {
    expect(pack.version).toBe(1);
    expect(pack.species.length).toBeGreaterThan(0);
    expect(pack.edges.length).toBeGreaterThan(0);
  });

  it('looks up a move by id', () => {
    const m = pack.moves[0]!;
    expect(idx.getMove(m.id)?.id).toBe(m.id);
  });

  it('returns undefined for an unknown move', () => {
    expect(idx.getMove('does-not-exist')).toBeUndefined();
  });

  it('looks up an edge a→b and round-trips its fields', () => {
    const e = pack.edges[0]!;
    const got = idx.getEdge(e.a_set_id, e.b_set_id);
    expect(got).toBeDefined();
    expect(got?.a_set_id).toBe(e.a_set_id);
    expect(got?.b_set_id).toBe(e.b_set_id);
    expect(got?.score).toBe(e.score);
    expect(got?.best_move_a_id).toBe(e.best_move_a_id);
  });

  it('returns undefined for an unknown edge direction', () => {
    expect(idx.getEdge('no-such-a', 'no-such-b')).toBeUndefined();
  });

  it('finds sets for a species', () => {
    const s = pack.sets[0]!;
    const found = idx.setsForSpecies(s.pokemon_id);
    expect(found.length).toBeGreaterThan(0);
    expect(found.some((x) => x.id === s.id)).toBe(true);
  });

  it('reports a non-trivial byte size', () => {
    expect(idx.byteSizeMB).toBeGreaterThan(0);
  });

  it('summary() contains the section counts', () => {
    const sum = idx.summary();
    expect(sum).toContain(`#species=${pack.species.length}`);
    expect(sum).toContain(`#sets=${pack.sets.length}`);
    expect(sum).toContain(`#edges=${pack.edges.length}`);
  });
});
