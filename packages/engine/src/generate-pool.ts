/** Convert an integer into a Showdown gen5 PRNG seed string. */
export function prngSeedFromInt(n: number): string {
  return `${n >>> 0},${(n * 1103515245 + 12345) >>> 0},${(n * 1664525 + 1013904223) >>> 0},${(n * 214013 + 2531011) >>> 0}`;
}
