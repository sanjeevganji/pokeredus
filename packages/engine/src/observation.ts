export type PlayerSide = 'p1' | 'p2';
export type ActionKind = 'move' | 'switch';
export type ForcedOutcome = 'win' | 'loss' | 'none';
export type PolicyMode = 'quantum' | 'softmax';

export interface Boosts {
  atk: number;
  def: number;
  spa: number;
  spd: number;
  spe: number;
  accuracy: number;
  evasion: number;
}

export interface FieldSnapshot {
  weather: string;
  terrain: string;
  trickroom: boolean;
  hazards_p1: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  hazards_p2: { stealthrock: boolean; spikes: number; toxicspikes: number; stickyweb: boolean };
  reflect_p1: number;
  reflect_p2: number;
  lightscreen_p1: number;
  lightscreen_p2: number;
}

export interface CanonicalSet {
  species: string;
  level: number;
  item: string;
  ability: string;
  moves: string[];
  nature: string;
  gender?: string;
  teraType?: string;
  evs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  ivs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
}

export interface SetHypothesis {
  set: CanonicalSet;
  count: number;
  probability: number;
}

export interface RevealedFacts {
  species: string;
  moves: string[];
  item?: string;
  ability?: string;
  level?: number;
  teraType?: string;
}

export interface LegalAction {
  id: string;
  type: ActionKind;
  moveId?: string;
  tera?: boolean;
  slot?: number;
  forced?: boolean;
}

export interface SlotSnapshot {
  slot: number;
  speciesId: string;
  revealed: boolean;
  hp: number;
  maxHp: number;
  status: string;
  boosts: Boosts;
  fainted: boolean;
  active: boolean;
  item?: string;
  ability?: string;
  teraType?: string;
  knownMoves: string[];
  set?: CanonicalSet;
  hypotheses: SetHypothesis[];
  modifiers: Modifier[];
}

export interface Modifier {
  name: string;
  multiplier: number;
  remainingTurns: number;
}

export interface BattleObservation {
  turn: number;
  format: string;
  ourSide: PlayerSide;
  ours: SlotSnapshot[];
  theirs: SlotSnapshot[];
  field: FieldSnapshot;
  request?: unknown;
  legalActions: LegalAction[];
  teraUsed: boolean;
}

export interface MonValue {
  side: 'ours' | 'theirs';
  revealed: boolean;
  h: number;
  L: number;
  M: number;
}

export interface ChoiceEvaluation {
  action: LegalAction;
  success: number;
  cta?: number;
  cts?: number;
  expectedImpact: number;
  expectedHealthDelta: number;
  expectedModifierDelta: number;
  hitsToKill: number | null;
  choiceScore: number;
  scaledChoiceScore: number;
  meanPostScore: number;
}

export interface ReplyEvaluation {
  action: LegalAction;
  expectedImpact: number;
  hitsToKillUs: number | null;
}

export interface RoundEvaluation {
  choices: ChoiceEvaluation[];
  replies: ReplyEvaluation[];
  roundScore: number;
  forcedOutcome: ForcedOutcome;
  mateProbability: number;
}

export function emptyBoosts(): Boosts {
  return { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 };
}

export function emptyField(): FieldSnapshot {
  return {
    weather: '',
    terrain: '',
    trickroom: false,
    hazards_p1: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    hazards_p2: { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false },
    reflect_p1: 0,
    reflect_p2: 0,
    lightscreen_p1: 0,
    lightscreen_p2: 0,
  };
}

export function placeholderSet(): CanonicalSet {
  return {
    species: 'smeargle',
    level: 100,
    item: '',
    ability: 'owntempo',
    moves: ['splash'],
    nature: 'hardy',
  };
}

export function placeholderSlot(slot: number): SlotSnapshot {
  return {
    slot,
    speciesId: 'smeargle',
    revealed: false,
    hp: 100,
    maxHp: 100,
    status: '',
    boosts: emptyBoosts(),
    fainted: false,
    active: false,
    knownMoves: [],
    hypotheses: [],
    modifiers: [],
  };
}

export function actionId(a: { type: ActionKind; moveId?: string; tera?: boolean; slot?: number }): string {
  if (a.type === 'switch') return `switch:${a.slot ?? 0}`;
  return `move:${a.moveId ?? ''}${a.tera ? ':tera' : ''}`;
}
