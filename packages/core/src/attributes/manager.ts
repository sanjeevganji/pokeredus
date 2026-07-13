import * as fs from 'node:fs';
import * as path from 'node:path';

export class AttributeDefinition {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: string,
    readonly description = '',
    readonly params: Record<string, unknown> = {},
    readonly tags: string[] = [],
  ) {}

  toDict(): Record<string, unknown> {
    return {
      id: this.id, name: this.name, type: this.type,
      description: this.description, params: { ...this.params }, tags: [...this.tags],
    };
  }

  static fromDict(data: Record<string, unknown>): AttributeDefinition {
    return new AttributeDefinition(
      String(data.id), String(data.name), String(data.type),
      String(data.description ?? ''),
      (data.params as Record<string, unknown>) ?? {},
      (data.tags as string[]) ?? [],
    );
  }
}

export class AttributeManager {
  itemAttributes = new Map<string, AttributeDefinition[]>();
  abilityAttributes = new Map<string, AttributeDefinition[]>();
  moveAttributes = new Map<string, AttributeDefinition[]>();

  constructor(readonly dataDir: string) {
    this.loadAll();
  }

  private effectsDir(): string {
    const dir = path.join(this.dataDir, 'effects');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private loadAll(): void {
    this.loadCategory('items', this.itemAttributes);
    this.loadCategory('abilities', this.abilityAttributes);
    this.loadCategory('moves', this.moveAttributes);
  }

  private loadCategory(category: string, registry: Map<string, AttributeDefinition[]>): void {
    const filePath = path.join(this.effectsDir(), `${category}_attributes.json`);
    if (!fs.existsSync(filePath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, Record<string, unknown>[]>;
      for (const [entityId, attrs] of Object.entries(data)) {
        registry.set(entityId, attrs.map((a) => AttributeDefinition.fromDict(a)));
      }
    } catch {
      // ponytail: skip corrupt files
    }
  }

  private saveCategory(category: string, registry: Map<string, AttributeDefinition[]>): void {
    const data: Record<string, Record<string, unknown>[]> = {};
    for (const [entityId, attrs] of registry) {
      data[entityId] = attrs.map((a) => a.toDict());
    }
    fs.writeFileSync(
      path.join(this.effectsDir(), `${category}_attributes.json`),
      JSON.stringify(data, null, 2),
      'utf8',
    );
  }

  getItemAttributes(itemId: string): AttributeDefinition[] {
    return this.itemAttributes.get(itemId) ?? [];
  }

  setItemAttributes(itemId: string, attributes: AttributeDefinition[]): void {
    if (attributes.length) this.itemAttributes.set(itemId, attributes);
    else this.itemAttributes.delete(itemId);
    this.saveCategory('items', this.itemAttributes);
  }

  getAbilityAttributes(abilityId: string): AttributeDefinition[] {
    return this.abilityAttributes.get(abilityId) ?? [];
  }

  getMoveAttributes(moveId: string): AttributeDefinition[] {
    return this.moveAttributes.get(moveId) ?? [];
  }
}
