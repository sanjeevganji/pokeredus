import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalizeSet, compatible, hypothesesForSpecies } from './beliefs.js';
import type { CanonicalSet, RevealedFacts, SetOption } from './observation.js';
import { speciesKey, type RandomSetPool } from './pool.js';
import { DEFAULT_LEVEL, DEFAULT_NATURE, pickMoves } from './randbats.js';

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
type Stat = (typeof STATS)[number];
const SET_KEYS = new Set([
  'species', 'level', 'item', 'ability', 'moves', 'nature', 'gender', 'teraType',
  'teraTypes', 'role', 'movePool', 'evs', 'ivs',
]);

export interface SetOverridesStore {
  version: 1;
  overrides: Record<string, Record<string, CanonicalSet>>;
}

export interface SetCatalogRow {
  set: CanonicalSet;
  count: number;
  probability: number;
  compatible: boolean;
}

export interface SetCatalog {
  species: string;
  format: string;
  override?: CanonicalSet;
  candidates: SetCatalogRow[];
}

export function defaultSetOverridesPath(): string {
  return process.env.POKEREDUS_SET_OVERRIDES || path.resolve('set-overrides.json');
}

export function emptySetOverrides(): SetOverridesStore {
  return { version: 1, overrides: {} };
}

export function formatKey(format: string): string {
  return speciesKey(format);
}

function reqString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} is required`);
  return v.trim();
}

function optString(v: unknown, field: string): string | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`${field} must be a string`);
  return v;
}

function intInRange(v: unknown, field: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) {
    throw new Error(`${field} must be an integer ${lo}–${hi}`);
  }
  return v;
}

function parseStringList(raw: unknown, field: string): string[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${field} must be an array of strings`);
  const out = raw.map((m, i) => {
    if (typeof m !== 'string' || !m.trim()) throw new Error(`${field}[${i}] must be a non-empty string`);
    return m.trim();
  });
  return out.length ? out : undefined;
}

function parseSpread(
  raw: unknown,
  field: 'evs' | 'ivs',
  hi: number,
): CanonicalSet['evs'] | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${field} must be an object`);
  const o = raw as Record<string, unknown>;
  const out: NonNullable<CanonicalSet['evs']> = {};
  for (const k of Object.keys(o)) {
    if (!STATS.includes(k as Stat)) throw new Error(`${field}.${k} is not a legal stat`);
    out[k as Stat] = intInRange(o[k], `${field}.${k}`, 0, hi);
  }
  return out;
}

export function validateCanonicalSet(raw: unknown, expectedSpecies?: string): CanonicalSet {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('set must be an object');
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!SET_KEYS.has(k)) throw new Error(`unknown set field ${k}`);
  }
  const species = reqString(o.species, 'species');
  if (expectedSpecies && speciesKey(species) !== speciesKey(expectedSpecies)) {
    throw new Error(`species ${species} does not match ${expectedSpecies}`);
  }
  let level = DEFAULT_LEVEL;
  if (o.level != null) {
    if (typeof o.level !== 'number' || !Number.isFinite(o.level) || o.level < 1 || o.level > 100) {
      throw new Error('level must be a finite number 1–100');
    }
    level = o.level;
  }
  if (o.item != null && typeof o.item !== 'string') throw new Error('item must be a string');
  const ability = reqString(o.ability, 'ability');
  const nature = typeof o.nature === 'string' && o.nature.trim() ? o.nature.trim() : DEFAULT_NATURE;
  if (!Array.isArray(o.moves)) throw new Error('moves must be an array of 1–4 non-empty names');
  const moves = o.moves.map((m, i) => {
    if (typeof m !== 'string' || !m.trim()) throw new Error(`moves[${i}] must be a non-empty string`);
    return m.trim();
  });
  if (moves.length < 1 || moves.length > 4) throw new Error('moves must contain 1–4 non-empty names');
  const teraTypes = parseStringList(o.teraTypes, 'teraTypes');
  const movePool = parseStringList(o.movePool, 'movePool');
  return {
    species,
    level,
    item: typeof o.item === 'string' ? o.item : '',
    ability,
    moves,
    nature,
    gender: optString(o.gender, 'gender'),
    teraType: optString(o.teraType, 'teraType'),
    teraTypes,
    role: optString(o.role, 'role'),
    movePool,
    evs: parseSpread(o.evs, 'evs', 252),
    ivs: parseSpread(o.ivs, 'ivs', 31),
  };
}

export function setIsComplete(set: CanonicalSet | undefined): boolean {
  if (!set) return false;
  try {
    validateCanonicalSet(set);
    return true;
  } catch {
    return false;
  }
}

/** Fill a public/manual set with observed item/ability/moves/level without dropping the rest of the set. */
export function overlayRevealedOnSet(set: CanonicalSet, facts: RevealedFacts): CanonicalSet {
  const id = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pool = set.movePool?.length ? set.movePool : set.moves;
  let moves = pickMoves(pool, facts.moves, 4);
  const have = new Set(moves.map(id));
  for (const m of facts.moves) {
    if (!m || have.has(id(m))) continue;
    if (moves.length < 4) {
      moves.push(m);
      have.add(id(m));
    } else {
      moves[3] = m;
      break;
    }
  }
  if (!moves.length) moves = [...set.moves];
  const level = facts.level && facts.level >= 1 && facts.level <= 100 ? facts.level : set.level;
  return {
    ...set,
    item: facts.item || set.item,
    ability: facts.ability || set.ability,
    level: level || set.level || DEFAULT_LEVEL,
    teraType: facts.teraType || set.teraType,
    moves,
    nature: set.nature?.trim() ? set.nature : DEFAULT_NATURE,
  };
}

function parseStore(raw: string): SetOverridesStore {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('set-overrides root must be an object');
  }
  const o = parsed as Record<string, unknown>;
  if (o.version !== 1) throw new Error('set-overrides version must be 1');
  if (!o.overrides || typeof o.overrides !== 'object' || Array.isArray(o.overrides)) {
    throw new Error('set-overrides.overrides must be an object');
  }
  const overrides: SetOverridesStore['overrides'] = {};
  for (const [fmtRaw, speciesMap] of Object.entries(o.overrides as Record<string, unknown>)) {
    const fmt = formatKey(fmtRaw);
    if (!fmt) continue;
    if (!speciesMap || typeof speciesMap !== 'object' || Array.isArray(speciesMap)) {
      throw new Error(`overrides.${fmtRaw} must be an object`);
    }
    overrides[fmt] = {};
    for (const [specRaw, set] of Object.entries(speciesMap as Record<string, unknown>)) {
      const spec = speciesKey(specRaw);
      if (!spec) continue;
      overrides[fmt][spec] = validateCanonicalSet(set, spec);
    }
  }
  return { version: 1, overrides };
}

interface ReadResult {
  store: SetOverridesStore;
  malformed: boolean;
}

function readStore(filePath: string): ReadResult {
  if (!fs.existsSync(filePath)) return { store: emptySetOverrides(), malformed: false };
  try {
    return { store: parseStore(fs.readFileSync(filePath, 'utf8')), malformed: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pokeredus] set-overrides: ignoring malformed file ${filePath}: ${msg}`);
    return { store: emptySetOverrides(), malformed: true };
  }
}

export function loadSetOverrides(filePath = defaultSetOverridesPath()): SetOverridesStore {
  return readStore(filePath).store;
}

export function getSetOverride(
  store: SetOverridesStore,
  format: string,
  species: string,
): CanonicalSet | undefined {
  return store.overrides[formatKey(format)]?.[speciesKey(species)];
}

function requireWritable(filePath: string): SetOverridesStore {
  const { store, malformed } = readStore(filePath);
  if (malformed) {
    throw new Error(`refusing to overwrite malformed set-overrides at ${filePath}; fix or delete the file`);
  }
  return store;
}

/** Windows-safe temp/backup/rename. Callers pass the final file body. */
export function atomicWriteFile(filePath: string, body: string): void {
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const bak = `${filePath}.bak`;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    // ponytail: Windows cannot atomic-replace; park the previous file then restore it if the new rename fails.
    if (fs.existsSync(filePath)) fs.renameSync(filePath, bak);
    fs.renameSync(tmp, filePath);
    try { fs.unlinkSync(bak); } catch { /* no previous file */ }
  } catch (err) {
    try { if (fs.existsSync(bak) && !fs.existsSync(filePath)) fs.renameSync(bak, filePath); } catch { /* keep original if possible */ }
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function atomicWrite(filePath: string, store: SetOverridesStore): void {
  atomicWriteFile(filePath, JSON.stringify(store, null, 2) + '\n');
}

export function saveSetOverride(
  format: string,
  species: string,
  raw: unknown,
  filePath = defaultSetOverridesPath(),
): CanonicalSet {
  const fmt = formatKey(format);
  const spec = speciesKey(species);
  if (!fmt || !spec) throw new Error('format and species are required');
  const set = validateCanonicalSet(raw, spec);
  const store = requireWritable(filePath);
  // ponytail: Random Battles do not contain duplicate species; move to room+slot assignments if another format needs them.
  store.overrides[fmt] ??= {};
  store.overrides[fmt][spec] = set;
  atomicWrite(filePath, store);
  return set;
}

export function deleteSetOverride(
  format: string,
  species: string,
  filePath = defaultSetOverridesPath(),
): void {
  const fmt = formatKey(format);
  const spec = speciesKey(species);
  if (!fmt || !spec) throw new Error('format and species are required');
  if (!fs.existsSync(filePath)) return;
  const store = requireWritable(filePath);
  const inner = store.overrides[fmt];
  if (!inner || !(spec in inner)) return;
  delete inner[spec];
  if (!Object.keys(inner).length) delete store.overrides[fmt];
  atomicWrite(filePath, store);
}

export function listSetCatalog(
  pool: RandomSetPool,
  format: string,
  species: string,
  store: SetOverridesStore,
  facts?: RevealedFacts,
): SetCatalog {
  const fmt = formatKey(format);
  const spec = speciesKey(species);
  if (!fmt || !spec) throw new Error('format and species are required');
  let candidates: SetCatalogRow[] = [];
  try {
    const factsFor = facts ?? { species: spec, moves: [] };
    candidates = hypothesesForSpecies(pool, spec)
      .map((h) => ({
        set: h.set,
        count: h.count,
        probability: h.probability,
        compatible: compatible(h.set, factsFor),
      }))
      .sort((a, b) => b.probability - a.probability || canonicalizeSet(a.set).localeCompare(canonicalizeSet(b.set)));
  } catch {
    candidates = [];
  }
  return { species: spec, format: fmt, override: getSetOverride(store, fmt, spec), candidates };
}

export function roleLabel(set: CanonicalSet): string {
  if (set.role) return set.role;
  const bits = [set.item, set.ability].filter(Boolean);
  return bits.length ? bits.join(' · ') : set.moves.slice(0, 2).join(' / ') || 'Set';
}

export function setOptionsFromPool(pool: RandomSetPool, species: string, facts?: RevealedFacts): SetOption[] {
  try {
    const factsFor = facts ?? { species, moves: [] };
    return hypothesesForSpecies(pool, species).map((h) => ({
      role: roleLabel(h.set),
      teraTypes: h.set.teraTypes?.length ? h.set.teraTypes : (h.set.teraType ? [h.set.teraType] : []),
      compatible: compatible(h.set, factsFor),
      set: h.set,
    }));
  } catch {
    return [];
  }
}
