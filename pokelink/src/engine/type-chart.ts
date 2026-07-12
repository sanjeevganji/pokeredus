// TypeChart — 18×18 type effectiveness lookup, ported verbatim from
// pokeredus/classes/types.py _OFFENSE dict.
// Last verified against Python: 2026-07-08.

// Only super-effective (2) and immunities (0) and resists (0.5) are listed;
// everything else defaults to 1.0 — same as the Python _build_chart().
const _OFFENSE: Record<string, Record<string, number>> = {
  Normal:   { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire:     { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water:    { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass:    { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5, Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice:      { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2, Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2, Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison:   { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground:   { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2, Steel: 2 },
  Flying:   { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic:  { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug:      { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2, Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock:     { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost:    { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon:   { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark:     { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel:    { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy:    { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

export const POKEMON_TYPES: string[] = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice',
  'Fighting', 'Poison', 'Ground', 'Flying', 'Psychic', 'Bug',
  'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
];

/** Full 18×18 chart, defaulting unspecified matchups to 1.0. */
export const TYPE_CHART: Record<string, Record<string, number>> = (() => {
  const chart: Record<string, Record<string, number>> = {};
  for (const atk of POKEMON_TYPES) {
    chart[atk] = {};
    for (const dfn of POKEMON_TYPES) {
      const v = _OFFENSE[atk]?.[dfn];
      chart[atk]![dfn] = v !== undefined ? v : 1.0;
    }
  }
  return chart;
})();

/**
 * Combined damage multiplier for `moveType` vs one or two defending types.
 * Mirrors get_effectiveness in types.py.
 */
export function getEffectiveness(moveType: string, defTypes: string[]): number {
  let mult = 1.0;
  for (const dt of defTypes) {
    const m = TYPE_CHART[moveType]?.[dt] ?? 1.0;
    mult *= m;
  }
  return mult;
}

/**
 * Best (attacking_type, multiplier) pair for the attacker vs the defender.
 * Mirrors get_best_effectiveness in types.py.
 */
export function getBestEffectiveness(
  attackerTypes: string[], defenderTypes: string[],
): [string, number] {
  if (attackerTypes.length === 0) return ['', 0];
  let bestType = attackerTypes[0]!;
  let bestMult = 0.0;
  for (const at of attackerTypes) {
    const m = getEffectiveness(at, defenderTypes);
    if (m > bestMult) { bestMult = m; bestType = at; }
  }
  return [bestType, bestMult];
}
