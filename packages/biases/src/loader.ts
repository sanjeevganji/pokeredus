import * as fs from 'node:fs';
import { BiasesSchema, type Biases } from './schema.js';
import { DEFAULT_BIASES } from './defaults.js';

export function loadBiases(path?: string): Biases {
  if (!path) return DEFAULT_BIASES;
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    console.warn(`[biases] file not found at ${path} — using defaults`);
    return DEFAULT_BIASES;
  }
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    reportOverrides(parsed);
  }
  return BiasesSchema.parse(parsed);
}

function reportOverrides(parsed: Record<string, unknown>): void {
  const overrides: string[] = [];
  for (const k of Object.keys(DEFAULT_BIASES) as (keyof Biases)[]) {
    const pv = (parsed as Record<string, unknown>)[k];
    if (pv !== undefined && pv !== DEFAULT_BIASES[k]) {
      overrides.push(`${k}: ${JSON.stringify(DEFAULT_BIASES[k])} -> ${JSON.stringify(pv)}`);
    }
  }
  if (overrides.length > 0) {
    console.warn(`[biases] overrides:\n  ` + overrides.join('\n  '));
  }
}
