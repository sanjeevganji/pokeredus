// loadBiases — read a biases JSON file or fall back to defaults.
// Zod's schema defaults fill in any missing keys so partial files are valid.
import * as fs from 'node:fs';
import { BiasesSchema, type Biases } from './schema.js';
import { DEFAULT_BIASES } from './defaults.js';

/**
 * Load biases from `path`. If no path, returns DEFAULT_BIASES verbatim (no I/O).
 * If the file is missing, falls back to defaults and prints a notice.
 * Partial files are merged (zod .default() fills gaps). Bad weights throw.
 */
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

/** Print which keys differ from the in-code defaults (human tuning audit trail). */
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
