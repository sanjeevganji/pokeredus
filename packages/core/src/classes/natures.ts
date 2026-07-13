export class NatureClass {
  constructor(
    readonly name: string,
    readonly increased_stat: string | null = null,
    readonly decreased_stat: string | null = null,
  ) {}

  get id(): string {
    return this.name.toLowerCase();
  }

  get is_neutral(): boolean {
    return this.increased_stat === null && this.decreased_stat === null;
  }

  modifier(stat: string): number {
    if (stat === this.increased_stat) return 1.1;
    if (stat === this.decreased_stat) return 0.9;
    return 1.0;
  }

  toDict(): Record<string, unknown> {
    return {
      name: this.name,
      increased_stat: this.increased_stat,
      decreased_stat: this.decreased_stat,
    };
  }

  static fromDict(data: { name: string; increased_stat?: string | null; decreased_stat?: string | null }): NatureClass {
    return new NatureClass(data.name, data.increased_stat ?? null, data.decreased_stat ?? null);
  }
}

export const STANDARD_NATURES: NatureClass[] = [
  new NatureClass('Hardy'),
  new NatureClass('Lonely', 'atk', 'def'),
  new NatureClass('Adamant', 'atk', 'spa'),
  new NatureClass('Naughty', 'atk', 'spd'),
  new NatureClass('Brave', 'atk', 'spe'),
  new NatureClass('Bold', 'def', 'atk'),
  new NatureClass('Docile'),
  new NatureClass('Impish', 'def', 'spa'),
  new NatureClass('Lax', 'def', 'spd'),
  new NatureClass('Relaxed', 'def', 'spe'),
  new NatureClass('Modest', 'spa', 'atk'),
  new NatureClass('Mild', 'spa', 'def'),
  new NatureClass('Bashful'),
  new NatureClass('Rash', 'spa', 'spd'),
  new NatureClass('Quiet', 'spa', 'spe'),
  new NatureClass('Calm', 'spd', 'atk'),
  new NatureClass('Gentle', 'spd', 'def'),
  new NatureClass('Careful', 'spd', 'spa'),
  new NatureClass('Quirky'),
  new NatureClass('Sassy', 'spd', 'spe'),
  new NatureClass('Timid', 'spe', 'atk'),
  new NatureClass('Hasty', 'spe', 'def'),
  new NatureClass('Jolly', 'spe', 'spa'),
  new NatureClass('Naive', 'spe', 'spd'),
  new NatureClass('Serious'),
];
