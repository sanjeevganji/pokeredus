import * as fs from 'node:fs';
import * as path from 'node:path';
import { speciesKey } from './pool.js';
import { repoRootFromEngine } from './policy.js';

export interface EffectValuation {
  multiplier: number;
  expectedTurns: number;
  probabilityOverride?: number;
}

export type ValuationKind = 'moves' | 'abilities' | 'items';

export interface EffectValuationRegistry {
  moves: Map<string, EffectValuation[]>;
  abilities: Map<string, EffectValuation[]>;
  items: Map<string, EffectValuation[]>;
}

export function emptyValuationRegistry(): EffectValuationRegistry {
  return { moves: new Map(), abilities: new Map(), items: new Map() };
}

function reqFinite(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${path} must be a finite number`);
  }
  return v;
}

export function parseValuation(raw: unknown, pathStr: string): EffectValuation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pathStr} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const multiplier = reqFinite(o.multiplier, `${pathStr}.multiplier`);
  if (!(multiplier > 0)) throw new Error(`${pathStr}.multiplier must be a finite number > 0`);
  const expectedTurns = reqFinite(o.expectedTurns, `${pathStr}.expectedTurns`);
  if (expectedTurns < 0 || expectedTurns > 32) {
    throw new Error(`${pathStr}.expectedTurns must be a finite number in [0, 32]`);
  }
  let probabilityOverride: number | undefined;
  if (o.probabilityOverride !== undefined) {
    probabilityOverride = reqFinite(o.probabilityOverride, `${pathStr}.probabilityOverride`);
    if (probabilityOverride < 0 || probabilityOverride > 1) {
      throw new Error(`${pathStr}.probabilityOverride must be a finite number in [0, 1]`);
    }
  }
  return { multiplier, expectedTurns, probabilityOverride };
}

function collectFromEntry(entry: unknown, pathStr: string): EffectValuation[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const o = entry as Record<string, unknown>;
  const out: EffectValuation[] = [];
  if (o.valuation !== undefined) out.push(parseValuation(o.valuation, `${pathStr}.valuation`));
  if (Array.isArray(o.effects)) {
    o.effects.forEach((sub, i) => {
      out.push(...collectFromEntry(sub, `${pathStr}.effects[${i}]`));
    });
  }
  return out;
}

export function parseEffectsFile(raw: unknown, kind: ValuationKind): Map<string, EffectValuation[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${kind} root must be an object`);
  }
  const root = raw as Record<string, unknown>;
  const bucket = root[kind];
  if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) {
    throw new Error(`${kind}.${kind} must be an object`);
  }
  const out = new Map<string, EffectValuation[]>();
  for (const [idRaw, entry] of Object.entries(bucket as Record<string, unknown>)) {
    const id = speciesKey(idRaw);
    if (!id) continue;
    out.set(id, collectFromEntry(entry, `${kind}.${idRaw}`));
  }
  return out;
}

export function defaultEffectsDir(): string {
  return path.join(repoRootFromEngine(), 'pokeredus', 'data', 'effects');
}

export function loadEffectValuations(dir = defaultEffectsDir()): EffectValuationRegistry {
  const read = (kind: ValuationKind) => {
    const fp = path.join(dir, `${kind}.json`);
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as unknown;
    return parseEffectsFile(raw, kind);
  };
  return { moves: read('moves'), abilities: read('abilities'), items: read('items') };
}

let cached: EffectValuationRegistry | null = null;

export function loadDefaultValuations(): EffectValuationRegistry {
  cached ??= loadEffectValuations();
  return cached;
}

export function lookupValuations(
  reg: EffectValuationRegistry,
  kind: ValuationKind,
  id: string,
): EffectValuation[] {
  return reg[kind].get(speciesKey(id)) ?? [];
}

/** Neutral when absent. Diagnostic names the missing id. */
export function valuationOrNeutral(
  reg: EffectValuationRegistry,
  kind: ValuationKind,
  id: string,
): { valuations: EffectValuation[]; coverage?: string } {
  const key = speciesKey(id);
  if (!key) return { valuations: [] };
  if (reg[kind].has(key)) return { valuations: reg[kind].get(key) ?? [] };
  return { valuations: [], coverage: `${kind}.${key}` };
}

/** Use branch occurrence mass XOR metadata probability, never both. */
export function onceProbability(branchOccurred: boolean, metadata?: number): number {
  if (branchOccurred) return 1;
  if (metadata != null && Number.isFinite(metadata)) return clamp01(metadata);
  return 1;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
