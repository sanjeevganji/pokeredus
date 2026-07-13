// Showdown battle-protocol parser + live state tracker.
//
// Pokémon Showdown speaks a line-delimited protocol over websocket. Each line
// is `|`-prefixed and carries one event. This module:
//   1. `parseLine(line)` → a structured `BattleEvent` (zod-free, trust-boundary
//      parsing with safe defaults — `noUncheckedIndexedAccess` keeps us honest).
//   2. `BattleTracker` — a stateful accumulator that folds a stream of
//      `BattleEvent`s into the normalized `TurnState` the runtime engine
//      consumes. The bridge keeps one tracker per battle and calls
//      `toTurnState(pack)` whenever a `|request|` arrives.
//   3. `resolveSetId(speciesId, pack)` — maps a Showdown species id (e.g.
//      `garchomp`, `arcaninehisui`) onto the best-matching Knowledge-Pack set id.
//
// Protocol reference: https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md
// Last verified against PS protocol: 2026-07-08.
//
// ponytail: ceiling — this tracks singles (one active slot per side). Doubles
// would expose pXa/pXb/pXc active slots; extend `toTurnState` when needed.

import type { TurnState, ActiveMon, FieldFlags, Side } from '@pokeredus/engine';
import { makeMon, emptyField } from '@pokeredus/engine';
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
  | { type: 'fieldstart'; side: PlayerSide; effect: string }
  | { type: 'fieldend'; side: PlayerSide; effect: string }
  | { type: 'weather'; weather: string }
  | { type: 'terrain'; terrain: string }
  | { type: 'sidestart'; side: PlayerSide; effect: string }
  | { type: 'sideend'; side: PlayerSide; effect: string }
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

function speciesIdFromDetails(details: string): string {
  const name = (details ?? '').split(',')[0] ?? '';
  return toId(name);
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
      return { type: 'fieldstart', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };
    case '-fieldend':
      return { type: 'fieldend', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };
    case '-weather':
      return { type: 'weather', weather: toId(parts[2] ?? '') };
    case '-terrain':
      return { type: 'terrain', terrain: toId(parts[2] ?? '') };
    case '-sidestart':
      return { type: 'sidestart', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };
    case '-sideend':
      return { type: 'sideend', side: sideFromPlayer(parts[2] ?? ''), effect: parts[3] ?? '' };

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
// BattleTracker — fold events into a TurnState
// ──────────────────────────────────────────────────────────────────────
interface BoostState {
  atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number;
}
function emptyBoosts(): BoostState {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
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
  field: FieldFlags = emptyField();
  teraUsed = false;

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
        this.applyRequest(ev.json);
        break;

      case 'switch':
      case 'drag': {
        const mon: TrackedMon = {
          slot: ev.slot, side: ev.side, identity: ev.identity, speciesId: ev.speciesId, details: ev.details,
          hp: ev.hp, maxHp: ev.maxHp, status: ev.status,
          boosts: emptyBoosts(), pp: {}, tauntTurns: 0, fainted: ev.status === 'fnt' || ev.hp <= 0, active: true,
        };
        (ev.side === 'p1' ? this.myMons : this.oppMons).set(ev.slot, mon);
        break;
      }

      case '-damage':
      case '-heal': {
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
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
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
        if (mon) mon.status = ev.status;
        break;
      }

      case 'faint': {
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
        if (mon) { mon.fainted = true; mon.hp = 0; mon.status = 'fnt'; }
        break;
      }

      case '-boost':
      case '-unboost': {
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
        if (mon && ev.stat in mon.boosts) {
          const cur = mon.boosts[ev.stat as keyof BoostState];
          mon.boosts[ev.stat as keyof BoostState] = Math.max(-6, Math.min(6, cur + (ev.type === '-boost' ? ev.amount : -ev.amount)));
        }
        break;
      }

      case '-start':
      case '-end': {
        const on = ev.type === '-start';
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
        if (mon && ev.effect.toLowerCase().includes('taunt')) mon.tauntTurns = on ? 3 : 0;
        break;
      }

      case 'move': {
        const mon = (ev.side === 'p1' ? this.myMons : this.oppMons).get(ev.slot);
        if (mon) mon.lastMove = ev.moveId;
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
        if (eff.includes('reflect')) {
          if (ev.side === 'p1') this.field.reflect_a = on ? 5 : 0; else this.field.reflect_b = on ? 5 : 0;
        } else if (eff.includes('light screen')) {
          if (ev.side === 'p1') this.field.lightscreen_a = on ? 5 : 0; else this.field.lightscreen_b = on ? 5 : 0;
        } else if (eff.includes('trick room')) {
          this.field.trickroom = on;
        }
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
        break;
      }

      // init / win / raw / other: nothing to fold into TurnState.
      default:
        break;
    }
  }

  private applyRequest(json: RequestJson): void {
    const sideId = (json.side?.id === 'p2' ? 'p2' : 'p1') as PlayerSide;
    this.ourSide = sideId;
    const pokemon = json.side?.pokemon ?? [];
    for (const p of pokemon) {
      const { slot } = splitIdentity(p.ident);
      const { hp, status } = parseCondition(p.condition);
      const existing = this.myMons.get(slot);
      const pp: Record<string, number> = {};
      for (const m of p.moves ?? []) pp[m.id] = m.pp;
      const mon: TrackedMon = {
        slot, side: sideId, identity: p.ident,
        speciesId: speciesIdFromDetails(p.details), details: p.details,
        hp, maxHp: existing?.maxHp ?? 0, status,
        boosts: existing?.boosts ?? emptyBoosts(),
        pp, lastMove: existing?.lastMove, choiceLock: existing?.choiceLock,
        tauntTurns: existing?.tauntTurns ?? 0, fainted: hp <= 0, active: !!p.active,
      };
      if (p.terastallized) this.teraUsed = true;
      this.myMons.set(slot, mon);
    }
    // Choice-item lock detection: if all-but-one active move is disabled.
    const firstActive = json.active?.[0];
    const firstPoke = pokemon[0];
    if (firstActive && firstPoke) {
      const activeMon = this.myMons.get(splitIdentity(firstPoke.ident).slot);
      const moves = firstActive.moves ?? [];
      const enabled = moves.filter((m) => !m.disabled);
      if (moves.length >= 2 && enabled.length === 1) activeMon!.choiceLock = enabled[0]!.id;
    }
  }

  /** Build the normalized TurnState the engine consumes. */
  toTurnState(pack: PackIndex, opts?: { allowThin?: boolean }): TurnState {
    const myActiveKey = this.ourSide + 'a';
    const oppActiveKey = (this.ourSide === 'p1' ? 'p2' : 'p1') + 'a';

    const toActiveMon = (m?: TrackedMon): ActiveMon => {
      if (!m) return makeMon('', 1);
      return {
        setId: resolveSetId(m.speciesId, pack) ?? '',
        hp: m.hp,
        maxHp: m.maxHp,
        status: m.status,
        boosts: { ...m.boosts },
        pp: { ...m.pp },
        lastMove: m.lastMove,
        choiceLock: m.choiceLock,
        tauntTurns: m.tauntTurns,
        fainted: m.fainted,
      };
    };

    const myBench: ActiveMon[] = [];
    for (const [slot, m] of this.myMons) {
      if (slot !== myActiveKey) myBench.push(toActiveMon(m));
    }

    return {
      side: (this.ourSide === 'p1' ? 'a' : 'b') as Side,
      turn: this.turn,
      myActive: toActiveMon(this.myMons.get(myActiveKey)),
      myBench,
      oppActive: toActiveMon(this.oppMons.get(oppActiveKey)),
      field: { ...this.field },
      teraUsed: this.teraUsed,
      allowThin: opts?.allowThin ?? false,
    };
  }
}

function normalizeWeather(w: string): FieldFlags['weather'] {
  if (w === 'rain' || w === 'raindance' || w === 'harshrain') return 'rain';
  if (w === 'sunny' || w === 'sunnyday' || w === 'harshsunlight') return 'sunny';
  if (w === 'sandstorm') return 'sandstorm';
  if (w === 'hail' || w === 'snow') return 'snow';
  return '';
}

function normalizeTerrain(t: string): FieldFlags['terrain'] {
  if (t === 'electricterrain') return 'electric';
  if (t === 'grassyterrain') return 'grassy';
  if (t === 'mistyterrain') return 'misty';
  if (t === 'psychicterrain') return 'psychic';
  return '';
}

// ──────────────────────────────────────────────────────────────────────
// battleStateFromEvents — one-shot reducer (used by tests / offline replay)
// ──────────────────────────────────────────────────────────────────────
/**
 * Fold a batch of events into a TurnState, optionally seeding turn/field/side
 * from a prior snapshot. The bridge normally keeps a long-lived `BattleTracker`
 * instead; this is the single-batch convenience the plan names.
 */
export function battleStateFromEvents(
  events: BattleEvent[],
  prior: TurnState | null,
  pack: PackIndex,
  opts?: { allowThin?: boolean },
): TurnState {
  const t = new BattleTracker();
  if (prior) {
    t.turn = prior.turn;
    t.field = { ...prior.field };
    t.teraUsed = prior.teraUsed;
    t.ourSide = prior.side === 'a' ? 'p1' : 'p2';
  }
  for (const ev of events) t.apply(ev);
  return t.toTurnState(pack, opts);
}
