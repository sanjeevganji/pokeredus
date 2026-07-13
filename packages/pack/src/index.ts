import type { KnowledgePack, Move, SetEntry, Species, Edge } from './schema.js';

export * from './schema.js';

export class PackIndex {
  readonly pack: KnowledgePack;
  readonly moves: Map<string, Move>;
  readonly sets: Map<string, SetEntry>;
  readonly species: Map<string, Species>;
  readonly edges: Map<string, Map<string, Edge>>;
  readonly abilities: Map<string, { id: string; name: string; description: string; flags: string[] }>;
  readonly items: Map<string, { id: string; name: string; description: string; consumed: boolean }>;
  readonly setsBySpecies: Map<string, SetEntry[]>;
  readonly primaryBySpecies: Map<string, SetEntry>;

  constructor(pack: KnowledgePack) {
    this.pack = pack;
    this.moves = new Map();
    for (const m of pack.moves) this.moves.set(m.id, m);
    this.sets = new Map();
    for (const s of pack.sets) this.sets.set(s.id, s);
    this.species = new Map();
    for (const sp of pack.species) this.species.set(sp.id, sp);
    this.edges = new Map();
    for (const e of pack.edges) {
      let inner = this.edges.get(e.a_set_id);
      if (!inner) { inner = new Map(); this.edges.set(e.a_set_id, inner); }
      inner.set(e.b_set_id, e);
    }
    this.abilities = new Map();
    for (const a of pack.abilities) this.abilities.set(a.id, a);
    this.items = new Map();
    for (const it of pack.items) this.items.set(it.id, it);
    this.setsBySpecies = new Map();
    for (const s of pack.sets) {
      let arr = this.setsBySpecies.get(s.pokemon_id);
      if (!arr) { arr = []; this.setsBySpecies.set(s.pokemon_id, arr); }
      arr.push(s);
    }
    this.primaryBySpecies = new Map();
    for (const [pid, arr] of this.setsBySpecies) {
      const usage = arr.find((s) => s.set_name.toLowerCase().includes('showdown usage'));
      this.primaryBySpecies.set(pid, usage ?? arr[0]!);
    }
  }

  getMove(id: string): Move | undefined { return this.moves.get(id); }
  getSet(id: string): SetEntry | undefined { return this.sets.get(id); }
  getSpecies(id: string): Species | undefined { return this.species.get(id); }
  getEdge(aSetId: string, bSetId: string): Edge | undefined {
    return this.edges.get(aSetId)?.get(bSetId);
  }

  setsForSpecies(pokemonId: string): SetEntry[] {
    const result: SetEntry[] = [];
    for (const s of this.sets.values()) {
      if (s.pokemon_id === pokemonId) result.push(s);
    }
    return result;
  }

  get byteSizeMB(): number {
    const bytes = Buffer.byteLength(JSON.stringify(this.pack), 'utf8');
    return bytes / (1024 * 1024);
  }

  summary(): string {
    let n = 0;
    for (const inner of this.edges.values()) n += inner.size;
    return [
      `version=${this.pack.version}`,
      `generated_at=${this.pack.generated_at}`,
      `#species=${this.species.size}`,
      `#sets=${this.sets.size}`,
      `#moves=${this.moves.size}`,
      `#edges=${n}`,
      `byteSizeMB=${this.byteSizeMB.toFixed(2)}`,
    ].join(', ');
  }
}
