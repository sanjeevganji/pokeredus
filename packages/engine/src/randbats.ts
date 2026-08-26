import type { CanonicalSet } from './observation.js';
import type { PoolRow, RandomSetPool } from './pool.js';

export const DEFAULT_NATURE = 'Hardy';
export const DEFAULT_LEVEL = 80;
export const DEFAULT_EV = 85;

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

export interface RandbatsRole {
  name: string;
  abilities: string[];
  items: string[];
  teraTypes: string[];
  moves: string[];
  evs?: CanonicalSet['evs'];
  ivs?: CanonicalSet['ivs'];
}

export interface RandbatsSpecies {
  name: string;
  level?: number;
  abilities: string[];
  items: string[];
  roles: RandbatsRole[];
  evs?: CanonicalSet['evs'];
  ivs?: CanonicalSet['ivs'];
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && Boolean(x.trim())).map((s) => s.trim());
}

function asSpread(v: unknown): CanonicalSet['evs'] | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: NonNullable<CanonicalSet['evs']> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && STATS.includes(k as (typeof STATS)[number])) {
      out[k as (typeof STATS)[number]] = n;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function isRandbatsJson(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if ('species' in o && 'version' in o) return false;
  const first = Object.values(o)[0];
  return Boolean(first && typeof first === 'object' && !Array.isArray(first) && 'roles' in (first as object));
}

export function parseRandbats(raw: unknown): Record<string, RandbatsSpecies> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('randbats data must be an object');
  }
  const out: Record<string, RandbatsSpecies> = {};
  for (const [name, spec] of Object.entries(raw as Record<string, unknown>)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue;
    const o = spec as Record<string, unknown>;
    const rolesRaw = o.roles;
    if (!rolesRaw || typeof rolesRaw !== 'object' || Array.isArray(rolesRaw)) continue;
    const speciesEvs = asSpread(o.evs);
    const speciesIvs = asSpread(o.ivs);
    const speciesAbilities = asStringList(o.abilities);
    const speciesItems = asStringList(o.items);
    const roles: RandbatsRole[] = [];
    for (const [roleName, role] of Object.entries(rolesRaw as Record<string, unknown>)) {
      if (!role || typeof role !== 'object' || Array.isArray(role)) continue;
      const r = role as Record<string, unknown>;
      const moves = asStringList(r.moves);
      if (!moves.length) continue;
      const abilities = asStringList(r.abilities);
      const items = asStringList(r.items);
      roles.push({
        name: roleName,
        abilities: abilities.length ? abilities : speciesAbilities,
        items: items.length ? items : speciesItems,
        teraTypes: asStringList(r.teraTypes),
        moves,
        evs: asSpread(r.evs) ?? speciesEvs,
        ivs: asSpread(r.ivs) ?? speciesIvs,
      });
    }
    if (!roles.length) continue;
    out[speciesKey(name)] = {
      name,
      level: typeof o.level === 'number' && o.level >= 1 && o.level <= 100 ? o.level : undefined,
      abilities: speciesAbilities,
      items: speciesItems,
      roles,
      evs: speciesEvs,
      ivs: speciesIvs,
    };
  }
  return out;
}

export function defaultEvs(overlay?: CanonicalSet['evs']): CanonicalSet['evs'] {
  const base: NonNullable<CanonicalSet['evs']> = {
    hp: DEFAULT_EV, atk: DEFAULT_EV, def: DEFAULT_EV, spa: DEFAULT_EV, spd: DEFAULT_EV, spe: DEFAULT_EV,
  };
  return overlay ? { ...base, ...overlay } : base;
}

export function pickMoves(pool: string[], known: string[] = [], n = 4): string[] {
  const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: string[] = [];
  const have = new Set<string>();
  for (const m of known) {
    const hit = pool.find((p) => id(p) === id(m));
    if (hit && !have.has(id(hit))) {
      out.push(hit);
      have.add(id(hit));
    }
    if (out.length >= n) return out;
  }
  for (const m of pool) {
    if (!have.has(id(m))) {
      out.push(m);
      have.add(id(m));
    }
    if (out.length >= n) break;
  }
  return out;
}

export function materializeRole(
  species: RandbatsSpecies,
  role: RandbatsRole,
  opts: { teraType?: string; item?: string; ability?: string; moves?: string[]; knownMoves?: string[] } = {},
): CanonicalSet {
  const moves = opts.moves?.length
    ? opts.moves.filter(Boolean).slice(0, 4)
    : pickMoves(role.moves, opts.knownMoves);
  return {
    species: species.name,
    level: species.level ?? DEFAULT_LEVEL,
    item: opts.item ?? role.items[0] ?? species.items[0] ?? '',
    ability: opts.ability ?? role.abilities[0] ?? species.abilities[0] ?? '',
    moves: moves.length ? moves : role.moves.slice(0, 4),
    nature: DEFAULT_NATURE,
    teraType: opts.teraType || role.teraTypes[0],
    teraTypes: role.teraTypes.length ? role.teraTypes : undefined,
    role: role.name,
    movePool: role.moves,
    evs: defaultEvs(role.evs),
    ivs: role.ivs,
  };
}

export function randbatsToPool(raw: unknown, format = 'gen9randombattle'): RandomSetPool {
  const data = parseRandbats(raw);
  const species: Record<string, PoolRow[]> = {};
  for (const [key, spec] of Object.entries(data)) {
    species[key] = spec.roles.map((role) => ({ set: materializeRole(spec, role), count: 1 }));
  }
  return { format, version: 1, samples: 0, seed: 0, species };
}
