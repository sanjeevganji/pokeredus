import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeGraph } from '../kg/knowledge-graph.js';
import { bestMove } from './damage.js';

export class CachedMatchup {
  constructor(
    readonly attacker_id: string,
    readonly defender_id: string,
    readonly turns_to_kill: number,
    readonly best_move_id: string,
    readonly damage_per_hit: number,
    readonly min_damage: number,
    readonly max_damage: number,
    readonly min_ttk: number,
    readonly max_ttk: number,
    readonly damage_pct_lo: number,
    readonly damage_pct_hi: number,
    readonly type_effectiveness: number,
    readonly stab: number,
    readonly move_type: string,
    readonly move_category: string,
    readonly offensive_stat: number,
    readonly defensive_stat: number,
  ) {}

  toDict(): Record<string, unknown> {
    return {
      attacker_id: this.attacker_id, defender_id: this.defender_id,
      turns_to_kill: this.turns_to_kill, best_move_id: this.best_move_id,
      damage_per_hit: this.damage_per_hit,
      min_damage: this.min_damage, max_damage: this.max_damage,
      min_ttk: this.min_ttk, max_ttk: this.max_ttk,
      damage_pct_lo: Math.round(this.damage_pct_lo * 100) / 100,
      damage_pct_hi: Math.round(this.damage_pct_hi * 100) / 100,
      type_effectiveness: this.type_effectiveness, stab: this.stab,
      move_type: this.move_type, move_category: this.move_category,
      offensive_stat: this.offensive_stat, defensive_stat: this.defensive_stat,
    };
  }

  static fromDict(data: Record<string, unknown>): CachedMatchup {
    return new CachedMatchup(
      String(data.attacker_id), String(data.defender_id),
      Number(data.turns_to_kill), String(data.best_move_id),
      Number(data.damage_per_hit), Number(data.min_damage), Number(data.max_damage),
      Number(data.min_ttk), Number(data.max_ttk),
      Number(data.damage_pct_lo), Number(data.damage_pct_hi),
      Number(data.type_effectiveness), Number(data.stab),
      String(data.move_type), String(data.move_category),
      Number(data.offensive_stat), Number(data.defensive_stat),
    );
  }
}

export class MatchupCache {
  private cache = new Map<string, CachedMatchup>();
  private fingerprint = '';

  private key(attackerId: string, defenderId: string): string {
    return `${attackerId}\0${defenderId}`;
  }

  get(attackerId: string, defenderId: string): CachedMatchup | undefined {
    return this.cache.get(this.key(attackerId, defenderId));
  }

  put(matchup: CachedMatchup): void {
    this.cache.set(this.key(matchup.attacker_id, matchup.defender_id), matchup);
  }

  getAllAgainst(defenderId: string): CachedMatchup[] {
    return [...this.cache.values()].filter((m) => m.defender_id === defenderId);
  }

  getAllBy(attackerId: string): CachedMatchup[] {
    return [...this.cache.values()].filter((m) => m.attacker_id === attackerId);
  }

  get size(): number { return this.cache.size; }

  static computeFingerprint(kg: KnowledgeGraph): string {
    const h = createHash('sha256');
    for (const p of [...kg.getAllPokemon()].sort((a, b) => a.id.localeCompare(b.id))) {
      h.update(p.id);
      h.update(p.primary_set_id || '');
    }
    for (const s of [...kg.getAllSets()].sort((a, b) => a.id.localeCompare(b.id))) {
      h.update(s.id);
      for (const moveId of s.moves) h.update(moveId);
    }
    return h.digest('hex');
  }

  isValid(kg: KnowledgeGraph): boolean {
    return this.fingerprint === MatchupCache.computeFingerprint(kg);
  }

  build(
    kg: KnowledgeGraph,
    progressCb?: (done: number, total: number) => void,
  ): number {
    const pokemonWithSets = kg.getAllPokemon().filter((p) => kg.getSets(p.id).length > 0);
    const total = pokemonWithSets.length * pokemonWithSets.length;
    let done = 0;
    this.cache.clear();

    for (const atkPokemon of pokemonWithSets) {
      const atkSet = kg.buildCompositeSet(atkPokemon.id);
      if (!atkSet) {
        done += pokemonWithSets.length;
        progressCb?.(done, total);
        continue;
      }

      for (const defPokemon of pokemonWithSets) {
        done++;
        if (atkPokemon.id === defPokemon.id) {
          progressCb?.(done, total);
          continue;
        }
        const defSet = kg.buildCompositeSet(defPokemon.id);
        if (!defSet) {
          progressCb?.(done, total);
          continue;
        }

        const result = bestMove(atkSet, defSet, kg);
        if (result) {
          this.put(new CachedMatchup(
            atkPokemon.id, defPokemon.id,
            result.turns_to_kill, result.move_id,
            result.final_damage, result.min_damage, result.max_damage,
            result.min_turns_to_kill, result.max_turns_to_kill,
            result.min_damage_percent, result.max_damage_percent,
            result.type_effectiveness, result.stab_mult,
            result.move_type, result.move_category,
            result.offensive_stat, result.defensive_stat,
          ));
        }
        progressCb?.(done, total);
      }
    }

    this.fingerprint = MatchupCache.computeFingerprint(kg);
    return this.size;
  }

  save(filePath?: string): string {
    const resolved = filePath ?? path.join(process.cwd(), 'matchup_cache.json');
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const payload = {
      fingerprint: this.fingerprint,
      matchups: [...this.cache.values()].map((m) => m.toDict()),
    };
    fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), 'utf8');
    return resolved;
  }

  static load(filePath?: string): MatchupCache {
    const resolved = filePath ?? path.join(process.cwd(), 'matchup_cache.json');
    const payload = JSON.parse(fs.readFileSync(resolved, 'utf8')) as {
      fingerprint?: string;
      matchups?: Record<string, unknown>[];
    };
    const cache = new MatchupCache();
    cache.fingerprint = payload.fingerprint ?? '';
    for (const entry of payload.matchups ?? []) {
      const m = CachedMatchup.fromDict(entry);
      cache.put(m);
    }
    return cache;
  }

  static loadOrBuild(
    kg: KnowledgeGraph,
    filePath?: string,
    force = false,
    progressCb?: (done: number, total: number) => void,
  ): MatchupCache {
    const resolved = filePath ?? path.join(process.cwd(), 'matchup_cache.json');
    if (!force && fs.existsSync(resolved)) {
      try {
        const cache = MatchupCache.load(resolved);
        if (cache.isValid(kg)) return cache;
      } catch {
        // corrupt — rebuild
      }
    }
    const cache = new MatchupCache();
    cache.build(kg, progressCb);
    cache.save(resolved);
    return cache;
  }
}
