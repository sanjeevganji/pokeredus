import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PackIndex } from '@pokeredus/pack';
import {
  PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass,
  NatureClass, MatchupRelation,
} from '../classes/index.js';
import { computeAllScores, calculateCumulativeScore, loadFormulas } from '../attributes/dynamic-engine.js';

export interface GraphEdge {
  source: string;
  target: string;
  edge_type: string;
  data: Record<string, unknown>;
  weight: number;
}

export class KnowledgeGraph {
  private pokemonIndex = new Map<string, PokemonClass>();
  private setIndex = new Map<string, SetClass>();
  private moveIndex = new Map<string, MoveClass>();
  private abilityIndex = new Map<string, AbilityClass>();
  private itemIndex = new Map<string, ItemClass>();
  private natureIndex = new Map<string, NatureClass>();
  private matchupEdges = new Map<string, Map<string, GraphEdge>>();
  private cachedSetFingerprint: string | null = null;

  addPokemon(pokemon: PokemonClass): void {
    this.pokemonIndex.set(pokemon.id, pokemon);
  }

  addMove(move: MoveClass): void {
    this.moveIndex.set(move.id, move);
  }

  addAbility(ability: AbilityClass): void {
    this.abilityIndex.set(ability.id, ability);
  }

  addItem(item: ItemClass): void {
    this.itemIndex.set(item.id, item);
  }

  addNature(nature: NatureClass): void {
    this.natureIndex.set(nature.id, nature);
  }

  addSet(setObj: SetClass): void {
    this.cachedSetFingerprint = null;
    const pokemon = this.getPokemon(setObj.pokemon_id);
    if (pokemon) {
      const formulas = loadFormulas();
      const scores = computeAllScores(pokemon, setObj, formulas);
      setObj.cumulative_score = calculateCumulativeScore(scores);
    } else {
      setObj.cumulative_score = 0;
    }
    this.setIndex.set(setObj.id, setObj);
  }

  addMatchup(matchup: MatchupRelation): void {
    let inner = this.matchupEdges.get(matchup.set_a_id);
    if (!inner) {
      inner = new Map();
      this.matchupEdges.set(matchup.set_a_id, inner);
    }
    inner.set(matchup.set_b_id, {
      source: matchup.set_a_id,
      target: matchup.set_b_id,
      edge_type: 'matchup',
      data: matchup.toDict(),
      weight: matchup.score,
    });
  }

  getPokemon(id: string): PokemonClass | undefined { return this.pokemonIndex.get(id); }
  getSet(id: string): SetClass | undefined { return this.setIndex.get(id); }
  getMove(id: string): MoveClass | undefined { return this.moveIndex.get(id); }
  getAbility(id: string): AbilityClass | undefined { return this.abilityIndex.get(id); }
  getItem(id: string): ItemClass | undefined { return this.itemIndex.get(id); }
  getNature(id: string): NatureClass | undefined { return this.natureIndex.get(id); }

  getSets(pokemonId: string): SetClass[] {
    return [...this.setIndex.values()].filter((s) => s.pokemon_id === pokemonId);
  }

  getPrimarySet(pokemonId: string): SetClass | undefined {
    const pokemon = this.getPokemon(pokemonId);
    if (!pokemon?.primary_set_id) return undefined;
    return this.getSet(pokemon.primary_set_id);
  }

  setPrimarySet(pokemonId: string, setId: string): void {
    const pokemon = this.getPokemon(pokemonId);
    const setObj = this.getSet(setId);
    if (!pokemon) throw new Error(`Pokemon ${pokemonId} not found`);
    if (!setObj) throw new Error(`Set ${setId} not found`);
    if (setObj.pokemon_id !== pokemonId) {
      throw new Error(`Set ${setId} belongs to ${setObj.pokemon_id}, not ${pokemonId}`);
    }
    pokemon.primary_set_id = setId;
  }

  getUnionMovePool(pokemonId: string): string[] {
    const seen = new Set<string>();
    const moves: string[] = [];
    for (const s of this.getSets(pokemonId)) {
      for (const move of s.moves) {
        if (!seen.has(move)) {
          seen.add(move);
          moves.push(move);
        }
      }
    }
    return moves;
  }

  buildCompositeSet(pokemonId: string): SetClass | undefined {
    const sets = this.getSets(pokemonId);
    if (!sets.length) return undefined;
    const base = this.getPrimarySet(pokemonId) ?? sets[0]!;
    return new SetClass({
      id: `${pokemonId}__composite`,
      pokemon_id: pokemonId,
      set_name: 'Composite',
      ability: base.ability,
      item: base.item,
      nature: base.nature,
      evs: base.evs,
      moves: this.getUnionMovePool(pokemonId),
      ivs: { ...base.ivs },
      role: base.role,
      tera_type: base.tera_type,
    });
  }

  getAllSets(): SetClass[] { return [...this.setIndex.values()]; }
  getAllPokemon(): PokemonClass[] { return [...this.pokemonIndex.values()]; }
  getAllMoves(): MoveClass[] { return [...this.moveIndex.values()]; }
  getAllItems(): ItemClass[] { return [...this.itemIndex.values()]; }

  getMatchups(setId: string, minConfidence = 0): MatchupRelation[] {
    const inner = this.matchupEdges.get(setId);
    if (!inner) return [];
    const results: MatchupRelation[] = [];
    for (const edge of inner.values()) {
      const mr = MatchupRelation.fromDict(edge.data);
      if (mr.confidence >= minConfidence) results.push(mr);
    }
    return results;
  }

  getMatchupBetween(setAId: string, setBId: string): MatchupRelation | undefined {
    const edge = this.matchupEdges.get(setAId)?.get(setBId);
    return edge ? MatchupRelation.fromDict(edge.data) : undefined;
  }

  removeSet(setId: string): void {
    this.cachedSetFingerprint = null;
    this.setIndex.delete(setId);
    this.matchupEdges.delete(setId);
    for (const inner of this.matchupEdges.values()) inner.delete(setId);
  }

  removePokemon(pokemonId: string): void {
    for (const s of this.getSets(pokemonId)) this.removeSet(s.id);
    this.pokemonIndex.delete(pokemonId);
  }

  get pokemonCount(): number { return this.pokemonIndex.size; }
  get setCount(): number { return this.setIndex.size; }
  get matchupCount(): number {
    let n = 0;
    for (const inner of this.matchupEdges.values()) n += inner.size;
    return n;
  }
  get moveCount(): number { return this.moveIndex.size; }

  summary(): string {
    return `KnowledgeGraph: ${this.pokemonCount} Pokémon, ${this.setCount} sets, ${this.matchupCount} matchups, ${this.moveCount} moves`;
  }

  computeSetFingerprint(): string {
    const h = createHash('sha256');
    for (const p of [...this.getAllPokemon()].sort((a, b) => a.id.localeCompare(b.id))) {
      h.update(p.id);
      h.update(p.primary_set_id || '');
    }
    for (const s of [...this.getAllSets()].sort((a, b) => a.id.localeCompare(b.id))) {
      h.update(s.id);
      for (const moveId of s.moves) h.update(moveId);
      h.update(s.item);
      h.update(s.ability);
      h.update(s.nature.name);
      h.update(JSON.stringify(s.evs.asDict()));
      h.update(JSON.stringify(s.ivs));
    }
    return h.digest('hex');
  }

  get setFingerprint(): string {
    if (this.cachedSetFingerprint === null) {
      this.cachedSetFingerprint = this.computeSetFingerprint();
    }
    return this.cachedSetFingerprint;
  }

  toJson(): { nodes: unknown[]; edges: GraphEdge[] } {
    const edges: GraphEdge[] = [];
    for (const inner of this.matchupEdges.values()) {
      for (const edge of inner.values()) edges.push(edge);
    }
    return {
      nodes: [
        ...[...this.pokemonIndex.values()].map((p) => ({ id: p.id, node_type: 'pokemon', data: p.toDict() })),
        ...[...this.setIndex.values()].map((s) => ({ id: s.id, node_type: 'set', data: s.toDict() })),
        ...[...this.moveIndex.values()].map((m) => ({ id: m.id, node_type: 'move', data: m.toDict() })),
      ],
      edges,
    };
  }

  save(filePath: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.toJson(), null, 2), 'utf8');
  }

  static fromPackIndex(pack: PackIndex): KnowledgeGraph {
    const kg = new KnowledgeGraph();
    for (const sp of pack.pack.species) {
      kg.addPokemon(new PokemonClass({
        id: sp.id, name: sp.name, types: sp.types,
        base_stats: sp.base_stats, abilities: sp.abilities,
        weight: sp.weight, tier: sp.tier ?? 'OU',
        is_mega: sp.is_mega, is_paradox: sp.is_paradox,
        is_legendary: sp.is_legendary, is_pseudo: sp.is_pseudo,
        api_name: sp.api_name, primary_set_id: sp.primary_set_id,
      }));
    }
    for (const m of pack.pack.moves) {
      kg.addMove(MoveClass.fromDict(m as Record<string, unknown>));
    }
    for (const a of pack.pack.abilities) {
      kg.addAbility(AbilityClass.fromDict(a as Record<string, unknown>));
    }
    for (const it of pack.pack.items) {
      kg.addItem(ItemClass.fromDict(it as Record<string, unknown>));
    }
    for (const s of pack.pack.sets) {
      kg.addSet(SetClass.fromDict(s as Record<string, unknown>));
    }
    return kg;
  }
}
