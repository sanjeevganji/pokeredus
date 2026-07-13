import type { PokemonClass } from '../classes/pokemon.js';
import type { SetClass } from '../classes/sets.js';

const PIVOT_OR_RECOVERY = new Set([
  'uturn', 'voltswitch', 'partingshot', 'roar', 'whirlwind',
  'recover', 'soft-boiled', 'roost', 'wish', 'protect',
]);

export function loadFormulas(): Record<string, unknown> {
  // ponytail: YAML formulas from Obsidian not wired in TS yet; return empty
  return {};
}

function normalize(val: number, lower: number, upper: number): number {
  if (upper === lower) return 0;
  return Math.max(0, Math.min(1, (val - lower) / (upper - lower)));
}

function calculateSectorScore(
  sectorName: string,
  data: Record<string, unknown>,
  formulas: Record<string, unknown>,
): number {
  const config = formulas[sectorName] as Record<string, unknown> | undefined;
  if (!config) return 0;

  const formula = String(config.formula ?? '0');
  const varsConfig = (config.vars ?? {}) as Record<string, { lower: number; upper: number }>;
  const scaleConfig = (config.scale ?? { lower: 0, upper: 100 }) as { lower: number; upper: number };

  const context: Record<string, number> = {};
  for (const [varName, bounds] of Object.entries(varsConfig)) {
    const rawVal = Number(data[varName] ?? 0);
    context[varName] = rawVal;
    context[`norm_${varName}`] = normalize(rawVal, bounds.lower, bounds.upper);
  }

  try {
    // ponytail: eval replaced with Function for formula strings from YAML
    const fn = new Function('len', 'max', 'min', 'abs', ...Object.keys(context), `return (${formula});`);
    const result = Number(fn(
      (x: unknown[]) => x.length, Math.max, Math.min, Math.abs,
      ...Object.keys(context).map((k) => context[k]),
    ));
    return Math.max(scaleConfig.lower, Math.min(scaleConfig.upper, result));
  } catch {
    return 0;
  }
}

export function computeAllScores(
  pokemon: PokemonClass,
  setObj: SetClass,
  formulas: Record<string, unknown>,
): Record<string, number> {
  const data: Record<string, unknown> = {
    hp: setObj.effectiveStat('hp', pokemon.base_stats, 100),
    atk: setObj.effectiveStat('atk', pokemon.base_stats, 100),
    def: setObj.effectiveStat('def', pokemon.base_stats, 100),
    spa: setObj.effectiveStat('spa', pokemon.base_stats, 100),
    spd: setObj.effectiveStat('spd', pokemon.base_stats, 100),
    spe: setObj.effectiveStat('spe', pokemon.base_stats, 100),
    eff_hp: setObj.effectiveStat('hp', pokemon.base_stats, 100),
    eff_atk: setObj.effectiveStat('atk', pokemon.base_stats, 100),
    eff_def: setObj.effectiveStat('def', pokemon.base_stats, 100),
    eff_spa: setObj.effectiveStat('spa', pokemon.base_stats, 100),
    eff_spd: setObj.effectiveStat('spd', pokemon.base_stats, 100),
    eff_spe: setObj.effectiveStat('spe', pokemon.base_stats, 100),
    bst: pokemon.bst,
    weight: pokemon.weight,
    is_legendary: pokemon.is_legendary ? 1 : 0,
    moves: setObj.moves,
  };

  const movesLow = new Set(setObj.moves.map((m) => m.toLowerCase()));
  data.support_moves = [...movesLow].filter((m) => PIVOT_OR_RECOVERY.has(m)).length;
  data.pivot_moves = data.support_moves;
  data.recovery_moves = data.support_moves;
  data.boost_moves = 0;
  data.priority_moves = 0;

  const sectors = ['attack', 'utility', 'defense', 'speed', 'threat', 'punish', 'sponge', 'counter'];
  const scores: Record<string, number> = {};
  for (const s of sectors) {
    scores[s] = calculateSectorScore(s, data, formulas);
  }
  return scores;
}

export function calculateCumulativeScore(scores: Record<string, number>): number {
  return Object.values(scores).reduce((a, b) => a + b, 0);
}
