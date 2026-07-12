// TurnState — the normalized game state passed from the Showdown bridge
// to the runtime engine. Mirrors the Python unified/__init__.py UnifiedAction
// action model.

export type Side = 'a' | 'b';
export type ActionKind = 'move' | 'switch';

export interface Action {
  type: ActionKind;
  /** For move actions: the move ID (lowercase, no spaces — Showdown format). */
  moveId?: string;
  /** Whether this move uses Terastallize. */
  tera?: boolean;
  /** For switch actions: bench slot index (0-based). */
  slot?: number;
}

export interface ActiveMon {
  /** The set ID from the Knowledge Pack that best matches this mon. */
  setId: string;
  /** Current HP (absolute). */
  hp: number;
  /** Max HP. */
  maxHp: number;
  /** Status condition: '' (none), 'brn', 'par', 'slp', 'frz', 'psn', 'tox'. */
  status: string;
  /** Stat boosts: {atk, def, spa, spd, spe, accuracy, evasion} each in [-6, +6]. */
  boosts: { atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number };
  /** Remaining PP per move id: { earthquake: 10, ... }. */
  pp: Record<string, number>;
  /** Last move used (move id) — for Choice lock detection. */
  lastMove?: string;
  /** Choice item lock — the move id that's locked in, if any. */
  choiceLock?: string;
  /** Remaining Taunt turns (>0 means Taunt is active). */
  tauntTurns: number;
  /** Whether this mon has fainted. */
  fainted: boolean;
}

export interface FieldFlags {
  weather: '' | 'sunny' | 'rain' | 'sandstorm' | 'snow';
  terrain: '' | 'electric' | 'grassy' | 'psychic' | 'misty';
  hazards_a: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  hazards_b: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  reflect_a: number; reflect_b: number;  // turns remaining
  lightscreen_a: number; lightscreen_b: number;
  trickroom: boolean;
}

export interface TurnState {
  side: Side;
  turn: number;
  myActive: ActiveMon;
  myBench: ActiveMon[];
  oppActive: ActiveMon;
  field: FieldFlags;
  teraUsed: boolean;
  /** Allow running with a truncated pack (mini pack in tests). */
  allowThin?: boolean;
}

function emptyBoosts() {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

export function emptyField(): FieldFlags {
  return {
    weather: '', terrain: '',
    hazards_a: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    hazards_b: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    reflect_a: 0, reflect_b: 0, lightscreen_a: 0, lightscreen_b: 0,
    trickroom: false,
  };
}

export function makeMon(setId: string, maxHp: number): ActiveMon {
  return {
    setId, hp: maxHp, maxHp, status: '',
    boosts: emptyBoosts(), pp: {}, tauntTurns: 0, fainted: false,
  };
}
