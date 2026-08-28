import { createRequire } from 'node:module';
import type { BattleObservation, CanonicalSet, FieldSnapshot, LegalAction, PlayerSide, SlotSnapshot } from './observation.js';
import { normalizeTerrain, normalizeWeather, placeholderSet, showdownTerrain, showdownWeather } from './observation.js';
import { modifiersFromSlot } from './math.js';
import { simChoice } from './actions.js';
import { pickMoves } from './randbats.js';

const require = createRequire(import.meta.url);

type AnyField = {
  weather?: string | { id?: string };
  terrain?: string | { id?: string };
  weatherState?: { duration?: number };
  terrainState?: { duration?: number };
  pseudoWeather?: Record<string, { duration?: number } | unknown>;
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
  lastItem?: string;
  ability?: string;
  moveSlots?: Array<{ id: string; pp: number; disabled?: boolean }>;
  isActive?: boolean;
  species?: { id: string };
  sethp?: (s: string | number) => void;
  terastallized?: string;
  teraType?: string;
  canTerastallize?: string | false | null;
  trapped?: boolean | string;
  apparentType?: string;
  addedType?: string;
};

const BOOST_KEYS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'] as const;

interface SimPartyLayout {
  packedTeam: string;
  packedIndexBySlot: Map<number, number>;
  slotByPackedIndex: number[];
}

export class IllegalSimChoiceError extends Error {
  readonly ourActionId: string;
  readonly oppActionId: string;
  constructor(opts: {
    ourActionId: string;
    oppActionId: string;
    ours: { slot: number; speciesId: string };
    theirs: { slot: number; speciesId: string };
    cause: unknown;
  }) {
    const msg = opts.cause instanceof Error ? opts.cause.message : String(opts.cause);
    super(
      `illegal sim choice ${opts.ourActionId} vs ${opts.oppActionId} ` +
      `(ours slot ${opts.ours.slot} ${opts.ours.speciesId}, theirs slot ${opts.theirs.slot} ${opts.theirs.speciesId}): ${msg}`,
    );
    this.name = 'IllegalSimChoiceError';
    this.ourActionId = opts.ourActionId;
    this.oppActionId = opts.oppActionId;
  }
}

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

function toId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toPackedSet(set: CanonicalSet, knownMoves: string[] = [], slot?: SlotSnapshot): Record<string, unknown> {
  const pool = set.movePool?.length ? set.movePool : set.moves;
  const moves = pickMoves(pool, knownMoves.length ? knownMoves : set.moves);
  const item = slot && slot.item !== undefined ? slot.item : set.item;
  const ability = slot && slot.ability !== undefined ? slot.ability : set.ability;
  return {
    species: set.species,
    item: item || undefined,
    ability: ability || undefined,
    moves: moves.length ? moves : ['splash'],
    nature: set.nature || 'Hardy',
    level: set.level || 100,
    gender: set.gender,
    teraType: slot?.teraType || set.teraType,
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

function assertUniqueRevealedSpecies(slots: SlotSnapshot[]): void {
  const seen = new Set<string>();
  for (const s of slots) {
    if (!s.revealed) continue;
    const id = toId(s.speciesId);
    if (!id) continue;
    if (seen.has(id)) {
      throw new Error(`unsupported format: duplicate species '${s.speciesId}' (Random Battles assume unique species)`);
    }
    seen.add(id);
  }
}

function packSide(slots: SlotSnapshot[], overrides?: CanonicalSet[]): SimPartyLayout {
  assertUniqueRevealedSpecies(slots);
  const PS = loadShowdown();
  const padded = [...slots];
  while (padded.length < 6) padded.push({
    slot: padded.length,
    speciesId: 'smeargle',
    revealed: false,
    hp: 100,
    maxHp: 100,
    status: '',
    boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
    fainted: false,
    active: false,
    knownMoves: [],
    hypotheses: [],
    modifiers: [],
    set: placeholderSet(),
  });
  const setBySlot = new Map<number, CanonicalSet>();
  padded.forEach((s, i) => {
    setBySlot.set(s.slot, overrides?.[i] ?? overrides?.[s.slot] ?? slotSet(s));
  });
  const active = padded.find((s) => s.active);
  const rest = padded.filter((s) => s !== active).sort((a, b) => a.slot - b.slot);
  const ordered = active ? [active, ...rest] : [...padded].sort((a, b) => a.slot - b.slot);
  const packedIndexBySlot = new Map<number, number>();
  const slotByPackedIndex: number[] = [];
  const packed = ordered.map((s, i) => {
    packedIndexBySlot.set(s.slot, i);
    slotByPackedIndex.push(s.slot);
    const set = setBySlot.get(s.slot) ?? slotSet(s);
    return toPackedSet(set, s.knownMoves, s);
  });
  return {
    packedTeam: PS.Teams.pack(packed) ?? '',
    packedIndexBySlot,
    slotByPackedIndex,
  };
}

export function packObservation(obs: BattleObservation, theirOverride?: CanonicalSet[]): [string, string] {
  const ours = packSide(obs.ours);
  const theirs = packSide(obs.theirs, theirOverride);
  return [ours.packedTeam, theirs.packedTeam];
}

function applyPokemonState(p: AnyPokemon, s: SlotSnapshot): void {
  if (s.maxHp > 0) {
    if (s.fainted || s.hp <= 0) {
      p.hp = 0;
      p.fainted = true;
      p.status = 'fnt';
    } else {
      p.hp = Math.max(1, Math.round((s.hp / s.maxHp) * p.maxhp));
      p.fainted = false;
      p.status = s.status && s.status !== 'fnt' ? s.status : '';
    }
  }
  for (const k of BOOST_KEYS) {
    p.boosts[k] = s.boosts[k] ?? 0;
  }
  if (s.moveSlots?.length && p.moveSlots) {
    for (const ms of p.moveSlots) {
      const snap = s.moveSlots.find((x) => toId(x.id) === toId(ms.id));
      if (!snap) continue;
      ms.pp = snap.pp;
      ms.disabled = Boolean(snap.disabled);
    }
  }
  // ponytail: pokemon-showdown@0.11.10 setItem/setAbility require isActive+hp; assign fields. Upgrade: public restore API.
  if (s.item !== undefined) {
    if (s.item) p.item = toId(s.item);
    else {
      if (p.item) p.lastItem = p.item;
      p.item = '';
    }
  }
  if (s.ability !== undefined && s.ability) p.ability = toId(s.ability);
  if (s.terastallized) {
    const tera = s.teraType || p.teraType || '';
    if (tera) {
      // ponytail: pokemon-showdown@0.11.10 has no public Tera restore; BattleActions.terastallize is one-way. Upgrade: pin-tested restore helper.
      p.teraType = tera;
      p.terastallized = tera;
      p.apparentType = tera;
      p.addedType = '';
      p.canTerastallize = null;
    }
  }
  if (s.trapped) p.trapped = true;
}

function applySideState(mons: AnyPokemon[], slots: SlotSnapshot[], layout: SimPartyLayout, teraUsed: boolean): void {
  for (const s of slots) {
    const idx = layout.packedIndexBySlot.get(s.slot);
    if (idx === undefined) continue;
    const p = mons[idx];
    if (!p) continue;
    applyPokemonState(p, s);
  }
  if (teraUsed || slots.some((s) => s.terastallized)) {
    for (const p of mons) p.canTerastallize = null;
  }
}

function requireFn(obj: object | undefined, name: string, label: string): (a: string, b?: unknown) => unknown {
  const fn = obj && (obj as Record<string, unknown>)[name];
  if (typeof fn !== 'function') {
    throw new Error(`pinned pokemon-showdown is missing ${label} (needed to restore the observed field)`);
  }
  return (fn as (a: string, b?: unknown) => unknown).bind(obj);
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
  if (weather && typeof field.weatherTurns === 'number' && f.weatherState) {
    f.weatherState.duration = field.weatherTurns;
  }
  const terrain = showdownTerrain(field.terrain);
  if (terrain) requireFn(f, 'setTerrain', 'field.setTerrain')(terrain, 'debug');
  else if (idOf(f.terrain) && typeof f.clearTerrain === 'function') f.clearTerrain();
  if (terrain && typeof field.terrainTurns === 'number' && f.terrainState) {
    f.terrainState.duration = field.terrainTurns;
  }
  const hasTR = Boolean(f.pseudoWeather && ('trickroom' in f.pseudoWeather));
  if (field.trickroom && !hasTR) requireFn(f, 'addPseudoWeather', 'field.addPseudoWeather')('trickroom', 'debug');
  else if (!field.trickroom && hasTR && typeof f.removePseudoWeather === 'function') f.removePseudoWeather('trickroom');
  if (field.trickroom && typeof field.trickroomTurns === 'number' && f.pseudoWeather?.trickroom && typeof f.pseudoWeather.trickroom === 'object') {
    (f.pseudoWeather.trickroom as { duration?: number }).duration = field.trickroomTurns;
  }
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

function remainingTurns(state: { duration?: number } | undefined): number | undefined {
  if (state && typeof state.duration === 'number' && state.duration > 0) return state.duration;
  return undefined;
}

function snapshotField(battle: AnyBattle, prev: FieldSnapshot): FieldSnapshot {
  const p1 = battle.p1.sideConditions;
  const p2 = battle.p2.sideConditions;
  const weather = normalizeWeather(idOf(battle.field?.weather));
  const terrain = normalizeTerrain(idOf(battle.field?.terrain));
  const trickroom = Boolean(battle.field?.pseudoWeather && 'trickroom' in battle.field.pseudoWeather);
  const trState = battle.field?.pseudoWeather?.trickroom;
  return {
    weather,
    terrain,
    trickroom,
    weatherTurns: weather ? remainingTurns(battle.field?.weatherState) : undefined,
    terrainTurns: terrain ? remainingTurns(battle.field?.terrainState) : undefined,
    trickroomTurns: trickroom && trState && typeof trState === 'object' ? remainingTurns(trState as { duration?: number }) : undefined,
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

function speciesIdOf(p: AnyPokemon): string {
  return String(p.species?.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function snapshotSide(mons: AnyPokemon[], prev: SlotSnapshot[], weather: string): SlotSnapshot[] {
  const used = new Set<AnyPokemon>();
  return prev.map((slot, i) => {
    const p = mons.find((m) => !used.has(m) && speciesIdOf(m) === slot.speciesId) ?? mons[i];
    if (p) used.add(p);
    if (!p) return { ...slot, modifiers: modifiersFromSlot(slot, weather) };
    const fainted = Boolean(p.fainted) || p.hp <= 0;
    const moveSlots = p.moveSlots ? p.moveSlots.map((m) => ({
      id: m.id,
      pp: m.pp,
      maxpp: slot.moveSlots?.find((s) => s.id === m.id)?.maxpp ?? m.pp,
      disabled: Boolean(m.disabled),
    })) : slot.moveSlots;

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
      moveSlots,
      item: p.item !== undefined ? (p.item || '') : slot.item,
      ability: p.ability || slot.ability,
      terastallized: Boolean(p.terastallized) || slot.terastallized,
      teraType: (typeof p.terastallized === 'string' && p.terastallized) || slot.teraType,
    };
    next.modifiers = modifiersFromSlot(next, weather);
    return next;
  });
}

function simChoiceFor(a: LegalAction, layout: SimPartyLayout): string {
  if (a.type === 'switch') {
    const ext = (a.slot ?? 1) - 1;
    const packed = layout.packedIndexBySlot.get(ext);
    if (packed === undefined) {
      throw new Error(`switch slot ${a.slot} is not in the packed party`);
    }
    return `switch ${packed + 1}`;
  }
  return simChoice(a);
}

export function createBattle(obs: BattleObservation, seed: number[], theirSets?: CanonicalSet[]): AnyBattle {
  return prepareBattle(obs, seed, theirSets).battle;
}

function prepareBattle(obs: BattleObservation, seed: number[], theirSets?: CanonicalSet[]): {
  battle: AnyBattle;
  ours: SimPartyLayout;
  theirs: SimPartyLayout;
} {
  const PS = loadShowdown();
  const ours = packSide(obs.ours);
  const theirs = packSide(obs.theirs, theirSets);
  const battle = new PS.Battle({ formatid: 'gen9customgame', seed });
  const p1Layout = obs.ourSide === 'p1' ? ours : theirs;
  const p2Layout = obs.ourSide === 'p1' ? theirs : ours;
  battle.setPlayer('p1', { name: 'p1', team: p1Layout.packedTeam });
  battle.setPlayer('p2', { name: 'p2', team: p2Layout.packedTeam });
  if (battle.p1.requestState === 'teampreview' || battle.p2.requestState === 'teampreview') {
    battle.makeChoices('default', 'default');
  }
  applyField(battle, obs.field);
  applySideState(obs.ourSide === 'p1' ? battle.p1.pokemon : battle.p2.pokemon, obs.ours, ours, obs.teraUsedOurs);
  applySideState(obs.ourSide === 'p1' ? battle.p2.pokemon : battle.p1.pokemon, obs.theirs, theirs, obs.teraUsedTheirs);
  return { battle, ours, theirs };
}

function emptyTel(): ActionTelemetry {
  return {
    announced: false, first: false, missed: false, failed: false,
    executed: false, hit: false, aliveAtExecution: false, effects: [],
  };
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
  const lastMax: Record<string, number> = {};

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
      const ident = parts[2] ?? '';
      const parsed = parseHp(parts[4] ?? parts[3] ?? '');
      if (parsed.maxHp > 0) lastMax[ident] = parsed.maxHp;
      lastHp[ident] = parsed.hp;
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
      const parsed = parseHp(parts[3] ?? '');
      const maxHp = parsed.maxHp || lastMax[ident] || 0;
      const prev = lastHp[ident] ?? (parsed.hp || maxHp);
      if (maxHp > 0) lastMax[ident] = maxHp;
      lastHp[ident] = parsed.hp;
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
        hpBefore: cmd === '-heal' ? prev : (cmd === '-damage' ? Math.max(prev, parsed.hp) : prev),
        hpAfter: parsed.hp,
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
