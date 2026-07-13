export class MoveClass {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: string,
    readonly category: string,
    readonly base_power = 0,
    readonly accuracy: number | boolean = 100,
    readonly priority = 0,
    readonly pp = 10,
    readonly target = 'normal',
    readonly flags: string[] = [],
    readonly secondary_effects: Record<string, unknown>[] = [],
  ) {}

  get is_status(): boolean { return this.category === 'Status'; }
  get is_physical(): boolean { return this.category === 'Physical'; }
  get is_special(): boolean { return this.category === 'Special'; }
  get is_contact(): boolean { return this.flags.includes('contact'); }
  get has_perfect_accuracy(): boolean {
    return this.accuracy === true || (typeof this.accuracy === 'number' && (this.accuracy === 0 || this.accuracy >= 100));
  }

  toDict(): Record<string, unknown> {
    return {
      id: this.id, name: this.name, type: this.type, category: this.category,
      base_power: this.base_power, accuracy: this.accuracy, priority: this.priority,
      pp: this.pp, target: this.target, flags: [...this.flags],
      secondary_effects: this.secondary_effects.map((s) => ({ ...s })),
    };
  }

  static fromDict(data: Record<string, unknown>): MoveClass {
    return new MoveClass(
      String(data.id), String(data.name), String(data.type), String(data.category),
      Number(data.base_power ?? 0),
      (data.accuracy as number | boolean) ?? 100,
      Number(data.priority ?? 0),
      Number(data.pp ?? 10),
      String(data.target ?? 'normal'),
      (data.flags as string[]) ?? [],
      (data.secondary_effects as Record<string, unknown>[]) ?? [],
    );
  }
}
