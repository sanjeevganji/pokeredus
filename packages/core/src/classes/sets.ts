import { NatureClass } from './natures.js';
import { EVSpreadClass } from './ev-spread.js';
import type { BaseStats } from './pokemon.js';

const STAT_NAMES = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const DEFAULT_IV = 31;

export class SetClass {
  id: string;
  pokemon_id: string;
  set_name: string;
  ability: string;
  item: string;
  nature: NatureClass;
  evs: EVSpreadClass;
  moves: string[];
  ivs: Record<string, number>;
  role: string;
  tera_type: string;
  cumulative_score = 0;

  constructor(opts: {
    id?: string;
    pokemon_id: string;
    set_name: string;
    ability: string;
    item: string;
    nature: NatureClass;
    evs: EVSpreadClass;
    moves?: string[];
    ivs?: Record<string, number>;
    role?: string;
    tera_type?: string;
  }) {
    this.pokemon_id = opts.pokemon_id;
    this.set_name = opts.set_name;
    this.ability = opts.ability;
    this.item = opts.item;
    this.nature = opts.nature;
    this.evs = opts.evs;
    this.moves = opts.moves ?? [];
    this.ivs = { ...opts.ivs };
    this.role = opts.role ?? '';
    this.tera_type = opts.tera_type ?? '';

    for (const stat of STAT_NAMES) {
      if (!(stat in this.ivs)) this.ivs[stat] = DEFAULT_IV;
    }

    if (opts.id) {
      this.id = opts.id;
    } else {
      const slug = opts.set_name.toLowerCase().replace(/ /g, '_').replace(/\+/g, 'plus');
      this.id = `${opts.pokemon_id}_${slug}`;
    }
  }

  get moveCount(): number { return this.moves.length; }
  get hasFullMoveset(): boolean { return this.moves.length === 4; }

  effectiveStat(stat: string, baseStats: BaseStats | Record<string, number>, level = 50): number {
    const stats = baseStats as Record<string, number>;
    const base = stats[stat] ?? 0;
    const iv = this.ivs[stat] ?? 31;
    const ev = this.evs.get(stat);
    const natureMod = this.nature.modifier(stat);

    if (stat === 'hp') {
      return Math.floor(((2 * base + iv + Math.floor(ev / 4)) * level / 100) + level + 10);
    }
    return Math.floor((((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5) * natureMod);
  }

  toDict(): Record<string, unknown> {
    return {
      id: this.id, pokemon_id: this.pokemon_id, set_name: this.set_name,
      ability: this.ability, item: this.item,
      nature: this.nature.toDict(), evs: this.evs.toDict(),
      moves: [...this.moves], ivs: { ...this.ivs },
      role: this.role, tera_type: this.tera_type,
    };
  }

  static fromDict(data: Record<string, unknown>): SetClass {
    return new SetClass({
      id: String(data.id ?? ''),
      pokemon_id: String(data.pokemon_id),
      set_name: String(data.set_name),
      ability: String(data.ability),
      item: String(data.item),
      nature: NatureClass.fromDict(data.nature as { name: string; increased_stat?: string | null; decreased_stat?: string | null }),
      evs: EVSpreadClass.fromDict(data.evs as Record<string, unknown>),
      moves: (data.moves as string[]) ?? [],
      ivs: (data.ivs as Record<string, number>) ?? {},
      role: String(data.role ?? ''),
      tera_type: String(data.tera_type ?? ''),
    });
  }
}
