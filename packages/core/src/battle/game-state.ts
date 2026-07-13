import { AttributeRegistry } from '../attributes/registry.js';
import {
  Attribute, ConditionAttribute, FieldAttribute,
} from '../classes/attributes.js';

export class PokemonState {
  pokemon_id: string;
  set_id: string;
  current_hp = 0;
  max_hp = 0;
  attributes = new AttributeRegistry();
  moves_used: Record<string, number> = {};
  disabled_moves = new Set<string>();
  pp_remaining: Record<string, number> = {};
  is_active = false;
  turns_active = 0;
  last_move_used = '';

  constructor(pokemonId: string, setId: string) {
    this.pokemon_id = pokemonId;
    this.set_id = setId;
  }

  get hpPercent(): number {
    return this.max_hp === 0 ? 0 : (this.current_hp / this.max_hp) * 100;
  }

  get isFainted(): boolean { return this.current_hp <= 0; }

  useMove(moveId: string): void {
    this.moves_used[moveId] = (this.moves_used[moveId] ?? 0) + 1;
    this.last_move_used = moveId;
  }

  takeDamage(damage: number): number {
    const actual = Math.min(damage, this.current_hp);
    this.current_hp -= actual;
    return actual;
  }

  heal(amount: number): number {
    const actual = Math.min(amount, this.max_hp - this.current_hp);
    this.current_hp += actual;
    return actual;
  }

  hasStatus(): boolean {
    return ['burn', 'paralysis', 'poison', 'toxic', 'sleep', 'freeze']
      .some((c) => this.attributes.has({ condition: c }));
  }

  hasCondition(condition: string): boolean {
    return this.attributes.has({ condition });
  }

  getStatMultiplier(stat: string): number {
    let totalStages = 0;
    for (const attr of this.attributes.get({ attribute_type: 'stat_mod' })) {
      if (attr.params.stat === stat) totalStages += Number(attr.params.stages ?? 0);
    }
    const stages = Math.max(-6, Math.min(6, totalStages));
    return stages >= 0 ? (2 + stages) / 2 : 2 / (2 - stages);
  }

  getSpeed(baseSpeed: number): number {
    let speedMult = this.getStatMultiplier('spe');
    if (this.hasCondition('paralysis')) speedMult *= 0.5;
    speedMult *= this.attributes.getSpeedMultiplier();
    return Math.max(1, Math.floor(baseSpeed * speedMult));
  }

  applyStatus(condition: string): boolean {
    if (this.hasStatus()) return false;
    const damageMap: Record<string, number> = {
      burn: 1 / 16, poison: 1 / 8, toxic: 1 / 16,
    };
    this.attributes.add(new ConditionAttribute({
      attribute_type: 'condition', name: condition, source: 'manual',
      params: { condition, damage_per_turn: damageMap[condition] ?? 0 },
      tags: ['status', condition],
    }));
    return true;
  }

  tick(): Attribute[] {
    this.turns_active++;
    const expired = this.attributes.tick();
    for (const cond of this.attributes.get({ attribute_type: 'condition' })) {
      if (cond instanceof ConditionAttribute && cond.damagePerTurn > 0) {
        this.takeDamage(Math.floor(this.max_hp * cond.damagePerTurn));
      }
    }
    return expired;
  }

  switchIn(): void {
    this.is_active = true;
    this.turns_active = 0;
    this.attributes.remove({ tag: 'volatile' });
  }

  switchOut(): void {
    this.is_active = false;
    this.attributes.remove({ tag: 'volatile' });
    this.attributes.remove({ attribute_type: 'stat_mod' });
  }

  toDict(): Record<string, unknown> {
    return {
      pokemon_id: this.pokemon_id, set_id: this.set_id,
      current_hp: this.current_hp, max_hp: this.max_hp,
      attributes: this.attributes.toDict(),
      moves_used: { ...this.moves_used },
      disabled_moves: [...this.disabled_moves],
      pp_remaining: { ...this.pp_remaining },
      is_active: this.is_active, turns_active: this.turns_active,
      last_move_used: this.last_move_used,
    };
  }

  static fromDict(data: Record<string, unknown>): PokemonState {
    const ps = new PokemonState(String(data.pokemon_id), String(data.set_id));
    ps.current_hp = Number(data.current_hp ?? 0);
    ps.max_hp = Number(data.max_hp ?? 0);
    ps.attributes = AttributeRegistry.fromDict((data.attributes ?? { attributes: [] }) as { attributes?: Record<string, unknown>[] });
    ps.moves_used = (data.moves_used as Record<string, number>) ?? {};
    ps.disabled_moves = new Set((data.disabled_moves as string[]) ?? []);
    ps.pp_remaining = (data.pp_remaining as Record<string, number>) ?? {};
    ps.is_active = Boolean(data.is_active);
    ps.turns_active = Number(data.turns_active ?? 0);
    ps.last_move_used = String(data.last_move_used ?? '');
    return ps;
  }

  clone(): PokemonState {
    return PokemonState.fromDict(this.toDict());
  }
}

export class FieldState {
  side_a_attributes = new AttributeRegistry();
  side_b_attributes = new AttributeRegistry();
  global_attributes = new AttributeRegistry();

  getSideAttributes(side: 'a' | 'b'): AttributeRegistry {
    return side === 'a' ? this.side_a_attributes : this.side_b_attributes;
  }

  hasHazard(hazard: string, side: 'a' | 'b'): boolean {
    return this.getSideAttributes(side).has({ field: hazard });
  }

  hasScreen(screen: string, side: 'a' | 'b'): boolean {
    return this.getSideAttributes(side).has({ field: screen });
  }

  getWeather(): string | null {
    for (const attr of this.global_attributes.get({ attribute_type: 'field' })) {
      if (attr instanceof FieldAttribute && FieldAttribute.WEATHER_TYPES.has(attr.field)) {
        return attr.field;
      }
    }
    return null;
  }

  tick(): Attribute[] {
    return [
      ...this.side_a_attributes.tick(),
      ...this.side_b_attributes.tick(),
      ...this.global_attributes.tick(),
    ];
  }

  toDict(): Record<string, unknown> {
    return {
      side_a_attributes: this.side_a_attributes.toDict(),
      side_b_attributes: this.side_b_attributes.toDict(),
      global_attributes: this.global_attributes.toDict(),
    };
  }

  static fromDict(data: Record<string, unknown>): FieldState {
    const fs = new FieldState();
    fs.side_a_attributes = AttributeRegistry.fromDict((data.side_a_attributes ?? { attributes: [] }) as { attributes?: Record<string, unknown>[] });
    fs.side_b_attributes = AttributeRegistry.fromDict((data.side_b_attributes ?? { attributes: [] }) as { attributes?: Record<string, unknown>[] });
    fs.global_attributes = AttributeRegistry.fromDict((data.global_attributes ?? { attributes: [] }) as { attributes?: Record<string, unknown>[] });
    return fs;
  }

  clone(): FieldState {
    return FieldState.fromDict(this.toDict());
  }
}

export class GameState {
  team_a: PokemonState[] = [];
  team_b: PokemonState[] = [];
  field = new FieldState();
  turn = 0;
  active_a = 0;
  active_b = 0;
  trick_room = false;

  getActivePokemon(side: 'a' | 'b'): PokemonState | undefined {
    const team = side === 'a' ? this.team_a : this.team_b;
    const idx = side === 'a' ? this.active_a : this.active_b;
    return team[idx];
  }

  getOpponent(side: 'a' | 'b'): PokemonState | undefined {
    return this.getActivePokemon(side === 'a' ? 'b' : 'a');
  }

  getTurnOrder(baseSpeeds?: Record<string, number>): [string, number][] {
    const order: [string, number][] = [];
    for (const side of ['a', 'b'] as const) {
      const active = this.getActivePokemon(side);
      if (active && !active.isFainted) {
        const speed = baseSpeeds?.[side]
          ? active.getSpeed(baseSpeeds[side]!)
          : 0;
        order.push([side, speed]);
      } else {
        order.push([side, -1]);
      }
    }
    order.sort((a, b) => this.trick_room ? a[1] - b[1] : b[1] - a[1]);
    return order;
  }

  switchPokemon(side: 'a' | 'b', index: number): boolean {
    const team = side === 'a' ? this.team_a : this.team_b;
    if (index < 0 || index >= team.length || team[index]!.isFainted) return false;
    const activeIdx = side === 'a' ? this.active_a : this.active_b;
    if (team[activeIdx]) team[activeIdx]!.switchOut();
    if (side === 'a') this.active_a = index;
    else this.active_b = index;
    team[index]!.switchIn();
    return true;
  }

  tick(): Record<string, Attribute[]> {
    this.turn++;
    const expired: Record<string, Attribute[]> = { team_a: [], team_b: [], field: [] };
    for (const p of this.team_a) if (!p.isFainted) expired.team_a!.push(...p.tick());
    for (const p of this.team_b) if (!p.isFainted) expired.team_b!.push(...p.tick());
    expired.field!.push(...this.field.tick());
    if (this.trick_room && this.turn % 5 === 0) this.trick_room = false;
    return expired;
  }

  isBattleOver(): [boolean, string | null] {
    const aAlive = this.team_a.some((p) => !p.isFainted);
    const bAlive = this.team_b.some((p) => !p.isFainted);
    if (!aAlive && !bAlive) return [true, null];
    if (!aAlive) return [true, 'b'];
    if (!bAlive) return [true, 'a'];
    return [false, null];
  }

  countAlive(side: 'a' | 'b'): number {
    const team = side === 'a' ? this.team_a : this.team_b;
    return team.filter((p) => !p.isFainted).length;
  }

  toDict(): Record<string, unknown> {
    return {
      team_a: this.team_a.map((p) => p.toDict()),
      team_b: this.team_b.map((p) => p.toDict()),
      field: this.field.toDict(),
      turn: this.turn, active_a: this.active_a, active_b: this.active_b,
      trick_room: this.trick_room,
    };
  }

  static fromDict(data: Record<string, unknown>): GameState {
    const gs = new GameState();
    gs.team_a = ((data.team_a as Record<string, unknown>[]) ?? []).map((p) => PokemonState.fromDict(p));
    gs.team_b = ((data.team_b as Record<string, unknown>[]) ?? []).map((p) => PokemonState.fromDict(p));
    gs.field = FieldState.fromDict((data.field ?? {}) as Record<string, unknown>);
    gs.turn = Number(data.turn ?? 0);
    gs.active_a = Number(data.active_a ?? 0);
    gs.active_b = Number(data.active_b ?? 0);
    gs.trick_room = Boolean(data.trick_room);
    return gs;
  }

  clone(): GameState {
    return GameState.fromDict(this.toDict());
  }
}
