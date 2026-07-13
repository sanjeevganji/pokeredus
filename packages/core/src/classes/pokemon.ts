export const PARADOX_POKEMON = new Set([
  'great-tusk', 'scream-tail', 'brute-bonnet', 'flutter-mane',
  'slither-wing', 'sandy-shocks', 'roaring-moon', 'iron-valiant',
  'iron-hands', 'iron-bundle', 'iron-moth', 'iron-thorns',
  'iron-jugulis', 'iron-leaves', 'iron-boulder', 'iron-crown',
  'walking-wake', 'gouging-fire', 'raging-bolt',
  'iron-treads',
]);

export const LEGENDARY_POKEMON = new Set([
  'articuno', 'zapdos', 'moltres', 'mewtwo',
  'raikou', 'entei', 'suicune', 'lugia', 'ho-oh',
  'regirock', 'regice', 'registeel', 'latias', 'latios',
  'kyogre', 'groudon', 'rayquaza',
  'uxie', 'mesprit', 'azelf', 'dialga', 'palkia', 'giratina',
  'heatran', 'regigigas', 'cresselia',
  'cobalion', 'terrakion', 'virizion', 'tornadus', 'thundurus',
  'landorus', 'reshiram', 'zekrom', 'kyurem',
  'xerneas', 'yveltal', 'zygarde',
  'tapu-koko', 'tapu-lele', 'tapu-bulu', 'tapu-fini',
  'cosmog', 'cosmoem', 'solgaleo', 'lunala', 'necrozma',
  'zacian', 'zamazenta', 'eternatus', 'calyrex',
  'koraidon', 'miraidon', 'terapagos',
  'mew', 'celebi', 'jirachi', 'deoxys', 'deoxys-speed',
  'deoxys-attack', 'deoxys-defense',
  'darkrai', 'shaymin', 'arceus',
  'victini', 'keldeo', 'meloetta', 'genesect',
  'diancie', 'hoopa', 'volcanion',
  'magearna', 'marshadow', 'zeraora',
  'meltan', 'melmetal',
  'zarude', 'enamorus', 'enamorus-incarnate', 'enamorus-therian',
  'pecharunt',
]);

export const PSEUDO_LEGENDARY = new Set([
  'dragonite', 'tyranitar', 'salamence', 'metagross',
  'garchomp', 'hydreigon', 'goodra', 'goodra-hisui',
  'kommo-o', 'dragapult', 'baxcalibur',
]);

export interface BaseStats {
  hp: number; atk: number; def: number; spa: number; spd: number; spe: number;
}

export class PokemonClass {
  id: string;
  name: string;
  types: string[];
  base_stats: BaseStats;
  abilities: string[];
  weight: number;
  tier: string;
  is_mega: boolean;
  is_paradox: boolean;
  is_legendary: boolean;
  is_pseudo: boolean;
  api_name: string;
  primary_set_id: string;

  constructor(opts: {
    id: string;
    name: string;
    types?: string[];
    base_stats?: Partial<BaseStats>;
    abilities?: string[];
    weight?: number;
    tier?: string;
    is_mega?: boolean;
    is_paradox?: boolean;
    is_legendary?: boolean;
    is_pseudo?: boolean;
    api_name?: string;
    primary_set_id?: string;
  }) {
    this.id = opts.id;
    this.name = opts.name;
    this.types = opts.types ?? [];
    this.base_stats = {
      hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0,
      ...opts.base_stats,
    };
    this.abilities = opts.abilities ?? [];
    this.weight = opts.weight ?? 0;
    this.tier = opts.tier ?? 'OU';
    this.is_mega = opts.is_mega ?? false;
    this.is_paradox = opts.is_paradox ?? false;
    this.is_legendary = opts.is_legendary ?? false;
    this.is_pseudo = opts.is_pseudo ?? false;
    this.api_name = opts.api_name || opts.id;
    this.primary_set_id = opts.primary_set_id ?? '';

    if (!this.is_mega && !this.is_paradox && !this.is_legendary && !this.is_pseudo) {
      if (PARADOX_POKEMON.has(this.id)) this.is_paradox = true;
      if (LEGENDARY_POKEMON.has(this.id)) this.is_legendary = true;
      if (PSEUDO_LEGENDARY.has(this.id)) this.is_pseudo = true;
      if (this.id.includes('-mega')) this.is_mega = true;
    }
  }

  baseStat(stat: string): number {
    return (this.base_stats as unknown as Record<string, number>)[stat] ?? 0;
  }

  get bst(): number {
    return Object.values(this.base_stats).reduce((a, b) => a + b, 0);
  }

  get base_speed(): number {
    return this.base_stats.spe;
  }

  hasType(typeName: string): boolean {
    return this.types.includes(typeName);
  }

  get typeString(): string {
    return this.types.length ? this.types.join('/') : '???';
  }

  get classification(): string {
    const tags: string[] = [];
    if (this.is_mega) tags.push('Mega');
    if (this.is_paradox) tags.push('Paradox');
    if (this.is_legendary) tags.push('Legendary');
    if (this.is_pseudo) tags.push('Pseudo');
    return tags.join(' · ');
  }

  get hasClassification(): boolean {
    return this.is_mega || this.is_paradox || this.is_legendary || this.is_pseudo;
  }

  toDict(): Record<string, unknown> {
    return {
      id: this.id, name: this.name, types: [...this.types],
      base_stats: { ...this.base_stats }, abilities: [...this.abilities],
      weight: this.weight, tier: this.tier,
      is_mega: this.is_mega, is_paradox: this.is_paradox,
      is_legendary: this.is_legendary, is_pseudo: this.is_pseudo,
      api_name: this.api_name, primary_set_id: this.primary_set_id,
    };
  }

  static fromDict(data: Record<string, unknown>): PokemonClass {
    return new PokemonClass({
      id: String(data.id),
      name: String(data.name),
      types: (data.types as string[]) ?? [],
      base_stats: (data.base_stats as Partial<BaseStats>) ?? {},
      abilities: (data.abilities as string[]) ?? [],
      weight: Number(data.weight ?? 0),
      tier: String(data.tier ?? 'OU'),
      is_mega: Boolean(data.is_mega),
      is_paradox: Boolean(data.is_paradox),
      is_legendary: Boolean(data.is_legendary),
      is_pseudo: Boolean(data.is_pseudo),
      api_name: String(data.api_name ?? ''),
      primary_set_id: String(data.primary_set_id ?? ''),
    });
  }
}
