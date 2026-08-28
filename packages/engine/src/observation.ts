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
  /** Remaining Showdown turns when observed; absence means unknown, not a default. */
  weatherTurns?: number;
  terrainTurns?: number;
  trickroomTurns?: number;
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
  teraTypes?: string[];
  role?: string;
  movePool?: string[];
  evs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
  ivs?: Partial<Record<'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe', number>>;
}

export interface SetOption {
  role: string;
  teraTypes: string[];
  compatible: boolean;
  set: CanonicalSet;
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

export type SetSource = 'revealed' | 'manual' | 'public' | 'incomplete';

export interface MoveSlotSnapshot {
  id: string;
  pp: number;
  maxpp: number;
  disabled?: boolean;
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
  terastallized?: boolean;
  level?: number;
  knownMoves: string[];
  moveSlots?: MoveSlotSnapshot[];
  choiceLock?: string;
  trapped?: boolean;
  set?: CanonicalSet;
  setSource?: SetSource;
  candidateProbability?: number;
  setComplete?: boolean;
  setWarning?: string;
  hypotheses: SetHypothesis[];
  setOptions?: SetOption[];
  modifiers: Modifier[];
}

export interface Modifier {
  name: string;
  multiplier: number;
  remainingTurns: number;
  /** Occurrence probability in [0, 1]. Absent means 1 (already realized or guaranteed). */
  probability?: number;
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
  teraUsedOurs: boolean;
  teraUsedTheirs: boolean;
}

export interface MonValue {
  side: 'ours' | 'theirs';
  revealed: boolean;
  h: number;
  L: number;
  M: number;
}

export interface ChoiceFeaturesView {
  health: number;
  modifier: number;
  secondary: number;
  switchRisk: number;
  sacrifice: number;
}

export interface ChoiceEvaluation {
  action: LegalAction;
  success: number;
  cta?: number;
  cts?: number;
  expectedImpact: number;
  expectedHealthDelta: number;
  expectedModifierDelta: number;
  ourHealth: number;
  theirHealth: number;
  ourModifier: number;
  theirModifier: number;
  hitsToKill: number | null;
  choiceScore: number;
  scaledChoiceScore: number;
  meanPostScore: number;
  minTurnScore: number;
  maxTurnScore: number;
  minPostScore: number;
  maxPostScore: number;
  sampleCount: number;
  features: ChoiceFeaturesView;
  probability?: number;
  /** Final belief- and reply-weighted E[D] from our perspective. */
  expectedUtility?: number;
}

export interface ReplyEvaluation {
  action: LegalAction;
  success?: number;
  cta?: number;
  cts?: number;
  expectedImpact: number;
  hitsToKillUs: number | null;
  choiceScore: number;
  expectedHealthDelta?: number;
  expectedModifierDelta?: number;
  ourHealth?: number;
  theirHealth?: number;
  ourModifier?: number;
  theirModifier?: number;
  features?: ChoiceFeaturesView;
  probability?: number;
  minTurnScore?: number;
  maxTurnScore?: number;
  meanPostScore?: number;
  minPostScore?: number;
  maxPostScore?: number;
  sampleCount?: number;
}

export interface PairScore {
  ourId: string;
  theirId: string;
  score: number;
}

export interface RoundEvaluation {
  choices: ChoiceEvaluation[];
  replies: ReplyEvaluation[];
  /** Alias of expectedRoundScore until live snapshots migrate (plan 005). */
  roundScore: number;
  expectedRoundScore: number;
  minRoundScore: number;
  maxRoundScore: number;
  forcedOutcome: ForcedOutcome;
  mateProbability: number;
  pairs?: PairScore[];
  diagnostics?: Record<string, unknown>;
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
    setComplete: false,
    setSource: 'incomplete',
  };
}

export function actionId(a: { type: ActionKind; moveId?: string; tera?: boolean; slot?: number }): string {
  if (a.type === 'switch') return `switch:${a.slot ?? 0}`;
  return `move:${a.moveId ?? ''}${a.tera ? ':tera' : ''}`;
}

/** Read-boundary for old snapshots that still have `teraUsed`. */
export function observationTera(obs: {
  teraUsedOurs?: boolean;
  teraUsedTheirs?: boolean;
  teraUsed?: boolean;
}): { ours: boolean; theirs: boolean } {
  return {
    ours: obs.teraUsedOurs ?? obs.teraUsed ?? false,
    theirs: obs.teraUsedTheirs ?? false,
  };
}

export function normalizeWeather(w: string): string {
  const id = w.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id === 'rain' || id === 'raindance' || id === 'primordialsea' || id === 'harshrain') return 'rain';
  if (id === 'sunny' || id === 'sunnyday' || id === 'sun' || id === 'desolateland' || id === 'harshsunlight') return 'sunny';
  if (id === 'sandstorm') return 'sandstorm';
  if (id === 'hail' || id === 'snow') return 'snow';
  return '';
}

export function showdownWeather(w: string): string {
  const n = normalizeWeather(w);
  if (n === 'rain') return 'raindance';
  if (n === 'sunny') return 'sunnyday';
  if (n === 'sandstorm') return 'sandstorm';
  if (n === 'snow') return 'snow';
  return '';
}

export function normalizeTerrain(t: string): string {
  const id = t.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (id === 'electric' || id === 'electricterrain') return 'electric';
  if (id === 'grassy' || id === 'grassyterrain') return 'grassy';
  if (id === 'misty' || id === 'mistyterrain') return 'misty';
  if (id === 'psychic' || id === 'psychicterrain') return 'psychic';
  return '';
}

export function showdownTerrain(t: string): string {
  const n = normalizeTerrain(t);
  if (n === 'electric') return 'electricterrain';
  if (n === 'grassy') return 'grassyterrain';
  if (n === 'misty') return 'mistyterrain';
  if (n === 'psychic') return 'psychicterrain';
  return '';
}
