import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  deleteSetOverride,
  getSetOverride,
  listSetCatalog,
  loadSetOverrides,
  overlayRevealedOnSet,
  saveSetOverride,
  validateCanonicalSet,
} from '../src/set-overrides.js';
import type { RandomSetPool } from '../src/pool.js';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.tmp`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.${process.pid}.tmp`); } catch { /* ignore */ }
    try { fs.rmdirSync(`${f}.bak`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.bak`); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmp(): string {
  const p = path.join(os.tmpdir(), `set-overrides-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

const garchomp = {
  species: 'Garchomp',
  level: 80,
  item: 'Leftovers',
  ability: 'Rough Skin',
  moves: ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Stone Edge'],
  nature: 'Jolly',
  teraType: 'Steel',
};

describe('validateCanonicalSet', () => {
  it('rejects invalid level, moves, and EVs', () => {
    expect(() => validateCanonicalSet({ ...garchomp, level: 0 })).toThrow(/level/);
    expect(() => validateCanonicalSet({ ...garchomp, moves: [] })).toThrow(/moves/);
    expect(() => validateCanonicalSet({ ...garchomp, moves: ['eq', 'eq', 'eq', 'eq', 'eq'] })).toThrow(/moves/);
    expect(() => validateCanonicalSet({ ...garchomp, evs: { atk: 300 } })).toThrow(/evs\.atk/);
    expect(() => validateCanonicalSet({ ...garchomp, ivs: { spe: -1 } })).toThrow(/ivs\.spe/);
    expect(() => validateCanonicalSet({ ...garchomp, extra: 1 })).toThrow(/unknown set field/);
    expect(validateCanonicalSet({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] }).nature).toBe('Hardy');
    expect(validateCanonicalSet({ species: 'Garchomp', ability: 'Rough Skin', moves: ['Earthquake'] }).level).toBe(80);
  });

  it('requires the stored species to match the assignment', () => {
    expect(() => validateCanonicalSet(garchomp, 'toxapex')).toThrow(/does not match/);
    expect(validateCanonicalSet(garchomp, 'Garchomp').species).toBe('Garchomp');
  });
});

describe('set-overrides store', () => {
  it('round-trips a valid override and normalizes format/species keys', () => {
    const file = tmp();
    const saved = saveSetOverride('Gen9 Random Battle', 'Garchomp', garchomp, file);
    expect(saved.teraType).toBe('Steel');
    const store = loadSetOverrides(file);
    expect(getSetOverride(store, 'gen9randombattle', 'garchomp')?.item).toBe('Leftovers');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).overrides.gen9randombattle.garchomp.nature).toBe('Jolly');
  });

  it('falls back visibly on a truncated file without rewriting it', () => {
    const file = tmp();
    const truncated = '{"version":1,"overrides":';
    fs.writeFileSync(file, truncated, 'utf8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = loadSetOverrides(file);
    expect(store.overrides).toEqual({});
    expect(err).toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe(truncated);
    expect(() => saveSetOverride('gen9randombattle', 'garchomp', garchomp, file)).toThrow(/malformed/);
    expect(fs.readFileSync(file, 'utf8')).toBe(truncated);
  });

  it('keeps the previous file if rename fails', () => {
    const file = tmp();
    saveSetOverride('gen9randombattle', 'garchomp', garchomp, file);
    const before = fs.readFileSync(file, 'utf8');
    fs.mkdirSync(`${file}.bak`);
    expect(() => saveSetOverride('gen9randombattle', 'garchomp', { ...garchomp, item: 'Life Orb' }, file)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    fs.rmdirSync(`${file}.bak`);
  });

  it('does not use route text as a filename', () => {
    const file = tmp();
    saveSetOverride('gen9randombattle', '../secret', { ...garchomp, species: 'secret' }, file);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).overrides.gen9randombattle.secret.species).toBe('secret');
    const parent = path.dirname(file);
    expect(fs.existsSync(path.join(parent, 'secret'))).toBe(false);
    expect(fs.existsSync(path.join(parent, '..', 'secret'))).toBe(false);
  });

  it('DELETE removes only that format+species row', () => {
    const file = tmp();
    saveSetOverride('gen9randombattle', 'garchomp', garchomp, file);
    saveSetOverride('gen9randombattle', 'toxapex', {
      species: 'Toxapex', level: 80, item: 'Black Sludge', ability: 'Regenerator',
      moves: ['Recover'], nature: 'Bold',
    }, file);
    deleteSetOverride('gen9randombattle', 'garchomp', file);
    const store = loadSetOverrides(file);
    expect(getSetOverride(store, 'gen9randombattle', 'garchomp')).toBeUndefined();
    expect(getSetOverride(store, 'gen9randombattle', 'toxapex')?.ability).toBe('Regenerator');
  });
});

describe('listSetCatalog', () => {
  const pool: RandomSetPool = {
    format: 'gen9randombattle',
    version: 1,
    samples: 10,
    seed: 1,
    species: {
      garchomp: [
        {
          set: {
            species: 'Garchomp', level: 78, item: 'loadeddice', ability: 'roughskin',
            moves: ['earthquake', 'swordsdance', 'scaleshot', 'firefang'], nature: 'Jolly',
          },
          count: 7,
        },
        {
          set: {
            species: 'Garchomp', level: 78, item: 'choicescarf', ability: 'roughskin',
            moves: ['earthquake', 'outrage', 'stoneedge', 'firefang'], nature: 'Jolly',
          },
          count: 3,
        },
      ],
    },
  };

  it('returns all candidates sorted by pool frequency', () => {
    const file = tmp();
    saveSetOverride('gen9randombattle', 'garchomp', garchomp, file);
    const catalog = listSetCatalog(pool, 'gen9randombattle', 'garchomp', loadSetOverrides(file), {
      species: 'garchomp',
      moves: ['swordsdance'],
    });
    expect(catalog.candidates).toHaveLength(2);
    expect(catalog.candidates[0]?.probability).toBeCloseTo(0.7);
    expect(catalog.candidates[0]?.compatible).toBe(true);
    expect(catalog.candidates[1]?.compatible).toBe(false);
    expect(catalog.override?.item).toBe('Leftovers');
  });
});
