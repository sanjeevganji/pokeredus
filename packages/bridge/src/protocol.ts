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
  compatible,
  DEFAULT_LEVEL,
  DEFAULT_NATURE,
  getSetOverride,
  hypothesesForSpecies,
  loadSetOverrides,
  modifiersFromSlot,
  normalizeTerrain,
  normalizeWeather,
  overlayRevealedOnSet,
  placeholderSlot,
  setIsComplete,
  setOptionsFromPool,
  type BattleObservation,
  type CanonicalSet,
  type RevealedFacts,
  type SetHypothesis,
  type SetOverridesStore,
  type SetSource,
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
  moves: Array<RequestMove | string>;
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
  | { type: 'player'; side: PlayerSide; name: string }
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

    case 'player': {
      const side: PlayerSide = (parts[2] ?? '').startsWith('p2') ? 'p2' : 'p1';
      return { type: 'player', side, name: (parts[3] ?? '').trim() };
    }

    case 'request': {
      try {
        const json = JSON.parse(parts.slice(2).join('|')) as RequestJson;
        return { type: 'request', json };
      } catch (err) {
        // #region agent log
        fetch('http://127.0.0.1:7559/ingest/6200673b-d438-4c7f-9e45-49a0c341555a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '246bd1' }, body: JSON.stringify({ sessionId: '246bd1', runId: 'pre-fix', hypothesisId: 'C', location: 'protocol.ts:parseLine', message: 'request JSON parse failed', data: { payloadLen: parts.slice(2).join('|').length, error: err instanceof Error ? err.message : String(err) }, timestamp: Date.now() }) }).catch(() => {});
        // #endregion
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
  ourName = '';
  p1Name = '';
  p2Name = '';
  turn = 0;
  myMons: Map<string, TrackedMon> = new Map();
  oppMons: Map<string, TrackedMon> = new Map();
  field: TrackerField = trackerEmptyField();
  teraUsedOurs = false;
  teraUsedTheirs = false;
  lastRequest: RequestJson | null = null;

  constructor(opts?: { ourName?: string }) {
    if (opts?.ourName) this.ourName = opts.ourName;
  }

  setOurName(name: string): void {
    this.ourName = name;
    this.alignSideFromPlayers();
  }

  private monsFor(side: PlayerSide): Map<string, TrackedMon> {
    return side === this.ourSide ? this.myMons : this.oppMons;
  }

  private findMon(side: PlayerSide, identity: string, speciesId = ''): TrackedMon | undefined {
    const map = this.monsFor(side);
    const key = monKey(identity, speciesId);
    if (map.has(key)) return map.get(key);
    const name = toId(identityName(identity));
    const byName = [...map.values()].find((m) => toId(m.speciesId) === name || toId(identityName(m.identity)) === name);
    if (byName) return byName;
    const slot = splitIdentity(identity).slot;
    return [...map.values()].find((m) => m.active && m.slot === slot);
  }

  private setOurSide(side: PlayerSide): void {
    if (side === this.ourSide) return;
    if (this.myMons.size || this.oppMons.size) {
      const swap = this.myMons;
      this.myMons = this.oppMons;
      this.oppMons = swap;
    }
    this.ourSide = side;
  }

  private alignSideFromPlayers(): void {
    const me = toId(this.ourName);
    if (!me) return;
    if (toId(this.p2Name) === me) this.setOurSide('p2');
    else if (toId(this.p1Name) === me) this.setOurSide('p1');
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

      case 'player':
        if (!ev.name) break;
        if (ev.side === 'p1') this.p1Name = ev.name;
        else this.p2Name = ev.name;
        this.alignSideFromPlayers();
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
    this.setOurSide(sideId);
    const pokemon = json.side?.pokemon ?? [];
    const next = new Map<string, TrackedMon>();
    for (const p of pokemon) {
      const speciesId = speciesIdFromDetails(p.details);
      const key = monKey(p.ident, speciesId);
      const parsedCond = parseCondition(p.condition);
      const existing = this.myMons.get(key) ?? [...this.myMons.values()].find((m) => m.speciesId === speciesId);
      const moveIds = moveIdsFromPokemon(p);
      const pp: Record<string, number> = {};
      for (const m of p.moves ?? []) {
        if (m && typeof m === 'object' && m.id) pp[m.id] = m.pp;
      }
      const parsed = parseDetails(p.details);
      const revealed = existing?.revealedMoves?.length
        ? uniqueIds([...existing.revealedMoves, ...moveIds])
        : (moveIds.length ? moveIds : Object.keys(pp));
      const mon: TrackedMon = {
        slot: splitIdentity(p.ident).slot, side: sideId, identity: p.ident,
        speciesId, details: p.details,
        hp: parsedCond.hp, maxHp: parsedCond.maxHp > 0 ? parsedCond.maxHp : (existing?.maxHp ?? 0),
        status: parsedCond.status,
        boosts: existing?.boosts ?? emptyBoosts(),
        pp, lastMove: existing?.lastMove,
        revealedMoves: revealed,
        item: toId(p.item || '') || existing?.item,
        ability: toId(p.baseAbility || '') || existing?.ability,
        level: parsed.level ?? existing?.level,
        teraType: p.teraType || parsed.teraType || existing?.teraType,
        choiceLock: existing?.choiceLock,
        tauntTurns: existing?.tauntTurns ?? 0, fainted: parsedCond.fainted || parsedCond.hp <= 0, active: !!p.active,
      };
      if (p.terastallized) this.teraUsedOurs = true;
      next.set(key, mon);
    }
    this.myMons = next;
    const firstActive = json.active?.[0];
    const firstPoke = pokemon.find((p) => p.active) ?? pokemon[0];
    if (firstActive && firstPoke) {
      const activeMon = this.myMons.get(monKey(firstPoke.ident, speciesIdFromDetails(firstPoke.details)));
      const moves = firstActive.moves ?? [];
      if (activeMon) {
        const fromActive = moves.map((m) => m.id).filter(Boolean);
        if (fromActive.length) activeMon.revealedMoves = uniqueIds([...activeMon.revealedMoves, ...fromActive]);
        for (const m of moves) if (m.id) activeMon.pp[m.id] = m.pp;
      }
      const enabled = moves.filter((m) => !m.disabled);
      if (moves.length >= 2 && enabled.length === 1 && activeMon) activeMon.choiceLock = enabled[0]!.id;
    }
  }

  /** Build the immutable observation the engine consumes. */
  toObservation(
    pool: RandomSetPool,
    ourSets: CanonicalSet[],
    overrides?: SetOverridesStore | string,
  ): BattleObservation {
    const store = resolveOverrides(overrides);
    const format = 'gen9randombattle';
    const ours: SlotSnapshot[] = [];
    const myList = [...this.myMons.values()];
    for (let i = 0; i < 6; i++) {
      const m = myList[i];
      const fromFlag = ourSets[i];
      if (!m) {
        const slot = placeholderSlot(i);
        if (fromFlag && setIsComplete(fromFlag)) {
          slot.speciesId = fromFlag.species;
          slot.set = fromFlag;
          slot.revealed = true;
          slot.setComplete = true;
          slot.setSource = 'revealed';
        }
        ours.push(slot);
        continue;
      }
      ours.push(ourSlotFromMon(i, m, fromFlag, store, format, pool));
    }

    const theirs: SlotSnapshot[] = [];
    const oppList = [...this.oppMons.values()];
    for (let i = 0; i < 6; i++) {
      const m = oppList[i];
      if (!m) {
        theirs.push(placeholderSlot(i));
        continue;
      }
      theirs.push(theirSlotFromMon(i, m, pool, store, format));
    }

    const weather = this.field.weather;
    for (const s of ours) s.modifiers = modifiersFromSlot(s, weather);
    for (const s of theirs) s.modifiers = modifiersFromSlot(s, weather);

    const legalActions = enumerateFromRequest(this.lastRequest ?? undefined, this.teraUsedOurs);
    const obs: BattleObservation = {
      turn: this.turn,
      format,
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
      teraUsedOurs: this.teraUsedOurs,
      teraUsedTheirs: this.teraUsedTheirs,
    };
    return obs;
  }
}

export function battleStateFromEvents(
  events: BattleEvent[],
  pool: RandomSetPool,
  ourSets: CanonicalSet[] = [],
  overrides?: SetOverridesStore | string,
): BattleObservation {
  const t = new BattleTracker();
  for (const ev of events) t.apply(ev);
  return t.toObservation(pool, ourSets, overrides);
}

function resolveOverrides(overrides?: SetOverridesStore | string): SetOverridesStore {
  if (typeof overrides === 'string') return loadSetOverrides(overrides);
  return overrides ?? { version: 1, overrides: {} };
}

function moveIdsFromPokemon(p: RequestPokemon): string[] {
  const ids: string[] = [];
  for (const m of p.moves ?? []) {
    if (typeof m === 'string' && m.trim()) ids.push(toId(m));
    else if (m && typeof m === 'object') {
      const id = toId(m.id || m.move || '');
      if (id) ids.push(id);
    }
  }
  return uniqueIds(ids);
}

function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const k = toId(id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function setFromTracked(m: TrackedMon): CanonicalSet {
  const moves = m.revealedMoves.length ? [...m.revealedMoves] : Object.keys(m.pp);
  return {
    species: m.speciesId,
    level: m.level && m.level >= 1 && m.level <= 100 ? m.level : DEFAULT_LEVEL,
    item: m.item ?? '',
    ability: m.ability ?? '',
    moves,
    nature: DEFAULT_NATURE,
    teraType: m.teraType,
  };
}

function factsFromMon(m: TrackedMon, ours: boolean): RevealedFacts {
  const moves = ours
    ? (Object.keys(m.pp).length ? uniqueIds([...Object.keys(m.pp), ...m.revealedMoves]) : (m.revealedMoves ?? []))
    : (m.revealedMoves.length ? m.revealedMoves : (m.lastMove ? [m.lastMove] : []));
  return {
    species: m.speciesId,
    moves,
    item: m.item,
    ability: m.ability,
    level: m.level,
    teraType: m.teraType,
  };
}

function publicSetFor(pool: RandomSetPool, facts: RevealedFacts): CanonicalSet | undefined {
  try {
    const filtered = initialBelief(pool, facts);
    if (filtered[0]?.set) return overlayRevealedOnSet(filtered[0].set, facts);
  } catch { /* no compatible row; fall through */ }
  try {
    const raw = hypothesesForSpecies(pool, facts.species);
    if (raw[0]?.set) return overlayRevealedOnSet(raw[0].set, facts);
  } catch { /* species missing from pool */ }
  return undefined;
}

function ourSlotFromMon(
  i: number,
  m: TrackedMon,
  fromFlag: CanonicalSet | undefined,
  store: SetOverridesStore,
  format: string,
  pool: RandomSetPool,
): SlotSnapshot {
  const facts = factsFromMon(m, true);
  const setOptions = setOptionsFromPool(pool, m.speciesId, facts);
  const override = getSetOverride(store, format, m.speciesId);
  let set = fromFlag;
  let setSource: SetSource = 'revealed';
  let setWarning: string | undefined;
  if (override && setIsComplete(override)) {
    if (compatible(override, facts)) {
      set = overlayRevealedOnSet(override, facts);
      setSource = 'manual';
    } else {
      setWarning = `Assumed set for ${m.speciesId} conflicts with revealed facts; using revealed set`;
    }
  }
  if (!(set && setIsComplete(set))) {
    const publicSet = setOptions.find((o) => o.compatible)?.set ?? setOptions[0]?.set ?? publicSetFor(pool, facts);
    if (publicSet) {
      set = overlayRevealedOnSet(publicSet, facts);
      setSource = setIsComplete(set) ? (facts.moves.length >= 4 ? 'revealed' : 'public') : 'incomplete';
    } else {
      set = setFromTracked(m);
      setSource = setIsComplete(set) ? 'revealed' : 'incomplete';
    }
  }
  const used = set ?? setFromTracked(m);
  const complete = setIsComplete(used);
  return {
    slot: i,
    speciesId: m.speciesId,
    revealed: true,
    hp: m.hp,
    maxHp: m.maxHp || 100,
    status: m.status,
    boosts: { ...m.boosts },
    fainted: m.fainted,
    active: m.active,
    item: m.item || used.item,
    ability: m.ability || used.ability,
    teraType: m.teraType,
    level: m.level,
    knownMoves: facts.moves,
    set: used,
    setSource: complete ? setSource : 'incomplete',
    setComplete: complete,
    setWarning,
    hypotheses: [],
    setOptions,
    modifiers: [],
  };
}

function theirSlotFromMon(
  i: number,
  m: TrackedMon,
  pool: RandomSetPool,
  store: SetOverridesStore,
  format: string,
): SlotSnapshot {
  const facts = factsFromMon(m, false);
  const setOptions = setOptionsFromPool(pool, m.speciesId, facts);
  let hypotheses: SetHypothesis[] = [];
  try {
    hypotheses = initialBelief(pool, facts);
  } catch {
    try {
      hypotheses = hypothesesForSpecies(pool, facts.species);
    } catch (err) {
      console.error(`[pokeredus] ${err instanceof Error ? err.message : err}`);
    }
  }
  const override = getSetOverride(store, format, m.speciesId);
  let set = hypotheses[0]?.set ?? setOptions.find((o) => o.compatible)?.set ?? setOptions[0]?.set;
  let setSource: SetSource = set ? 'public' : 'incomplete';
  let candidateProbability = hypotheses[0]?.probability;
  let setWarning: string | undefined;
  if (override) {
    if (compatible(override, facts)) {
      set = override;
      setSource = 'manual';
      candidateProbability = undefined;
    } else {
      setWarning = `Assumed set for ${m.speciesId} conflicts with revealed facts; using public candidate`;
      console.error(`[pokeredus] ${setWarning}`);
    }
  }
  if (set) {
    set = overlayRevealedOnSet(set, facts);
  }
  const complete = setIsComplete(set);
  return {
    slot: i,
    speciesId: m.speciesId,
    revealed: true,
    hp: m.hp,
    maxHp: m.maxHp || 100,
    status: m.status,
    boosts: { ...m.boosts },
    fainted: m.fainted,
    active: m.active,
    knownMoves: facts.moves,
    item: m.item || set?.item,
    ability: m.ability || set?.ability,
    teraType: m.teraType,
    level: m.level,
    hypotheses,
    setOptions,
    set,
    setSource: complete ? setSource : 'incomplete',
    candidateProbability,
    setComplete: complete,
    setWarning,
    modifiers: [],
  };
}
