export class AbilityClass {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly description = '',
    readonly flags: string[] = [],
  ) {}

  toDict(): Record<string, unknown> {
    return { id: this.id, name: this.name, description: this.description, flags: [...this.flags] };
  }

  static fromDict(data: Record<string, unknown>): AbilityClass {
    return new AbilityClass(
      String(data.id), String(data.name),
      String(data.description ?? ''), (data.flags as string[]) ?? [],
    );
  }
}
