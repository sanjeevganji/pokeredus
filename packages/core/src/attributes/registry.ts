import {
  Attribute, StatModifierAttribute, DamageModifierAttribute,
  SpeedModifierAttribute, ConditionAttribute, FieldAttribute,
  EventAttribute, ImmunityAttribute, RecoveryAttribute,
} from '../classes/attributes.js';

export class AttributeRegistry {
  private attributes: Attribute[] = [];
  private byType = new Map<string, Attribute[]>();
  private byName = new Map<string, Attribute>();
  private statCache = new Map<string, number>();
  private damageCache = new Map<string, number>();
  private speedCache: number | null = null;

  add(attribute: Attribute): void {
    const conflicts: [number, Attribute][] = [];
    for (let i = 0; i < this.attributes.length; i++) {
      const existing = this.attributes[i]!;
      if (!attribute.canStackWith(existing)) conflicts.push([i, existing]);
    }
    for (const [i, existing] of conflicts.reverse()) {
      const winner = existing.resolveConflict(attribute);
      if (winner === existing) return;
      if (winner === attribute) this.removeAtIndex(i);
    }
    this.attributes.push(attribute);
    this.indexAttribute(attribute);
    this.invalidateCache();
  }

  remove(opts: { name?: string; source?: string; attribute_type?: string; tag?: string } = {}): number {
    const toRemove: number[] = [];
    for (let i = 0; i < this.attributes.length; i++) {
      const attr = this.attributes[i]!;
      if (opts.name && attr.name === opts.name) toRemove.push(i);
      else if (opts.source && attr.source === opts.source) toRemove.push(i);
      else if (opts.attribute_type && attr.attribute_type === opts.attribute_type) toRemove.push(i);
      else if (opts.tag && attr.tags.includes(opts.tag)) toRemove.push(i);
    }
    for (const i of toRemove.reverse()) this.removeAtIndex(i);
    if (toRemove.length) this.invalidateCache();
    return toRemove.length;
  }

  private removeAtIndex(i: number): void {
    const attr = this.attributes[i]!;
    this.attributes.splice(i, 1);
    this.byName.delete(attr.name);
    const typeList = this.byType.get(attr.attribute_type);
    if (typeList) {
      const idx = typeList.indexOf(attr);
      if (idx >= 0) typeList.splice(idx, 1);
    }
  }

  private indexAttribute(attr: Attribute): void {
    this.byName.set(attr.name, attr);
    let typeList = this.byType.get(attr.attribute_type);
    if (!typeList) {
      typeList = [];
      this.byType.set(attr.attribute_type, typeList);
    }
    typeList.push(attr);
  }

  private invalidateCache(): void {
    this.statCache.clear();
    this.damageCache.clear();
    this.speedCache = null;
  }

  tick(): Attribute[] {
    const expired: Attribute[] = [];
    const active: Attribute[] = [];
    for (const attr of this.attributes) {
      if (attr.tick()) active.push(attr);
      else {
        attr.removal_reason = 'expired';
        expired.push(attr);
      }
    }
    if (expired.length) {
      this.attributes = active;
      this.rebuildIndexes();
      this.invalidateCache();
    }
    return expired;
  }

  private rebuildIndexes(): void {
    this.byType.clear();
    this.byName.clear();
    for (const attr of this.attributes) this.indexAttribute(attr);
  }

  get(opts: { attribute_type?: string; name?: string; tag?: string } = {}): Attribute[] {
    if (opts.name && this.byName.has(opts.name)) return [this.byName.get(opts.name)!];
    let results = opts.attribute_type
      ? [...(this.byType.get(opts.attribute_type) ?? [])]
      : [...this.attributes];
    if (opts.tag) {
      const tag = opts.tag;
      results = results.filter((a) => a.tags.includes(tag));
    }
    return results;
  }

  has(opts: { name?: string; condition?: string; field?: string } = {}): boolean {
    if (opts.name) return this.byName.has(opts.name);
    if (opts.condition) {
      return this.get({ attribute_type: 'condition' }).some(
        (a) => a instanceof ConditionAttribute && a.condition === opts.condition,
      );
    }
    if (opts.field) {
      return this.get({ attribute_type: 'field' }).some(
        (a) => a instanceof FieldAttribute && a.field === opts.field,
      );
    }
    return false;
  }

  clear(): void {
    this.attributes = [];
    this.byType.clear();
    this.byName.clear();
    this.invalidateCache();
  }

  getStatModifier(stat: string): number {
    if (this.statCache.has(stat)) return this.statCache.get(stat)!;
    let totalStages = 0;
    for (const attr of this.get({ attribute_type: 'stat_mod' })) {
      if (attr instanceof StatModifierAttribute && attr.stat === stat) {
        totalStages += attr.stages;
      }
    }
    const stages = Math.max(-6, Math.min(6, totalStages));
    const mult = stages >= 0 ? (2 + stages) / 2 : 2 / (2 - stages);
    this.statCache.set(stat, mult);
    return mult;
  }

  getDamageMultiplier(move?: { category?: string; type?: string }): number {
    const cacheKey = move?.category ?? 'all';
    if (this.damageCache.has(cacheKey)) return this.damageCache.get(cacheKey)!;
    let mult = 1;
    for (const attr of this.get({ attribute_type: 'damage_mod' })) {
      if (attr instanceof DamageModifierAttribute) {
        if (!move || attr.appliesToMove(move)) mult *= attr.multiplier;
      }
    }
    this.damageCache.set(cacheKey, mult);
    return mult;
  }

  getSpeedMultiplier(): number {
    if (this.speedCache !== null) return this.speedCache;
    let mult = 1;
    for (const attr of this.get({ attribute_type: 'speed_mod' })) {
      if (attr instanceof SpeedModifierAttribute) mult *= attr.multiplier;
    }
    this.speedCache = mult;
    return mult;
  }

  get count(): number { return this.attributes.length; }
  [Symbol.iterator](): Iterator<Attribute> { return this.attributes[Symbol.iterator](); }

  toDict(): Record<string, unknown> {
    return { attributes: this.attributes.map((a) => a.toDict()) };
  }

  static fromDict(data: { attributes?: Record<string, unknown>[] }): AttributeRegistry {
    const registry = new AttributeRegistry();
    for (const attrData of data.attributes ?? []) {
      registry.add(Attribute.fromDict(attrData));
    }
    return registry;
  }
}

export {
  Attribute, StatModifierAttribute, DamageModifierAttribute,
  SpeedModifierAttribute, ConditionAttribute, FieldAttribute,
  EventAttribute, ImmunityAttribute, RecoveryAttribute,
};
