export type Side = 'a' | 'b';
export type ActionKind = 'move' | 'switch';

export interface Action {
  type: ActionKind;
  moveId?: string;
  tera?: boolean;
  slot?: number;
}

export interface ActiveMon {
  setId: string;
  hp: number;
  maxHp: number;
  status: string;
  boosts: { atk: number; def: number; spa: number; spd: number; spe: number; accuracy: number; evasion: number };
  pp: Record<string, number>;
  lastMove?: string;
  choiceLock?: string;
  tauntTurns: number;
  fainted: boolean;
}

export interface FieldFlags {
  weather: '' | 'sunny' | 'rain' | 'sandstorm' | 'snow';
  terrain: '' | 'electric' | 'grassy' | 'psychic' | 'misty';
  hazards_a: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  hazards_b: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  reflect_a: number; reflect_b: number;
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
