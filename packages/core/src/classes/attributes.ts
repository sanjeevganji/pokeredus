export const ATTRIBUTE_TYPES = [
  'stat_mod', 'damage_mod', 'speed_mod', 'condition', 'field', 'event', 'immunity', 'recovery',
] as const;

export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];

export interface AttributeData {
  attribute_type: string;
  name: string;
  source: string;
  duration?: number | null;
  turns_remaining?: number | null;
  applied_turn?: number;
  removal_reason?: string;
  priority?: number;
  tags?: string[];
  params?: Record<string, unknown>;
  metrics?: Record<string, number>;
}

const TYPE_MAP = new Map<string, typeof Attribute>();

export class Attribute {
  attribute_type: string;
  name: string;
  source: string;
  duration: number | null;
  turns_remaining: number | null;
  applied_turn: number;
  removal_reason: string;
  priority: number;
  tags: string[];
  params: Record<string, unknown>;
  metrics: Record<string, number>;

  constructor(data: AttributeData) {
    this.attribute_type = data.attribute_type;
    this.name = data.name;
    this.source = data.source;
    this.duration = data.duration ?? null;
    this.turns_remaining = data.turns_remaining ?? (data.duration ?? null);
    this.applied_turn = data.applied_turn ?? 0;
    this.removal_reason = data.removal_reason ?? '';
    this.priority = data.priority ?? 0;
    this.tags = data.tags ?? [];
    this.params = data.params ?? {};
    this.metrics = data.metrics ?? {};
  }

  tick(): boolean {
    if (this.duration === null) return true;
    if (this.turns_remaining === null) return true;
    this.turns_remaining -= 1;
    return this.turns_remaining > 0;
  }

  get isExpired(): boolean {
    return this.duration !== null && this.turns_remaining !== null && this.turns_remaining <= 0;
  }

  get isPermanent(): boolean { return this.duration === null; }

  canStackWith(other: Attribute): boolean {
    if (this.attribute_type !== other.attribute_type) return true;
    return this.source !== other.source;
  }

  resolveConflict(other: Attribute): Attribute {
    if (this.priority > other.priority) return this;
    if (other.priority > this.priority) return other;
    return other;
  }

  hasTag(tag: string): boolean { return this.tags.includes(tag); }

  toDict(): Record<string, unknown> {
    return {
      attribute_type: this.attribute_type, name: this.name, source: this.source,
      duration: this.duration, turns_remaining: this.turns_remaining,
      applied_turn: this.applied_turn, removal_reason: this.removal_reason,
      priority: this.priority, tags: [...this.tags],
      params: { ...this.params }, metrics: { ...this.metrics },
    };
  }

  static fromDict(data: Record<string, unknown>): Attribute {
    const type = String(data.attribute_type ?? '');
    const Cls = TYPE_MAP.get(type) ?? Attribute;
    return new Cls(data as unknown as AttributeData);
  }
}

export class StatModifierAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'stat_mod' });
  }

  get stat(): string { return String(this.params.stat ?? ''); }
  get stages(): number { return Number(this.params.stages ?? 0); }
  get target(): string { return String(this.params.target ?? 'self'); }

  getMultiplier(): number {
    const stages = Math.max(-6, Math.min(6, this.stages));
    return stages >= 0 ? (2 + stages) / 2 : 2 / (2 - stages);
  }

  canStackWith(other: Attribute): boolean {
    if (!(other instanceof StatModifierAttribute)) return true;
    if (this.stat !== other.stat) return true;
    return this.source !== other.source;
  }

  resolveConflict(): Attribute { return this; }
}

export class DamageModifierAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'damage_mod' });
  }

  get multiplier(): number { return Number(this.params.multiplier ?? 1); }
  get appliesTo(): string { return String(this.params.applies_to ?? 'all'); }

  appliesToMove(move: { category?: string; type?: string }): boolean {
    if (this.appliesTo === 'physical' && move.category !== 'Physical') return false;
    if (this.appliesTo === 'special' && move.category !== 'Special') return false;
    const moveType = this.params.move_type;
    if (moveType && move.type !== moveType) return false;
    return true;
  }
}

export class SpeedModifierAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'speed_mod' });
  }

  get multiplier(): number { return Number(this.params.multiplier ?? 1); }

  canStackWith(other: Attribute): boolean {
    if (other instanceof SpeedModifierAttribute && this.source === other.source) return false;
    return true;
  }
}

export class ConditionAttribute extends Attribute {
  static readonly NON_VOLATILE = new Set(['burn', 'paralysis', 'poison', 'toxic', 'sleep', 'freeze']);

  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'condition' });
  }

  get condition(): string { return String(this.params.condition ?? ''); }
  get damagePerTurn(): number { return Number(this.params.damage_per_turn ?? 0); }

  canStackWith(other: Attribute): boolean {
    if (!(other instanceof ConditionAttribute)) return true;
    if (this.condition === other.condition) return false;
    if (ConditionAttribute.NON_VOLATILE.has(this.condition) && ConditionAttribute.NON_VOLATILE.has(other.condition)) {
      return false;
    }
    return true;
  }

  resolveConflict(other: Attribute): Attribute {
    return this;
  }
}

export class FieldAttribute extends Attribute {
  static readonly WEATHER_TYPES = new Set(['sun', 'rain', 'sand', 'hail', 'snow']);
  static readonly TERRAIN_TYPES = new Set(['electric_terrain', 'grassy_terrain', 'misty_terrain', 'psychic_terrain']);

  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'field' });
  }

  get field(): string { return String(this.params.field ?? ''); }
  get side(): string { return String(this.params.side ?? 'global'); }
  get layers(): number { return Number(this.params.layers ?? 1); }

  resolveConflict(other: Attribute): Attribute {
    if (!(other instanceof FieldAttribute)) return other;
    if (this.field === 'spikes' && other.field === 'spikes') {
      other.params.layers = Math.min(3, this.layers + other.layers);
      return other;
    }
    return other;
  }
}

export class EventAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'event' });
  }

  get event(): string { return String(this.params.event ?? ''); }
  get chance(): number { return Number(this.params.chance ?? 1); }
}

export class ImmunityAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'immunity' });
  }

  get immuneTo(): string[] {
    const val = this.params.immune_to;
    if (typeof val === 'string') return [val];
    return (val as string[]) ?? [];
  }

  blocks(moveType = '', moveId = ''): boolean {
    return this.immuneTo.some((t) => t === moveType || t === moveId);
  }
}

export class RecoveryAttribute extends Attribute {
  constructor(data: AttributeData) {
    super({ ...data, attribute_type: 'recovery' });
  }

  get amountFraction(): number { return Number(this.params.amount_fraction ?? 0); }
  get trigger(): string { return String(this.params.trigger ?? 'turn_end'); }
}

TYPE_MAP.set('stat_mod', StatModifierAttribute);
TYPE_MAP.set('damage_mod', DamageModifierAttribute);
TYPE_MAP.set('speed_mod', SpeedModifierAttribute);
TYPE_MAP.set('condition', ConditionAttribute);
TYPE_MAP.set('field', FieldAttribute);
TYPE_MAP.set('event', EventAttribute);
TYPE_MAP.set('immunity', ImmunityAttribute);
TYPE_MAP.set('recovery', RecoveryAttribute);

export function registerAttributeType(typeName: string, cls: typeof Attribute): void {
  TYPE_MAP.set(typeName, cls);
}

export function getAttributeClass(typeName: string): typeof Attribute {
  return TYPE_MAP.get(typeName) ?? Attribute;
}
