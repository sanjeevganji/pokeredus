export class MatchupRelation {
  constructor(
    readonly set_a_id: string,
    readonly set_b_id: string,
    public score = 0,
    public confidence = 0.3,
    public sample_count = 0,
    public source = 'type_calc',
    public tags: string[] = [],
    public turns_to_kill_a = 0,
    public turns_to_kill_b = 0,
    public speed_advantage: 'a' | 'b' | 'tie' = 'tie',
    public best_move_a_id = '',
    public best_move_b_id = '',
    public damage_a_to_b = 0,
    public damage_b_to_a = 0,
    public effective_hp_a = 0,
    public effective_hp_b = 0,
    public min_damage_a_to_b = 0,
    public max_damage_a_to_b = 0,
    public min_damage_b_to_a = 0,
    public max_damage_b_to_a = 0,
    public damage_pct_a_to_b_lo = 0,
    public damage_pct_a_to_b_hi = 0,
    public damage_pct_b_to_a_lo = 0,
    public damage_pct_b_to_a_hi = 0,
    public min_ttk_a_to_b = 0,
    public max_ttk_a_to_b = 0,
    public min_ttk_b_to_a = 0,
    public max_ttk_b_to_a = 0,
  ) {}

  get isFavorable(): boolean { return this.score > 0.2; }
  get isUnfavorable(): boolean { return this.score < -0.2; }
  get isClose(): boolean { return this.score >= -0.2 && this.score <= 0.2; }

  get category(): string {
    if (this.score >= 0.6) return 'counter';
    if (this.score >= 0.3) return 'check';
    if (this.score > -0.3) return 'neutral';
    if (this.score > -0.6) return 'checked_by';
    return 'countered_by';
  }

  ttkLabel(ttk = this.turns_to_kill_a): string {
    if (ttk <= 0) return '—';
    if (ttk === 1) return 'OHKO';
    if (ttk <= 3) return `${ttk}HKO`;
    return `${ttk}HKO`;
  }

  toDict(): Record<string, unknown> {
    return {
      set_a_id: this.set_a_id, set_b_id: this.set_b_id,
      score: Math.round(this.score * 10000) / 10000,
      confidence: Math.round(this.confidence * 10000) / 10000,
      sample_count: this.sample_count, source: this.source, tags: [...this.tags],
      turns_to_kill_a: this.turns_to_kill_a, turns_to_kill_b: this.turns_to_kill_b,
      speed_advantage: this.speed_advantage,
      best_move_a_id: this.best_move_a_id, best_move_b_id: this.best_move_b_id,
      damage_a_to_b: this.damage_a_to_b, damage_b_to_a: this.damage_b_to_a,
      effective_hp_a: this.effective_hp_a, effective_hp_b: this.effective_hp_b,
      min_damage_a_to_b: this.min_damage_a_to_b, max_damage_a_to_b: this.max_damage_a_to_b,
      min_damage_b_to_a: this.min_damage_b_to_a, max_damage_b_to_a: this.max_damage_b_to_a,
      damage_pct_a_to_b_lo: Math.round(this.damage_pct_a_to_b_lo * 100) / 100,
      damage_pct_a_to_b_hi: Math.round(this.damage_pct_a_to_b_hi * 100) / 100,
      damage_pct_b_to_a_lo: Math.round(this.damage_pct_b_to_a_lo * 100) / 100,
      damage_pct_b_to_a_hi: Math.round(this.damage_pct_b_to_a_hi * 100) / 100,
      min_ttk_a_to_b: this.min_ttk_a_to_b, max_ttk_a_to_b: this.max_ttk_a_to_b,
      min_ttk_b_to_a: this.min_ttk_b_to_a, max_ttk_b_to_a: this.max_ttk_b_to_a,
    };
  }

  static fromDict(data: Record<string, unknown>): MatchupRelation {
    return new MatchupRelation(
      String(data.set_a_id), String(data.set_b_id),
      Number(data.score ?? 0), Number(data.confidence ?? 0.3),
      Number(data.sample_count ?? 0), String(data.source ?? 'type_calc'),
      (data.tags as string[]) ?? [],
      Number(data.turns_to_kill_a ?? 0), Number(data.turns_to_kill_b ?? 0),
      (data.speed_advantage as 'a' | 'b' | 'tie') ?? 'tie',
      String(data.best_move_a_id ?? ''), String(data.best_move_b_id ?? ''),
      Number(data.damage_a_to_b ?? 0), Number(data.damage_b_to_a ?? 0),
      Number(data.effective_hp_a ?? 0), Number(data.effective_hp_b ?? 0),
      Number(data.min_damage_a_to_b ?? 0), Number(data.max_damage_a_to_b ?? 0),
      Number(data.min_damage_b_to_a ?? 0), Number(data.max_damage_b_to_a ?? 0),
      Number(data.damage_pct_a_to_b_lo ?? 0), Number(data.damage_pct_a_to_b_hi ?? 0),
      Number(data.damage_pct_b_to_a_lo ?? 0), Number(data.damage_pct_b_to_a_hi ?? 0),
      Number(data.min_ttk_a_to_b ?? 0), Number(data.max_ttk_a_to_b ?? 0),
      Number(data.min_ttk_b_to_a ?? 0), Number(data.max_ttk_b_to_a ?? 0),
    );
  }
}
