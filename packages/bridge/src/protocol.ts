// Showdown battle-protocol parser + live state tracker.
//
// Pokémon Showdown speaks a line-delimited protocol over websocket. Each line
// is `|`-prefixed and carries one event. This module:
//   1. `parseLine(line)` → a structured `BattleEvent`.
//   2. `BattleTracker` folds events into an immutable `BattleObservation`.
//
// Protocol reference: https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md
//
// ponytail: singles only (one active slot per side).

import {
  modifiersFromSlot,
  normalizeTerrain,
  normalizeWeather,
  observationTera,
  placeholderSlot,
  type BattleObservation,
  type SetHypothesis,
  type SlotSnapshot,
} from '@pokeredus/engine';
import { enumerateFromRequest } from '@pokeredus/engine';
import { initialBelief, type RandomSetPool } from '@pokeredus/engine';
import type { PackIndex } from '@pokeredus/pack';

// ──────────────────────────────────────────────────────────────────────
// Request JSON shapes (loose — only the fields we read)
// ──────────────────────────────────────────────────────────────────────
export interface RequestMove {
  move: string;
  id: string;
  pp: number;
  maxpp: number;
  disabled: boolean;
  used?: boolean;
}
export interface RequestPokemon {
  ident: string;
  details: string;
  condition: string;
  active: boolean;
  moves: RequestMove[];
  baseAbility: string;
  item: string;
  teraType?: string;
  terastallized?: boolean;
}
export interface RequestActive {
  moves: RequestMove[];
  canTerastallize?: boolean;
  trapped?: boolean;
  maybeTrapped?: boolean;
}
export interface RequestJson {
  side: { id: string; name: string; pokemon: RequestPokemon[] };
  active?: RequestActive[];
  rqid?: number;
  wait?: boolean;
  forceSwitch?: boolean[];
}

// ──────────────────────────────────────────────────────────────────────
// BattleEvent — discriminated union
// ──────────────────────────────────────────────────────────────────────
type PlayerSide = 'p1' | 'p2';

interface SlotCommon {
  side: PlayerSide;
  slot: string; // e.g. 'p1a'
  identity: string; // e.g. 'p1a: Garchomp'
}

export type BattleEvent =
  | { type: 'init'; room?: string }
  | { type: 'turn'; num: number }
  | { type: 'request'; json: RequestJson }
  | ({ type: 'switch' } & SlotCommon & { speciesId: string; details: string; hp: number; maxHp: number; status: string })
  | ({ type: 'drag' } & SlotCommon & { speciesId: string; details: string; hp: number; maxHp: number; status: string })
  | ({ type: '-damage' } & SlotCommon & { hp: number; maxHp: number; status: string; fainted: boolean })
  | ({ type: '-heal' } & SlotCommon & { hp: number; maxHp: number; status: string })
  | ({ type: '-status' } & SlotCommon & { status: string })
  | ({ type: 'faint' } & SlotCommon)
  | ({ type: '-boost' } & SlotCommon & { stat: string; amount: number })
  | ({ type: '-unboost' } & SlotCommon & { stat: string; amount: number })
  | ({ type: '-start' } & SlotCommon & { effect: string })
  | ({ type: '-end' } & SlotCommon & { effect: string })
  | ({ type: 'move' } & SlotCommon & { moveId: string; target?: string })
  | { type: 'fieldstart'; effect: string }
  | { type: 'fieldend'; effect: string }
  | { type: 'weather'; weather: string }
  | { type: 'terrain'; terrain: string }
  | { type: 'sidestart'; side: PlayerSide; effect: string }
  | { type: 'sideend'; side: PlayerSide; effect: string }
  | ({ type: '-item' } & SlotCommon & { item: string })
  | ({ type: '-ability' } & SlotCommon & { ability: string })
  | ({ type: '-enditem' } & SlotCommon & { item: string })
  | ({ type: '-terastallize' } & SlotCommon & { teraType: string })
  | ({ type: 'detailschange' } & SlotCommon & { speciesId: string; details: string })
  | { type: 'win'; winner: string }
  | { type: 'raw'; text: string }
  | { type: 'other'; raw: string };

// ──────────────────────────────────────────────────────────────────────
// Low-level parsing helpers
// ──────────────────────────────────────────────────────────────────────
/** Showdown id normalization: lowercase, drop everything but alphanumerics. */
export function toId(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function splitIdentity(identity: string): { side: PlayerSide; slot: string } {
  const pre = (identity.split(':')[0] ?? '').trim();
  const side: PlayerSide = pre.startsWith('p1') ? 'p1' : 'p2';
  let slot = pre;
  if (slot === 'p1') slot = 'p1a';
  if (slot === 'p2') slot = 'p2a';
  return { side, slot };
}

function identityName(identity: string): string {
  return (identity.split(':')[1] ?? identity).trim();
}

function monKey(identity: string, speciesId = ''): string {
  return toId(identityName(identity)) || speciesId;
}

function sideFromPlayer(player: string): PlayerSide {
  return player.startsWith('p1') ? 'p1' : 'p2';
}

/** Parse a condition string like `90/100`, `100/100 brn`, `0 fnt`, `100/?`. */
function parseCondition(cond: string): { hp: number; maxHp: number; status: string; fainted: boolean } {
  const trimmed = (cond ?? '').trim();
  if (!trimmed || trimmed === '0 fnt') {
    return { hp: 0, maxHp: 0, status: 'fnt', fainted: true };
  }
  const [hpPart = '', ...rest] = trimmed.split(' ');
  const status = rest.join(' ').trim().toLowerCase();
  const [hpStr, maxStr] = hpPart.split('/');
  const hp = Number(hpStr);
  const maxHp = maxStr && maxStr !== '?' ? Number(maxStr) : Number.isFinite(Number(hpStr)) ? hp : 0;
  const fainted = status === 'fnt' || !Number.isFinite(hp) || hp <= 0;
  return { hp: Number.isFinite(hp) ? hp : 0, maxHp: Number.isFinite(maxHp) ? maxHp : 0, status, fainted };
}

function parseDetails(details: string): { speciesId: string; level?: number; teraType?: string } {
  const bits = (details ?? '').split(',').map((s) => s.trim());
  const speciesId = toId(bits[0] ?? '');
  let level: number | undefined;
  let teraType: string | undefined;
  for (const bit of bits.slice(1)) {
    const lv = /^L(\d+)$/i.exec(bit);
    if (lv) level = Number(lv[1]);
    const tera = /^tera:\s*(.+)$/i.exec(bit);
    if (tera) teraType = tera[1];
  }
  return { speciesId, level, teraType };
}

function speciesIdFromDetails(details: string): string {
  return parseDetails(details).speciesId;
}

// ──────────────────────────────────────────────────────────────────────
// parseLine — the protocol tokenizer
// ──────────────────────────────────────────────────────────────────────
export function parseLine(raw: string): BattleEvent | null {
  let line = raw.trim();
  if (!line) return null;

  // Real PS streams sometimes prefix a room id: "battle-gen9ou-1|turn|3".
  // Strip it so the command starts at the first '|'.
  if (line.startsWith('|split|')) {
    // |split|room1,room2|payload  →  take the payload after the room list.
    const parts = line.split('|');
    if (parts.length >= 4) line = '|' + parts.slice(3).join('|');
  } else {
    const bar = line.indexOf('|');
    if (bar > 0) line = line.slice(bar);
  }

  if (!line.startsWith('|')) return { type: 'other', raw };
  const parts = line.split('|'); // ['', 'cmd', ...]
  const cmd = parts[1];

  switch (cmd) {
    case 'turn':
      return { type: 'turn', num: Number(parts[2]) };

    case 'request': {
      try {
        const json = JSON.parse(parts.slice(2).join('|')) as RequestJson;
        return { type: 'request', json };
      } catch {
        return { type: 'other', raw };
      }
    }

    case 'switch':
    case 'drag': {
      const identity = parts[2] ?? '';
      const details = parts[3] ?? '';
      const { hp, maxHp, status } = parseCondition(parts[4] ?? '');
      const { side, slot } = splitIdentity(identity);
      return { type: cmd, side, slot, identity, speciesId: speciesIdFromDetails(details), details, hp, maxHp, status };
    }

    case '-damage':
    case '-heal': {
      const identity = parts[2] ?? '';
      const { hp, maxHp, status, fainted } = parseCondition(parts[3] ?? '');
      const { side, slot } = splitIdentity(identity);
      return { type: cmd, side, slot, identity, hp, maxHp, status, fainted };
    }

    case '-status': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: '-status', side, slot, identity, status: (parts[3] ?? '').toLowerCase() };
    }

    case 'faint': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: 'faint', side, slot, identity };
    }

    case '-boost':
    case '-unboost': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: cmd, side, slot, identity, stat: (parts[3] ?? '').toLowerCase(), amount: Number(parts[4] ?? 0) };
    }

    case '-start':
    case '-end': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: cmd, side, slot, identity, effect: parts[3] ?? '' };
    }

    case 'move': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: 'move', side, slot, identity, moveId: toId(parts[3] ?? ''), target: parts[4] };
    }

    case '-fieldstart':
      return { type: 'fieldstart', effect: parts[2] ?? '' };
    case '-fieldend':
      return { type: 'fieldend', effect: parts[2] ?? '' };
    case '-weather':
      return { type: 'weather', weather: toId(parts[2] ?? '') };
    case '-terrain':
      return { type: 'terrain', terrain: toId(parts[2] ?? '') };
    case '-sidestart':
      return { type: 'sidestart', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };
    case '-sideend':
      return { type: 'sideend', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };

    case '-item': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: '-item', side, slot, identity, item: toId(parts[3] ?? '') };
    }
    case '-ability': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: '-ability', side, slot, identity, ability: toId(parts[3] ?? '') };
    }
    case '-enditem': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: '-enditem', side, slot, identity, item: toId(parts[3] ?? '') };
    }
    case '-terastallize': {
      const identity = parts[2] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: '-terastallize', side, slot, identity, teraType: parts[3] ?? '' };
    }
    case 'detailschange': {
      const identity = parts[2] ?? '';
      const details = parts[3] ?? '';
      const { side, slot } = splitIdentity(identity);
      return { type: 'detailschange', side, slot, identity, speciesId: speciesIdFromDetails(details), details };
    }

    case 'win':
      return { type: 'win', winner: parts[2] ?? '' };

    case 'j':
      return { type: 'init' };

    case 'raw':
    case 'html':
    case 'chat':
      return { type: 'raw', text: line };

    default:
      return { type: 'other', raw };
  }
}

// ──────────────────────────────────────────────────────────────────────
// resolveSetId — Showdown species → Knowledge-Pack set
// ──────────────────────────────────────────────────────────────────────
/**
 * Map a Showdown species id (e.g. `garchomp`, `arcaninehisui`, `garchompmega`)
 * onto the best-matching Knowledge-Pack set id. Best-effort: returns undefined
 * when the species is absent from the pack (the engine then scores it 0 and a
 * warning is logged by the caller).
 *
 * Strategy: try the exact id, then normalized forms (hyphen-stripped), then a
 * fuzzy prefix match against pack species ids. This handles regional-form
 * hyphenation differences (Showdown `arcaninehisui` vs pack `arcanine-hisui`)
 * and mega/gmax suffixes falling back to the base species.
 */
export function resolveSetId(speciesId: string, pack: PackIndex): string | undefined {
  const tries = [speciesId, toId(speciesId), speciesId.replace(/-/g, ''), toId(speciesId).replace(/(mega|gmax)$/, '')];
  for (const t of tries) {
    const s = pack.primaryBySpecies.get(t);
    if (s) return s.id;
  }
  const norm = toId(speciesId);
  for (const key of pack.primaryBySpecies.keys()) {
    const k = toId(key);
    if (k.startsWith(norm) || norm.startsWith(k)) return pack.primaryBySpecies.get(key)!.id;
  }
  return undefined;
}

// ──────────────────────────────────────────────────────────────────────
// BattleTracker — fold events into a BattleObservation
// ──────────────────────────────────────────────────────────────────────
interface BoostState {
  atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number;
}
function emptyBoosts(): BoostState {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

interface TrackerField {
  weather: string;
  terrain: string;
  hazards_a: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  hazards_b: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  reflect_a: number; reflect_b: number;
  lightscreen_a: number; lightscreen_b: number;
  trickroom: boolean;
}
function trackerEmptyField(): TrackerField {
  return {
    weather: '', terrain: '',
    hazards_a: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    hazards_b: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    reflect_a: 0, reflect_b: 0, lightscreen_a: 0, lightscreen_b: 0,
    trickroom: false,
  };
}

interface TrackedMon {
  slot: string;
  side: PlayerSide;
  identity: string;
  speciesId: string;
  details?: string;
  hp: number;
  maxHp: number;
  status: string;
  boosts: BoostState;
  pp: Record<string, number>;
  lastMove?: string;
  revealedMoves: string[];
  item?: string;
  ability?: string;
  level?: number;
  teraType?: string;
  choiceLock?: string;
  tauntTurns: number;
  fainted: boolean;
  active: boolean;
}

export class BattleTracker {
  ourSide: PlayerSide = 'p1';
  turn = 0;
  myMons: Map<string, TrackedMon> = new Map();
  oppMons: Map<string, TrackedMon> = new Map();
  field: TrackerField = trackerEmptyField();
  teraUsedOurs = false;
  teraUsedTheirs = false;
  lastRequest: RequestJson | null = null;

  private monsFor(side: PlayerSide): Map<string, TrackedMon> {
    return side === this.ourSide ? this.myMons : this.oppMons;
  }

  private findMon(side: PlayerSide, identity: string, speciesId = ''): TrackedMon | undefined {
    const map = this.monsFor(side);
    const key = monKey(identity, speciesId);
    return map.get(key) ?? [...map.values()].find((m) => m.active);
  }

  /** Parse and apply one raw protocol line. Returns the parsed event (for callers that branch on it). */
  applyLine(line: string): BattleEvent | null {
    const ev = parseLine(line);
    if (ev) this.apply(ev);
    return ev;
  }

  apply(ev: BattleEvent): void {
    switch (ev.type) {
      case 'turn':
        this.turn = ev.num;
        break;

      case 'request':
        this.lastRequest = ev.json;
        this.applyRequest(ev.json);
        break;

      case 'switch':
      case 'drag': {
        const map = this.monsFor(ev.side);
        for (const m of map.values()) m.active = false;
        const key = monKey(ev.identity, ev.speciesId);
        const existing = map.get(key);
        const parsed = parseDetails(ev.details);
        const mon: TrackedMon = {
          slot: ev.slot, side: ev.side, identity: ev.identity, speciesId: ev.speciesId, details: ev.details,
          hp: ev.hp, maxHp: ev.maxHp, status: ev.status,
          boosts: emptyBoosts(), pp: existing?.pp ?? {}, lastMove: existing?.lastMove,
          revealedMoves: existing?.revealedMoves ? [...existing.revealedMoves] : [],
          item: existing?.item, ability: existing?.ability,
          level: parsed.level ?? existing?.level, teraType: parsed.teraType ?? existing?.teraType,
          choiceLock: existing?.choiceLock, tauntTurns: 0, fainted: ev.status === 'fnt' || ev.hp <= 0, active: true,
        };
        map.set(key, mon);
        break;
      }

      case '-damage':
      case '-heal': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon) {
          mon.hp = ev.hp;
          if (ev.maxHp > 0) mon.maxHp = ev.maxHp;
          mon.status = ev.status;
          const fainted = (ev.type === '-damage' ? ev.fainted : false) || ev.hp <= 0;
          mon.fainted = fainted;
        }
        break;
      }

      case '-status': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon) mon.status = ev.status;
        break;
      }

      case 'faint': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon) { mon.fainted = true; mon.hp = 0; mon.status = 'fnt'; }
        break;
      }

      case '-boost':
      case '-unboost': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon && ev.stat in mon.boosts) {
          const cur = mon.boosts[ev.stat as keyof BoostState];
          mon.boosts[ev.stat as keyof BoostState] = Math.max(-6, Math.min(6, cur + (ev.type === '-boost' ? ev.amount : -ev.amount)));
        }
        break;
      }

      case '-start':
      case '-end': {
        const on = ev.type === '-start';
        const mon = this.findMon(ev.side, ev.identity);
        if (mon && ev.effect.toLowerCase().includes('taunt')) mon.tauntTurns = on ? 3 : 0;
        break;
      }

      case 'move': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon) {
          mon.lastMove = ev.moveId;
          if (ev.moveId && !mon.revealedMoves.includes(ev.moveId)) mon.revealedMoves.push(ev.moveId);
        }
        break;
      }

      case 'weather':
        this.field.weather = normalizeWeather(ev.weather);
        break;

      case 'terrain':
        this.field.terrain = normalizeTerrain(ev.terrain);
        break;

      case 'fieldstart':
      case 'fieldend': {
        const on = ev.type === 'fieldstart';
        const eff = ev.effect.toLowerCase();
        if (eff.includes('trick room')) this.field.trickroom = on;
        break;
      }

      case 'sidestart':
      case 'sideend': {
        const on = ev.type === 'sidestart';
        const haz = ev.side === 'p1' ? this.field.hazards_a : this.field.hazards_b;
        const eff = ev.effect.toLowerCase();
        if (eff.includes('stealth rock')) haz.stealthrock = on ? true : false;
        else if (eff.includes('spikes') && !eff.includes('toxic')) haz.spikes = on ? Math.min(3, haz.spikes + 1) : 0;
        else if (eff.includes('toxic spikes')) haz.toxicspikes = on ? Math.min(2, haz.toxicspikes + 1) : 0;
        else if (eff.includes('sticky web')) haz.stickyweb = on ? true : false;
        else if (eff.includes('reflect')) {
          if (ev.side === 'p1') this.field.reflect_a = on ? 5 : 0; else this.field.reflect_b = on ? 5 : 0;
        } else if (eff.includes('light screen')) {
          if (ev.side === 'p1') this.field.lightscreen_a = on ? 5 : 0; else this.field.lightscreen_b = on ? 5 : 0;
        }
        break;
      }

      case '-item': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon && ev.item) mon.item = ev.item;
        break;
      }
      case '-enditem': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon && ev.item && !mon.item) mon.item = ev.item;
        break;
      }
      case '-ability': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon && ev.ability) mon.ability = ev.ability;
        break;
      }
      case '-terastallize': {
        const mon = this.findMon(ev.side, ev.identity);
        if (mon) mon.teraType = ev.teraType;
        if (ev.side === this.ourSide) this.teraUsedOurs = true;
        else this.teraUsedTheirs = true;
        break;
      }
      case 'detailschange': {
        const parsed = parseDetails(ev.details);
        const mon = this.findMon(ev.side, ev.identity, ev.speciesId);
        if (mon) {
          if (parsed.teraType) mon.teraType = parsed.teraType;
          if (parsed.level) mon.level = parsed.level;
        }
        break;
      }

      // init / win / raw / other: nothing to fold into the observation.
      default:
        break;
    }
  }

  private applyRequest(json: RequestJson): void {
    const sideId = (json.side?.id === 'p2' ? 'p2' : 'p1') as PlayerSide;
    if (sideId !== this.ourSide) {
      if (this.myMons.size || this.oppMons.size) {
        const swap = this.myMons;
        this.myMons = this.oppMons;
        this.oppMons = swap;
      }
      this.ourSide = sideId;
    }
    const pokemon = json.side?.pokemon ?? [];
    const next = new Map<string, TrackedMon>();
    for (const p of pokemon) {
      const speciesId = speciesIdFromDetails(p.details);
      const key = monKey(p.ident, speciesId);
      const { hp, status } = parseCondition(p.condition);
      const existing = this.myMons.get(key) ?? [...this.myMons.values()].find((m) => m.speciesId === speciesId);
      const pp: Record<string, number> = {};
      for (const m of p.moves ?? []) pp[m.id] = m.pp;
      const parsed = parseDetails(p.details);
      const mon: TrackedMon = {
        slot: splitIdentity(p.ident).slot, side: sideId, identity: p.ident,
        speciesId, details: p.details,
        hp, maxHp: existing?.maxHp ?? 0, status,
        boosts: existing?.boosts ?? emptyBoosts(),
        pp, lastMove: existing?.lastMove,
        revealedMoves: existing?.revealedMoves ? [...existing.revealedMoves] : Object.keys(pp),
        item: toId(p.item || '') || existing?.item,
        ability: toId(p.baseAbility || '') || existing?.ability,
        level: parsed.level ?? existing?.level,
        teraType: p.teraType || parsed.teraType || existing?.teraType,
        choiceLock: existing?.choiceLock,
        tauntTurns: existing?.tauntTurns ?? 0, fainted: hp <= 0, active: !!p.active,
      };
      if (p.terastallized) this.teraUsedOurs = true;
      next.set(key, mon);
    }
    this.myMons = next;
    const firstActive = json.active?.[0];
    const firstPoke = pokemon[0];
    if (firstActive && firstPoke) {
      const activeMon = this.myMons.get(monKey(firstPoke.ident, speciesIdFromDetails(firstPoke.details)));
      const moves = firstActive.moves ?? [];
      const enabled = moves.filter((m) => !m.disabled);
      if (moves.length >= 2 && enabled.length === 1 && activeMon) activeMon.choiceLock = enabled[0]!.id;
    }
  }

  /** Build the immutable observation the engine consumes. */
  toObservation(pool: RandomSetPool, ourSets: import('@pokeredus/engine').CanonicalSet[]): BattleObservation {
    const ours: SlotSnapshot[] = [];
    const myList = [...this.myMons.values()];
    for (let i = 0; i < 6; i++) {
      const m = myList[i];
      const set = ourSets[i];
      if (!m) {
        const slot = placeholderSlot(i);
        if (set) {
          slot.speciesId = set.species;
          slot.set = set;
          slot.revealed = true;
        }
        ours.push(slot);
        continue;
      }
      ours.push({
        slot: i,
        speciesId: m.speciesId,
        revealed: true,
        hp: m.hp,
        maxHp: m.maxHp || 100,
        status: m.status,
        boosts: { ...m.boosts },
        fainted: m.fainted,
        active: m.active,
        knownMoves: Object.keys(m.pp),
        set,
        hypotheses: [],
        modifiers: [],
      });
    }

    const theirs: SlotSnapshot[] = [];
    const oppList = [...this.oppMons.values()];
    for (let i = 0; i < 6; i++) {
      const m = oppList[i];
      if (!m) {
        theirs.push(placeholderSlot(i));
        continue;
      }
      const facts = {
        species: m.speciesId,
        moves: m.lastMove ? [m.lastMove] : [],
      };
      let hypotheses: SetHypothesis[] = [];
      try {
        hypotheses = initialBelief(pool, facts);
      } catch (err) {
        console.error(`[pokeredus] ${err instanceof Error ? err.message : err}`);
      }
      theirs.push({
        slot: i,
        speciesId: m.speciesId,
        revealed: true,
        hp: m.hp,
        maxHp: m.maxHp || 100,
        status: m.status,
        boosts: { ...m.boosts },
        fainted: m.fainted,
        active: m.active,
        knownMoves: m.lastMove ? [m.lastMove] : [],
        hypotheses,
        set: hypotheses[0]?.set,
        modifiers: [],
      });
    }

    const weather = this.field.weather;
    for (const s of ours) s.modifiers = modifiersFromSlot(s, weather);
    for (const s of theirs) s.modifiers = modifiersFromSlot(s, weather);

    const legalActions = enumerateFromRequest(this.lastRequest ?? undefined).filter((a) => !a.tera);
    // #region agent log
    agentLog('C', 'protocol.ts:toObservation', 'obs slots', { ourSide: this.ourSide, ours: ours.map((s) => ({ species: s.speciesId, active: s.active, slot: s.slot, revealed: s.revealed })), theirs: theirs.map((s) => ({ species: s.speciesId, active: s.active, slot: s.slot, revealed: s.revealed })), legal: legalActions.map((a) => a.id), teraLegal: legalActions.filter((a) => a.tera).length, mapSize: this.myMons.size });
    // #endregion
    return {
      turn: this.turn,
      format: 'gen9randombattle',
      ourSide: this.ourSide,
      ours,
      theirs,
      field: {
        weather: this.field.weather,
        terrain: this.field.terrain,
        trickroom: this.field.trickroom,
        hazards_p1: { ...this.field.hazards_a },
        hazards_p2: { ...this.field.hazards_b },
        reflect_p1: this.field.reflect_a,
        reflect_p2: this.field.reflect_b,
        lightscreen_p1: this.field.lightscreen_a,
        lightscreen_p2: this.field.lightscreen_b,
      },
      request: this.lastRequest ?? undefined,
      legalActions,
      teraUsed: this.teraUsed,
    };
  }
}

function normalizeWeather(w: string): string {
  if (w === 'rain' || w === 'raindance' || w === 'harshrain') return 'rain';
  if (w === 'sunny' || w === 'sunnyday' || w === 'harshsunlight') return 'sunny';
  if (w === 'sandstorm') return 'sandstorm';
  if (w === 'hail' || w === 'snow') return 'snow';
  return '';
}

function normalizeTerrain(t: string): string {
  if (t === 'electricterrain') return 'electric';
  if (t === 'grassyterrain') return 'grassy';
  if (t === 'mistyterrain') return 'misty';
  if (t === 'psychicterrain') return 'psychic';
  return '';
}

export function battleStateFromEvents(
  events: BattleEvent[],
  pool: RandomSetPool,
  ourSets: import('@pokeredus/engine').CanonicalSet[] = [],
): BattleObservation {
  const t = new BattleTracker();
  for (const ev of events) t.apply(ev);
  return t.toObservation(pool, ourSets);
}
