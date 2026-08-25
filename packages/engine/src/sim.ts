import { createRequire } from 'node:module';
import type { BattleObservation, CanonicalSet, FieldSnapshot, LegalAction, PlayerSide, SlotSnapshot } from './observation.js';
import { normalizeTerrain, normalizeWeather, placeholderSet, showdownTerrain, showdownWeather } from './observation.js';
import { modifiersFromSlot } from './math.js';
import { simChoice } from './actions.js';

const require = createRequire(import.meta.url);

type AnyField = {
  weather?: string | { id?: string };
  terrain?: string | { id?: string };
  pseudoWeather?: Record<string, unknown>;
  setWeather?: (s: string, source?: unknown) => unknown;
  clearWeather?: () => unknown;
  setTerrain?: (s: string, source?: unknown) => unknown;
  clearTerrain?: () => unknown;
  addPseudoWeather?: (s: string, source?: unknown) => unknown;
  removePseudoWeather?: (s: string) => unknown;
};

type AnyBattle = {
  toJSON?: () => unknown;
  p1: AnySide;
  p2: AnySide;
  ended?: boolean;
  winner?: string | null;
  field?: AnyField;
  log?: string[];
  makeChoices: (c1: string, c2: string) => void;
  setPlayer: (slot: 'p1' | 'p2', opts: { name: string; team: string }) => void;
};

type AnySide = {
  pokemon: AnyPokemon[];
  active: AnyPokemon[];
  requestState?: string;
  sideConditions?: Record<string, { layers?: number; levels?: number; duration?: number } | unknown>;
  addSideCondition?: (s: string, source?: unknown) => unknown;
  removeSideCondition?: (s: string) => unknown;
};

type AnyPokemon = {
  hp: number;
  maxhp: number;
  fainted: boolean;
  status: string;
  boosts: Record<string, number>;
  item?: string;
  ability?: string;
  moveSlots?: Array<{ id: string; pp: number; disabled?: boolean }>;
  isActive?: boolean;
  species?: { id: string };
  sethp?: (s: string | number) => void;
};

type PSModule = {
  Battle: new (opts: { formatid: string; seed?: number[] }) => AnyBattle;
  BattleStream?: unknown;
  Teams: { pack: (team: unknown[]) => string; generate?: (format: string, opts?: { seed?: string }) => unknown[] };
  Dex?: { species: { get: (id: string) => { name: string } } };
};

let psMod: PSModule | null = null;

export function loadShowdown(): PSModule {
  if (psMod) return psMod;
  try {
    psMod = require('pokemon-showdown') as PSModule;
  } catch (err) {
    throw new Error(`pokemon-showdown is required for one-round simulation: ${String(err)}`);
  }
  if (typeof psMod.Battle !== 'function') {
    throw new Error('pinned pokemon-showdown does not export Battle');
  }
  return psMod;
}

function toPackedSet(set: CanonicalSet): Record<string, unknown> {
  return {
    species: set.species,
    item: set.item || undefined,
    ability: set.ability || undefined,
    moves: set.moves.length ? set.moves : ['splash'],
    nature: set.nature || 'Hardy',
    level: set.level || 100,
    gender: set.gender,
    teraType: set.teraType,
    evs: set.evs,
    ivs: set.ivs,
  };
}

function slotSet(slot: SlotSnapshot): CanonicalSet {
  if (slot.set) return slot.set;
  const hyp = slot.hypotheses[0]?.set;
  if (hyp) return hyp;
  return placeholderSet();
}

export function packObservation(obs: BattleObservation, theirOverride?: CanonicalSet[]): [string, string] {
  const PS = loadShowdown();
  const ours = obs.ours.map((s) => toPackedSet(s.set ?? placeholderSet()));
  const theirs = (theirOverride ?? obs.theirs.map(slotSet)).map(toPackedSet);
  while (ours.length < 6) ours.push(toPackedSet(placeholderSet()));
  while (theirs.length < 6) theirs.push(toPackedSet(placeholderSet()));
  return [PS.Teams.pack(ours) ?? '', PS.Teams.pack(theirs) ?? ''];
}

function applyHp(battle: AnyBattle, obs: BattleObservation): void {
  const mapSide = (mons: AnyPokemon[], slots: SlotSnapshot[]) => {
    for (let i = 0; i < Math.min(mons.length, slots.length); i++) {
      const p = mons[i]!;
      const s = slots[i]!;
      if (s.maxHp > 0 && typeof p.sethp === 'function') {
        const pct = s.fainted ? 0 : Math.max(0, Math.round((s.hp / s.maxHp) * 100));
        p.sethp(`${pct}/100`);
      } else if (s.maxHp > 0) {
        p.hp = s.fainted ? 0 : Math.max(1, Math.round((s.hp / s.maxHp) * p.maxhp));
      }
      p.boosts.atk = s.boosts.atk;
      p.boosts.def = s.boosts.def;
      p.boosts.spa = s.boosts.spa;
      p.boosts.spd = s.boosts.spd;
      p.boosts.spe = s.boosts.spe;
      if (s.status && s.status !== 'fnt') p.status = s.status;
    }
  };
  const ours = obs.ourSide === 'p1' ? battle.p1.pokemon : battle.p2.pokemon;
  const theirs = obs.ourSide === 'p1' ? battle.p2.pokemon : battle.p1.pokemon;
  mapSide(ours, obs.ours);
  mapSide(theirs, obs.theirs);
}

function requireFn(obj: object | undefined, name: string, label: string): (a: string, b?: unknown) => unknown {
  const fn = obj && (obj as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(`pinned pokemon-showdown is missing ${label} (needed to restore the observed field)`);
  }
  return fn as (a: string, b?: unknown) => unknown;
}

function setCondDuration(side: AnySide, id: string, turns: number): void {
  const sc = side.sideConditions?.[id];
  if (sc && typeof sc === 'object' && turns > 0) {
    (sc as { duration?: number }).duration = turns;
  }
}

function setCondLayers(side: AnySide, id: string, layers: number): void {
  const sc = side.sideConditions?.[id];
  if (sc && typeof sc === 'object' && layers > 0) {
    (sc as { layers?: number }).layers = layers;
  }
}

function applySideField(side: AnySide, hazards: FieldSnapshot['hazards_p1'], reflect: number, lightscreen: number, label: string): void {
  const add = requireFn(side, 'addSideCondition', `${label}.addSideCondition`);
  if (hazards.stealthrock) add('stealthrock', 'debug');
  if (hazards.spikes > 0) {
    add('spikes', 'debug');
    setCondLayers(side, 'spikes', hazards.spikes);
  }
  if (hazards.toxicspikes > 0) {
    add('toxicspikes', 'debug');
    setCondLayers(side, 'toxicspikes', hazards.toxicspikes);
  }
  if (hazards.stickyweb) add('stickyweb', 'debug');
  if (reflect > 0) {
    add('reflect', 'debug');
    setCondDuration(side, 'reflect', reflect);
  }
  if (lightscreen > 0) {
    add('lightscreen', 'debug');
    setCondDuration(side, 'lightscreen', lightscreen);
  }
}

function applyField(battle: AnyBattle, field: FieldSnapshot): void {
  const f = battle.field;
  if (!f) throw new Error('pinned pokemon-showdown Battle is missing field');
  const weather = showdownWeather(field.weather);
  if (weather) requireFn(f, 'setWeather', 'field.setWeather')(weather, 'debug');
  else if (idOf(f.weather) && typeof f.clearWeather === 'function') f.clearWeather();
  const terrain = showdownTerrain(field.terrain);
  if (terrain) requireFn(f, 'setTerrain', 'field.setTerrain')(terrain, 'debug');
  else if (idOf(f.terrain) && typeof f.clearTerrain === 'function') f.clearTerrain();
  const hasTR = Boolean(f.pseudoWeather && ('trickroom' in f.pseudoWeather));
  if (field.trickroom && !hasTR) requireFn(f, 'addPseudoWeather', 'field.addPseudoWeather')('trickroom', 'debug');
  else if (!field.trickroom && hasTR && typeof f.removePseudoWeather === 'function') f.removePseudoWeather('trickroom');
  applySideField(battle.p1, field.hazards_p1, field.reflect_p1, field.lightscreen_p1, 'p1');
  applySideField(battle.p2, field.hazards_p2, field.reflect_p2, field.lightscreen_p2, 'p2');
}

export function cloneBattle(battle: AnyBattle): AnyBattle {
  const PS = loadShowdown();
  if (typeof battle.toJSON !== 'function') {
    throw new Error('pinned pokemon-showdown Battle cannot serialize (missing toJSON)');
  }
  const data = battle.toJSON();
  const fromJSON = (PS.Battle as unknown as { fromJSON?: (d: unknown) => AnyBattle }).fromJSON;
  if (typeof fromJSON !== 'function') {
    throw new Error('pinned pokemon-showdown Battle cannot clone (missing Battle.fromJSON)');
  }
  return fromJSON(data);
}

export type EffectKind = 'damage' | 'heal' | 'boost' | 'unboost' | 'status' | 'recoil' | 'drain' | 'hazard' | 'residual';

export interface ActionEffect {
  kind: EffectKind;
  side: PlayerSide;
  attributed: boolean;
  hpBefore?: number;
  hpAfter?: number;
  maxHp?: number;
  stat?: string;
  amount?: number;
  status?: string;
  from?: string;
}

export interface ActionTelemetry {
  announced: boolean;
  first: boolean;
  missed: boolean;
  failed: boolean;
  executed: boolean;
  hit: boolean;
  aliveAtExecution: boolean;
  effects: ActionEffect[];
}

export interface RoundSimResult {
  afterOurs: SlotSnapshot[];
  afterTheirs: SlotSnapshot[];
  afterField: FieldSnapshot;
  pHit: number;
  pExecute: number;
  aliveAtExecution: number;
  weWin: boolean;
  theyWin: boolean;
  ours: ActionTelemetry;
  theirs: ActionTelemetry;
}

function condLayers(sc: AnySide['sideConditions'], name: string): number {
  const v = sc?.[name];
  if (!v) return 0;
  if (typeof v === 'object') {
    const o = v as { layers?: number; levels?: number };
    if (typeof o.layers === 'number') return o.layers;
    if (typeof o.levels === 'number') return o.levels;
    return 1;
  }
  return 1;
}

function condDuration(sc: AnySide['sideConditions'], name: string): number {
  const v = sc?.[name];
  if (!v) return 0;
  if (typeof v === 'object') {
    const d = (v as { duration?: number }).duration;
    if (typeof d === 'number' && d > 0) return d;
  }
  return condLayers(sc, name) > 0 ? 1 : 0;
}

function idOf(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v && 'id' in v) return String((v as { id?: string }).id ?? '');
  return String(v);
}

function snapshotField(battle: AnyBattle, prev: FieldSnapshot): FieldSnapshot {
  const p1 = battle.p1.sideConditions;
  const p2 = battle.p2.sideConditions;
  const weather = normalizeWeather(idOf(battle.field?.weather)) || prev.weather;
  const terrain = normalizeTerrain(idOf(battle.field?.terrain)) || prev.terrain;
  const trickroom = Boolean(battle.field?.pseudoWeather && 'trickroom' in battle.field.pseudoWeather);
  return {
    weather,
    terrain,
    trickroom,
    hazards_p1: {
      stealthrock: condLayers(p1, 'stealthrock') > 0,
      spikes: condLayers(p1, 'spikes'),
      toxicspikes: condLayers(p1, 'toxicspikes'),
      stickyweb: condLayers(p1, 'stickyweb') > 0,
    },
    hazards_p2: {
      stealthrock: condLayers(p2, 'stealthrock') > 0,
      spikes: condLayers(p2, 'spikes'),
      toxicspikes: condLayers(p2, 'toxicspikes'),
      stickyweb: condLayers(p2, 'stickyweb') > 0,
    },
    reflect_p1: condDuration(p1, 'reflect'),
    reflect_p2: condDuration(p2, 'reflect'),
    lightscreen_p1: condDuration(p1, 'lightscreen'),
    lightscreen_p2: condDuration(p2, 'lightscreen'),
  };
}

function snapshotSide(mons: AnyPokemon[], prev: SlotSnapshot[], weather: string): SlotSnapshot[] {
  return prev.map((slot, i) => {
    const p = mons[i];
    if (!p) return { ...slot, modifiers: modifiersFromSlot(slot, weather) };
    const fainted = Boolean(p.fainted) || p.hp <= 0;
    const next: SlotSnapshot = {
      ...slot,
      hp: fainted ? 0 : p.hp,
      maxHp: p.maxhp || slot.maxHp,
      fainted,
      status: fainted ? 'fnt' : (p.status || ''),
      boosts: {
        atk: p.boosts.atk ?? 0,
        def: p.boosts.def ?? 0,
        spa: p.boosts.spa ?? 0,
        spd: p.boosts.spd ?? 0,
        spe: p.boosts.spe ?? 0,
        accuracy: p.boosts.accuracy ?? 0,
        evasion: p.boosts.evasion ?? 0,
      },
      active: Boolean(p.isActive),
    };
    next.modifiers = modifiersFromSlot(next, weather);
    return next;
  });
}

export function createBattle(obs: BattleObservation, seed: number[], theirSets?: CanonicalSet[]): AnyBattle {
  const PS = loadShowdown();
  const [t1, t2] = packObservation(obs, theirSets);
  const battle = new PS.Battle({ formatid: 'gen9customgame', seed });
  const p1Team = obs.ourSide === 'p1' ? t1 : t2;
  const p2Team = obs.ourSide === 'p1' ? t2 : t1;
  battle.setPlayer('p1', { name: 'p1', team: p1Team });
  battle.setPlayer('p2', { name: 'p2', team: p2Team });
  if (battle.p1.requestState === 'teampreview' || battle.p2.requestState === 'teampreview') {
    battle.makeChoices('default', 'default');
  }
  applyField(battle, obs.field);
  applyHp(battle, obs);
  return battle;
}

function emptyTel(): ActionTelemetry {
  return {
    announced: false, first: false, missed: false, failed: false,
    executed: false, hit: false, aliveAtExecution: false, effects: [],
  };
}

function toId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sideOf(ident: string): PlayerSide {
  return ident.trim().startsWith('p1') ? 'p1' : 'p2';
}

function parseHp(cond: string): { hp: number; maxHp: number } {
  const part = (cond ?? '').trim().split(' ')[0] ?? '';
  const [a, b] = part.split('/');
  const hp = Number(a);
  const maxHp = Number(b);
  return { hp: Number.isFinite(hp) ? hp : 0, maxHp: Number.isFinite(maxHp) && maxHp > 0 ? maxHp : 0 };
}

function fromTag(line: string): string {
  const m = /\[from\]\s*([^|\[]+)/i.exec(line);
  return (m?.[1] ?? '').trim().toLowerCase();
}

function residualFrom(from: string): boolean {
  if (!from) return false;
  if (from.startsWith('item:') || from.startsWith('ability:')) return true;
  if (/stealth rock|spikes|sticky web|toxic spikes/.test(from)) return true;
  if (/sandstorm|hail|leftovers|black sludge/.test(from)) return true;
  if (from === 'psn' || from === 'tox' || from === 'brn' || from === 'slp') return true;
  return false;
}

function flattenLog(log: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < log.length; i++) {
    const line = log[i]!;
    if (line.startsWith('|split|')) {
      const secret = log[i + 1] ?? '';
      const shared = log[i + 2] ?? '';
      i += 2;
      out.push(secret || shared);
      continue;
    }
    out.push(line);
  }
  return out;
}

function parseRoundLog(raw: string[], ourSide: PlayerSide): { ours: ActionTelemetry; theirs: ActionTelemetry } {
  const ours = emptyTel();
  const theirs = emptyTel();
  const tel = (side: PlayerSide) => (side === ourSide ? ours : theirs);
  let current: PlayerSide | null = null;
  let first: PlayerSide | null = null;
  const lastHp: Record<string, number> = {};

  const noteActor = (side: PlayerSide) => {
    if (!first) {
      first = side;
      tel(side).first = true;
    }
    current = side;
  };

  for (const line of flattenLog(raw)) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|');
    const cmd = parts[1];
    if (cmd === 'upkeep' || cmd === 'turn') {
      current = null;
      continue;
    }
    if (cmd === 'move') {
      const side = sideOf(parts[2] ?? '');
      noteActor(side);
      const t = tel(side);
      t.announced = true;
      t.executed = true;
      t.aliveAtExecution = true;
      if (/\[miss\]/i.test(line)) t.missed = true;
      continue;
    }
    if (cmd === 'switch' || cmd === 'drag') {
      noteActor(sideOf(parts[2] ?? ''));
      continue;
    }
    if (cmd === 'cant') {
      const side = sideOf(parts[2] ?? '');
      const t = tel(side);
      t.aliveAtExecution = true;
      t.executed = false;
      continue;
    }
    if (cmd === '-miss') {
      const side = sideOf(parts[2] ?? '');
      tel(side).missed = true;
      continue;
    }
    if (cmd === '-fail' || cmd === '-immune' || cmd === '-notarget' || cmd === '-block') {
      if (current) tel(current).failed = true;
      continue;
    }
    if (cmd === '-damage' || cmd === '-heal' || cmd === '-sethp') {
      const ident = parts[2] ?? '';
      const side = sideOf(ident);
      const { hp, maxHp } = parseHp(parts[3] ?? '');
      const prev = lastHp[ident] ?? hp;
      lastHp[ident] = hp;
      const from = fromTag(line);
      const residual = residualFrom(from);
      let kind: EffectKind = cmd === '-heal' ? 'heal' : 'damage';
      if (from.includes('recoil')) kind = 'recoil';
      else if (from.includes('drain')) kind = 'drain';
      else if (/stealth rock|spikes|sticky web|toxic spikes/.test(from)) kind = 'hazard';
      else if (residual) kind = 'residual';
      const attributed = Boolean(current) && !residual;
      const t = current ? tel(current) : null;
      const effect: ActionEffect = {
        kind: residual && kind === 'damage' ? 'residual' : kind,
        side,
        attributed,
        hpBefore: cmd === '-heal' ? prev : (cmd === '-damage' ? Math.max(prev, hp) : prev),
        hpAfter: hp,
        maxHp,
        from,
      };
      if (t) t.effects.push(effect);
      continue;
    }
    if (cmd === '-boost' || cmd === '-unboost') {
      const side = sideOf(parts[2] ?? '');
      const effect: ActionEffect = {
        kind: cmd === '-boost' ? 'boost' : 'unboost',
        side,
        attributed: Boolean(current),
        stat: (parts[3] ?? '').toLowerCase(),
        amount: Number(parts[4] ?? 0),
        from: fromTag(line),
      };
      if (current) tel(current).effects.push(effect);
      continue;
    }
    if (cmd === '-status') {
      const side = sideOf(parts[2] ?? '');
      const from = fromTag(line);
      const attributed = Boolean(current) && !residualFrom(from);
      if (current) {
        tel(current).effects.push({
          kind: attributed ? 'status' : 'residual',
          side,
          attributed,
          status: (parts[3] ?? '').toLowerCase(),
          from,
        });
      }
      continue;
    }
    if (cmd === '-sidestart') {
      const from = (parts[3] ?? '').toLowerCase();
      const kind: EffectKind = /stealth rock|spikes|sticky web/.test(from) ? 'hazard' : 'residual';
      if (current) {
        tel(current).effects.push({
          kind,
          side: sideOf(parts[2] ?? ''),
          attributed: true,
          from,
        });
      }
    }
  }

  ours.hit = ours.executed && !ours.missed && !ours.failed;
  theirs.hit = theirs.executed && !theirs.missed && !theirs.failed;
  return { ours, theirs };
}

export function simulateRound(
  obs: BattleObservation,
  our: LegalAction,
  opp: LegalAction,
  seed: number[],
  theirSets?: CanonicalSet[],
): RoundSimResult {
  const root = createBattle(obs, seed, theirSets);
  const battle = cloneBattle(root);
  const ourChoice = simChoice(our);
  const oppChoice = simChoice(opp);
  const p1Choice = obs.ourSide === 'p1' ? ourChoice : oppChoice;
  const p2Choice = obs.ourSide === 'p1' ? oppChoice : ourChoice;
  const logStart = battle.log?.length ?? 0;
  try {
    battle.makeChoices(p1Choice, p2Choice);
  } catch {
    // illegal in this hypothesized state — treat as no-op branch
  }
  const roundLog = (battle.log ?? []).slice(logStart);
  const { ours, theirs } = parseRoundLog(roundLog, obs.ourSide);
  const oursPoke = obs.ourSide === 'p1' ? battle.p1.pokemon : battle.p2.pokemon;
  const theirsPoke = obs.ourSide === 'p1' ? battle.p2.pokemon : battle.p1.pokemon;
  const afterOurs = snapshotSide(oursPoke, obs.ours, obs.field.weather);
  const afterTheirs = snapshotSide(theirsPoke, obs.theirs, obs.field.weather);
  const afterField = snapshotField(battle, obs.field);
  const weWin = afterTheirs.every((s) => s.fainted || s.hp <= 0);
  const theyWin = afterOurs.every((s) => s.fainted || s.hp <= 0);
  return {
    afterOurs,
    afterTheirs,
    afterField,
    pHit: ours.hit ? 1 : 0,
    pExecute: ours.executed ? 1 : 0,
    aliveAtExecution: ours.aliveAtExecution ? 1 : 0,
    weWin,
    theyWin,
    ours,
    theirs,
  };
}

export function probeClone(): void {
  const PS = loadShowdown();
  const battle = new PS.Battle({ formatid: 'gen9customgame', seed: [1, 2, 3, 4] });
  const packed = PS.Teams.pack([
    { species: 'Garchomp', moves: ['earthquake'], ability: 'roughskin', item: 'leftovers', nature: 'Jolly', level: 80 },
    { species: 'Toxapex', moves: ['recover'], ability: 'regenerator', item: 'blacksludge', nature: 'Bold', level: 80 },
  ]);
  battle.setPlayer('p1', { name: 'p1', team: packed });
  battle.setPlayer('p2', { name: 'p2', team: packed });
  if ((battle as AnyBattle).p1.requestState === 'teampreview') {
    battle.makeChoices('default', 'default');
  }
  cloneBattle(battle);
}
