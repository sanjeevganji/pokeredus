const ABBR: Record<string, string> = {
  hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe',
};

export class EVSpreadClass {
  constructor(
    public hp = 0,
    public atk = 0,
    public def = 0,
    public spa = 0,
    public spd = 0,
    public spe = 0,
    public label = '',
  ) {}

  get(stat: string): number {
    if (stat === 'def') return this.def;
    return (this as unknown as Record<string, number>)[stat] ?? 0;
  }

  asDict(): Record<string, number> {
    return { hp: this.hp, atk: this.atk, def: this.def, spa: this.spa, spd: this.spd, spe: this.spe };
  }

  validate(): string[] {
    const errors: string[] = [];
    const total = this.total;
    if (total > 508) errors.push(`Total EVs ${total} exceeds 508`);
    for (const [name, val] of Object.entries(this.asDict())) {
      if (val < 0) errors.push(`${name} EVs cannot be negative (${val})`);
      if (val > 252) errors.push(`${name} EVs exceeds 252 (${val})`);
    }
    return errors;
  }

  get is_valid(): boolean {
    return this.validate().length === 0;
  }

  get total(): number {
    return this.hp + this.atk + this.def + this.spa + this.spd + this.spe;
  }

  autoLabel(): string {
    const parts: string[] = [];
    for (const [stat, val] of Object.entries(this.asDict())) {
      if (val > 0) parts.push(`${val} ${ABBR[stat]}`);
    }
    return parts.length ? parts.join(' / ') : '0 EVs';
  }

  toDict(): Record<string, unknown> {
    return { ...this.asDict(), label: this.label || this.autoLabel() };
  }

  static fromDict(data: Record<string, unknown>): EVSpreadClass {
    return new EVSpreadClass(
      Number(data.hp ?? 0),
      Number(data.atk ?? 0),
      Number(data.def ?? data.def_ ?? 0),
      Number(data.spa ?? 0),
      Number(data.spd ?? 0),
      Number(data.spe ?? 0),
      String(data.label ?? ''),
    );
  }
}
