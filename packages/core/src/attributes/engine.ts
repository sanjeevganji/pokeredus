export const COMPOUND_NAMES = ['counter', 'sponge', 'threat', 'punish'] as const;
export const BASE_NAMES = ['attack', 'utility', 'defense', 'speed'] as const;

export const MOVE_ROLE_BOOSTS: Record<string, [Set<string>, number]> = {
  threat: [new Set(['swordsdance', 'nastyplot', 'calm-mind', 'dragondance', 'bulkup', 'quiverdance', 'shellsmash', 'workup']), 0.5],
  punish: [new Set(['uturn', 'voltswitch', 'partingshot', 'whirlwind', 'roar', 'dragontail', 'circlethrow', 'batonpass']), 0.4],
  sponge: [new Set(['recover', 'softboiled', 'roost', 'wish', 'protect']), 0.3],
  counter: [new Set(['extremespeed', 'suckerpunch', 'aquajet', 'bulletpunch', 'machpunch', 'shadowsneak', 'quickattack']), 0.4],
};

export class AttributeTuning {
  axis_attack = 100;
  axis_utility = 100;
  axis_defense = 100;
  axis_speed = 100;
  compound_counter = 100;
  compound_sponge = 100;
  compound_threat = 100;
  compound_punish = 100;
  k_base: [number, number, number, number] = [100, 100, 100, 100];
  p_base: [number, number, number, number] = [1, 1, 1, 1];
  k_compound: [number, number, number, number] = [100, 100, 100, 100];
  p_compound: [number, number, number, number] = [1, 1, 1, 1];

  asDict(): Record<string, unknown> {
    return {
      axis_attack: this.axis_attack, axis_utility: this.axis_utility,
      axis_defense: this.axis_defense, axis_speed: this.axis_speed,
      compound_counter: this.compound_counter, compound_sponge: this.compound_sponge,
      compound_threat: this.compound_threat, compound_punish: this.compound_punish,
      k_base: [...this.k_base], p_base: [...this.p_base],
      k_compound: [...this.k_compound], p_compound: [...this.p_compound],
    };
  }
}

export function polynomialScale(raw: number, k = 1, p = 1): number {
  const safeK = Math.max(k, 1e-9);
  const z = Math.pow(Math.max(raw, 0) / safeK, p);
  return 100 * z / (1 + z);
}

/** basePerType: 4 rows × 18 cols → 8 rows × 18 cols scaled 0-100 */
export function computeAttributes(
  basePerType: number[][],
  tuning: AttributeTuning | null = null,
  moves: string[] | null = null,
): number[][] {
  const t = tuning ?? new AttributeTuning();
  if (basePerType.length !== 4 || basePerType[0]?.length !== 18) {
    throw new Error(`expected (4,18), got (${basePerType.length},${basePerType[0]?.length})`);
  }

  const A = basePerType[0]!;
  const U = basePerType[1]!;
  const D = basePerType[2]!;
  const S = basePerType[3]!;

  const counter = A.map((v, i) => (t.axis_attack * v + t.axis_defense * D[i]!) * t.compound_counter);
  const sponge = U.map((v, i) => (t.axis_utility * v + t.axis_defense * D[i]!) * t.compound_sponge);
  const threat = A.map((v, i) => (t.axis_attack * v + t.axis_speed * S[i]!) * t.compound_threat);
  const punish = U.map((v, i) => (t.axis_utility * v + t.axis_speed * S[i]!) * t.compound_punish);

  if (moves) {
    const low = new Set(moves.map((m) => m.toLowerCase()));
    for (const [cname, [tagSet, boost]] of Object.entries(MOVE_ROLE_BOOSTS)) {
      const hits = [...low].filter((m) => tagSet.has(m));
      if (!hits.length) continue;
      const n = hits.length;
      const target = cname === 'counter' ? counter : cname === 'sponge' ? sponge : cname === 'threat' ? threat : punish;
      for (let i = 0; i < 18; i++) target[i]! += boost * n;
    }
  }

  const raw: number[][] = [
    basePerType[0]!, threat, basePerType[3]!, punish,
    basePerType[1]!, sponge, basePerType[2]!, counter,
  ];

  const out: number[][] = raw.map((row) => [...row]);
  for (let i = 0; i < 4; i++) {
    out[i] = raw[i]!.map((v) => polynomialScale(v, t.k_base[i]!, t.p_base[i]!));
  }
  for (let i = 0; i < 4; i++) {
    out[4 + i] = raw[4 + i]!.map((v) => polynomialScale(v, t.k_compound[i]!, t.p_compound[i]!));
  }
  return out;
}

export function volumeOfTuned(attributes8x18: number[][], bias = 1): number {
  const C = 7; const G = 5; const T = 1; const P = 3;
  let sum = 0;
  for (let i = 0; i < 18; i++) {
    sum += attributes8x18[C]![i]! * attributes8x18[G]![i]!
      + attributes8x18[T]![i]! * attributes8x18[P]![i]!;
  }
  return sum * bias;
}
