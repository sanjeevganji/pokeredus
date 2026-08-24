import { createRequire } from 'node:module';
import type { BattleObservation, CanonicalSet, FieldSnapshot, LegalAction, SlotSnapshot } from './observation.js';
import { emptyField, placeholderSet } from './observation.js';
import { modifiersFromSlot } from './math.js';
import { simChoice } from './actions.js';

const require = createRequire(import.meta.url);

type AnyBattle = {
  toJSON?: () => unknown;
  p1: AnySide;
  p2: AnySide;
  ended?: boolean;
  winner?: string | null;
  field?: { weather?: string | { id?: string }; terrain?: string | { id?: string } };
  makeChoices: (c1: string, c2: string) => void;
  setPlayer: (slot: 'p1' | 'p2', opts: { name: string; team: string }) => void;
};

type AnySide = {
  pokemon: AnyPokemon[];
  active: AnyPokemon[];
  requestState?: string;
  sideConditions?: Record<string, { layers?: number; levels?: number } | unknown>;
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

export interface RoundSimResult {
  afterOurs: SlotSnapshot[];
  afterTheirs: SlotSnapshot[];
  pHit: number;
  pExecute: number;
  aliveAtExecution: number;
  weWin: boolean;
  theyWin: boolean;
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
  applyHp(battle, obs);
  return battle;
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
  const oursBefore = obs.ourSide === 'p1' ? battle.p1.active[0] : battle.p2.active[0];
  const hpBefore = oursBefore?.hp ?? 0;
  try {
    battle.makeChoices(p1Choice, p2Choice);
  } catch {
    // illegal in this hypothesized state — treat as no-op branch
  }
  const oursPoke = obs.ourSide === 'p1' ? battle.p1.pokemon : battle.p2.pokemon;
  const theirsPoke = obs.ourSide === 'p1' ? battle.p2.pokemon : battle.p1.pokemon;
  const afterOurs = snapshotSide(oursPoke, obs.ours, obs.field.weather);
  const afterTheirs = snapshotSide(theirsPoke, obs.theirs, obs.field.weather);
  const oursAfterActive = afterOurs.find((s) => s.active) ?? afterOurs[0];
  const aliveAtExecution = hpBefore > 0 && oursBefore && !oursBefore.fainted ? 1 : 0;
  const weWin = afterTheirs.every((s) => s.fainted || s.hp <= 0);
  const theyWin = afterOurs.every((s) => s.fainted || s.hp <= 0);
  return {
    afterOurs,
    afterTheirs,
    pHit: 1,
    pExecute: 1,
    aliveAtExecution: oursAfterActive && hpBefore > 0 ? aliveAtExecution : 0,
    weWin,
    theyWin,
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
