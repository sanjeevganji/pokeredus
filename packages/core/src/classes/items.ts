export class ItemClass {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly description = '',
    readonly consumed = false,
  ) {}

  toDict(): Record<string, unknown> {
    return { id: this.id, name: this.name, description: this.description, consumed: this.consumed };
  }

  static fromDict(data: Record<string, unknown>): ItemClass {
    return new ItemClass(
      String(data.id), String(data.name),
      String(data.description ?? ''), Boolean(data.consumed),
    );
  }
}
