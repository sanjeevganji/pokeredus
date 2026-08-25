import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { handleSetsApi, parseSetsRoute } from '../../web/server/games.js';
import type { RandomSetPool } from '@pokeredus/engine';
import { saveSetOverride } from '@pokeredus/engine';

const tmpFiles: string[] = [];
afterEach(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.${process.pid}.tmp`); } catch { /* ignore */ }
    try { fs.unlinkSync(`${f}.bak`); } catch { /* ignore */ }
  }
  tmpFiles.length = 0;
});

function tmp(): string {
  const p = path.join(os.tmpdir(), `sets-api-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  tmpFiles.push(p);
  return p;
}

const poolPath = path.join(os.tmpdir(), `sets-pool-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);

beforeAll(() => {
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
  fs.writeFileSync(poolPath, JSON.stringify(pool), 'utf8');
});
afterAll(() => {
  try { fs.unlinkSync(poolPath); } catch { /* ignore */ }
});

const set = {
  species: 'Garchomp',
  level: 80,
  item: 'Leftovers',
  ability: 'Rough Skin',
  moves: ['Earthquake', 'Dragon Claw'],
  nature: 'Jolly',
  teraType: 'Steel',
};

describe('parseSetsRoute', () => {
  it('normalizes ids and rejects empty segments', () => {
    expect(parseSetsRoute('/api/games/sets/Gen9 Random Battle/Garchomp')).toEqual({
      format: 'gen9randombattle',
      species: 'garchomp',
    });
    expect(parseSetsRoute('/api/games/sets/gen9randombattle/' + encodeURIComponent('../secret'))).toEqual({
      format: 'gen9randombattle',
      species: 'secret',
    });
    expect(parseSetsRoute('/api/games/sets//garchomp')).toBeNull();
  });
});

describe('handleSetsApi', () => {
  it('GET returns candidates sorted by pool frequency', () => {
    const file = tmp();
    const out = handleSetsApi({
      method: 'GET',
      format: 'gen9randombattle',
      species: 'garchomp',
      overridesPath: file,
      poolPath,
    });
    expect(out.status).toBe(200);
    const body = out.body as { candidates: Array<{ probability: number; compatible: boolean }> };
    expect(body.candidates).toHaveLength(2);
    expect(body.candidates[0]!.probability).toBeCloseTo(0.7);
  });

  it('PUT validates and DELETE resets', () => {
    const file = tmp();
    const bad = handleSetsApi({
      method: 'PUT',
      format: 'gen9randombattle',
      species: 'garchomp',
      body: { set: { ...set, level: 0 } },
      overridesPath: file,
      poolPath,
    });
    expect(bad.status).toBe(400);

    const put = handleSetsApi({
      method: 'PUT',
      format: 'gen9randombattle',
      species: 'garchomp',
      body: { set },
      overridesPath: file,
      poolPath,
    });
    expect(put.status).toBe(200);
    expect((put.body as { set: { item: string } }).set.item).toBe('Leftovers');

    const got = handleSetsApi({
      method: 'GET', format: 'gen9randombattle', species: 'garchomp', overridesPath: file, poolPath,
    });
    expect((got.body as { override?: { item: string } }).override?.item).toBe('Leftovers');

    const del = handleSetsApi({
      method: 'DELETE', format: 'gen9randombattle', species: 'garchomp', overridesPath: file, poolPath,
    });
    expect(del.status).toBe(200);
    const after = handleSetsApi({
      method: 'GET', format: 'gen9randombattle', species: 'garchomp', overridesPath: file, poolPath,
    });
    expect((after.body as { override?: unknown }).override).toBeUndefined();
  });

  it('route text cannot escape the configured file', () => {
    const file = tmp();
    saveSetOverride('gen9randombattle', 'garchomp', set, file);
    const out = handleSetsApi({
      method: 'PUT',
      format: 'gen9randombattle',
      species: '../secret',
      body: { set: { ...set, species: 'secret' } },
      overridesPath: file,
      poolPath,
    });
    expect(out.status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.overrides.gen9randombattle.secret).toBeDefined();
    expect(parsed.overrides.gen9randombattle.garchomp).toBeDefined();
    expect(fs.existsSync(path.join(path.dirname(file), 'secret'))).toBe(false);
  });
});
