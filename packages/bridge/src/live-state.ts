// Compact battle HUD snapshot for the PokeRedus game-state screen.
// The live CLI overwrites this JSON; the GUI polls it. No sockets.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BattleForecast,
  BattleObservation,
  Boosts,
  CanonicalSet,
  ChoiceFeaturesView,
  FieldSnapshot,
  ScoreWeights,
  SetOption,
  SetSource,
  SlotSnapshot,
} from '@pokeredus/engine';
import {
  emptyBoosts,
  loadWeights,
  modifiersFromSlot,
  observationStateScore,
} from '@pokeredus/engine';
import type { DecideResult } from './decide.js';
import type { BattleEvent, BattleTracker } from './protocol.js';

export const MAX_LIVE_EVENTS = 40;
export const MAX_LIVE_TURNS = 64;
export const MAX_LIVE_POINTS = 64;
export const LIVE_SLOT_COUNT = 6;
export const LIVE_SCHEMA_VERSION = 2;

export type LiveStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'waiting'
  | 'deciding'
  | 'ended'
  | 'error';

export interface LiveSlot {
  speciesId: string;
  hp: number;
  maxHp: number;
  status: string;
  fainted: boolean;
  active: boolean;
  revealed: boolean;
  boosts: Boosts;
  modifiers: { name: string; multiplier: number; remainingTurns: number }[];
  item?: string;
  ability?: string;
  teraType?: string;
  level?: number;
  knownMoves?: string[];
  setSource?: SetSource;
  assumedSet?: CanonicalSet;
  setOptions?: SetOption[];
  candidateProbability?: number;
  setComplete: boolean;
  setWarning?: string;
}

export interface LiveChoice {
  id: string;
  type: string;
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
  scaledChoiceScore?: number;
  meanPostScore?: number;
  minTurnScore?: number;
  maxTurnScore?: number;
  minPostScore?: number;
  maxPostScore?: number;
  sampleCount?: number;
  features?: ChoiceFeaturesView;
  probability?: number;
  policyWeight?: number;
  hamiltonianInput?: number;
  expectedTerminalScore?: number;
  minTerminalScore?: number;
  maxTerminalScore?: number;
  winRate?: number;
  winRateLow?: number;
  winRateHigh?: number;
  wins?: number;
  losses?: number;
  draws?: number;
  capped?: number;
  samples?: number;
}

export interface LiveReply {
  id: string;
  type: string;
  expectedImpact: number;
  hitsToKillUs: number | null;
  choiceScore?: number;
  probability?: number;
  policyWeight?: number;
  hamiltonianInput?: number;
  expectedHealthDelta?: number;
  expectedModifierDelta?: number;
  ourHealth?: number;
  theirHealth?: number;
  ourModifier?: number;
  theirModifier?: number;
  features?: ChoiceFeaturesView;
  minTurnScore?: number;
  maxTurnScore?: number;
  meanPostScore?: number;
  minPostScore?: number;
  maxPostScore?: number;
  sampleCount?: number;
  expectedTerminalScore?: number;
  minTerminalScore?: number;
  maxTerminalScore?: number;
  winRate?: number;
  winRateLow?: number;
  winRateHigh?: number;
  samples?: number;
}

export interface LiveQuantum {
  mode: string;
  nQubits?: number;
  shots?: number;
  exact?: boolean;
  params?: number[];
  cost?: number;
}

export interface LiveScorePoint {
  sequence: number;
  turn: number;
  actionId: string;
  actionKind: 'move' | 'switch';
  tera: boolean;
  status: 'forecast' | 'settled' | 'unresolved';
  expectedDelta: number;
  minDelta: number;
  maxDelta: number;
  realizedDelta?: number;
  cumulativeTotal: number;
  expectedTotal: number;
  minTotal: number;
  maxTotal: number;
  samples: number;
}

export interface LiveEval {
  roundScore: number;
  expectedRoundScore?: number;
  minRoundScore?: number;
  maxRoundScore?: number;
  forcedOutcome: string;
  mateProbability: number;
  sampledAction: string;
  choices: LiveChoice[];
  replies: LiveReply[];
  teraChoices?: LiveChoice[];
  teraReplies?: LiveReply[];
  quantum?: LiveQuantum;
  forecast?: BattleForecast;
  scoreWeights?: ScoreWeights;
}

export interface LiveTurn {
  turn: number;
  roundScore: number;
  sampledAction: string;
}

export interface LiveHazards {
  stealthrock: boolean;
  spikes: number;
  toxicspikes: number;
  stickyweb: boolean;
}

export interface LiveSideField {
  hazards: LiveHazards;
  reflect: number;
  lightscreen: number;
}

export interface LiveField {
  weather: string;
  terrain: string;
  trickroom: boolean;
  ours: LiveSideField;
  theirs: LiveSideField;
}

export interface LiveEvent {
  ts: string;
  text: string;
}

export interface LiveState {
  schemaVersion?: number;
  ts: string;
  status: LiveStatus;
  room: string;
  dryRun: boolean;
  policy: string;
  turn: number;
  winner?: string;
  oursName?: string;
  theirsName?: string;
  teraUsedOurs?: boolean;
  teraUsedTheirs?: boolean;
  field: LiveField;
  ours: LiveSlot[];
  theirs: LiveSlot[];
  eval?: LiveEval;
  points?: LiveScorePoint[];
  turns: LiveTurn[];
  events: LiveEvent[];
  error?: string;
  warnings?: string[];
}

export function livePlayers(tracker: BattleTracker): {
  oursName: string;
  theirsName: string;
  teraUsedOurs: boolean;
  teraUsedTheirs: boolean;
} {
  const oursName = tracker.ourSide === 'p2' ? tracker.p2Name : tracker.p1Name;
  const theirsName = tracker.ourSide === 'p2' ? tracker.p1Name : tracker.p2Name;
  return {
    oursName,
    theirsName,
    teraUsedOurs: tracker.teraUsedOurs,
    teraUsedTheirs: tracker.teraUsedTheirs,
  };
}

export function defaultLiveStatePath(): string {
  return process.env.POKELINK_STATE || path.resolve('live-state.json');
}

export function defaultLiveObservationPath(statePath = defaultLiveStatePath()): string {
  return path.join(path.dirname(path.resolve(statePath)), 'live-observation.json');
}

export function summarizeEvent(ev: BattleEvent): string | null {
  switch (ev.type) {
    case 'turn':
      return `Turn ${ev.num}`;
    case 'switch':
    case 'drag':
      return `${identityName(ev.identity)} in (${hpText(ev.hp, ev.maxHp)})`;
    case 'move':
      return `${identityName(ev.identity)} used ${ev.moveId}`;
    case '-damage':
      return `${identityName(ev.identity)} ${hpText(ev.hp, ev.maxHp)}${ev.fainted ? ' fainted' : ''}`;
    case '-heal':
      return `${identityName(ev.identity)} healed ${hpText(ev.hp, ev.maxHp)}`;
    case 'faint':
      return `${identityName(ev.identity)} fainted`;
    case '-status':
      return `${identityName(ev.identity)} ${ev.status}`;
    case '-boost':
      return `${identityName(ev.identity)} +${ev.stat}`;
    case '-unboost':
      return `${identityName(ev.identity)} -${ev.stat}`;
    case 'weather':
      return ev.weather ? `Weather: ${ev.weather}` : 'Weather ended';
    case 'terrain':
      return ev.terrain ? `Terrain: ${ev.terrain}` : 'Terrain ended';
    case 'sidestart':
      return `${ev.side} ${ev.effect}`;
    case 'sideend':
      return `${ev.side} ${ev.effect} ended`;
    case 'win':
      return `${ev.winner} wins`;
    default:
      return null;
  }
}

export function slotsFromObservation(obs: BattleObservation, side: 'ours' | 'theirs'): LiveSlot[] {
  const weather = obs.field.weather;
  return padSlots(obs[side].map((s) => liveSlotFromSnapshot(s, weather)));
}

export class LiveStateWriter {
  readonly path: string;
  state: LiveState;
  lastObs?: BattleObservation;

  constructor(opts: { path?: string; room: string; dryRun: boolean; policy: string }) {
    this.path = opts.path || defaultLiveStatePath();
    this.state = {
      schemaVersion: LIVE_SCHEMA_VERSION,
      ts: nowIso(),
      status: 'connecting',
      room: opts.room,
      dryRun: opts.dryRun,
      policy: opts.policy,
      turn: 0,
      field: emptyLiveField(),
      ours: padSlots([]),
      theirs: padSlots([]),
      events: [],
      turns: [],
      points: [],
    };
  }

  patch(partial: Partial<LiveState>): void {
    this.state = { ...this.state, ...partial, ts: nowIso(), events: partial.events ?? this.state.events };
    this.flush();
  }

  pushEvent(text: string): void {
    const events = [...this.state.events, { ts: nowIso(), text }].slice(-MAX_LIVE_EVENTS);
    this.state = { ...this.state, ts: nowIso(), events };
    this.flush();
  }

  noteEvent(ev: BattleEvent): void {
    const text = summarizeEvent(ev);
    if (text) this.pushEvent(text);
    if (ev.type === 'win') this.patch({ status: 'ended', winner: ev.winner });
  }

  fromTracker(tracker: BattleTracker): void {
    this.state = {
      ...this.state,
      ts: nowIso(),
      turn: tracker.turn,
      field: liveFieldFromTracker(tracker),
      ours: hudSlots(tracker.myMons, tracker.field.weather),
      theirs: hudSlots(tracker.oppMons, tracker.field.weather),
      ...livePlayers(tracker),
    };
    this.flush();
  }

  fromObservation(obs: BattleObservation, opts?: {
    settle?: boolean;
    extraWarnings?: string[];
    oursName?: string;
    theirsName?: string;
    teraUsedOurs?: boolean;
    teraUsedTheirs?: boolean;
  }): void {
    // Settle any prior forecast point on receiving the new observation
    const points = [...(this.state.points ?? [])];
    const pending = points.find((p) => p.status === 'forecast');
    const settleNow = opts?.settle !== false;
    if (settleNow && pending) {
      if (this.lastObs) {
        const afterScore = observationStateScore(obs.ours, obs.theirs);
        const beforeScore = observationStateScore(this.lastObs.ours, this.lastObs.theirs);
        const realizedDelta = afterScore - beforeScore;
        pending.status = 'settled';
        pending.realizedDelta = realizedDelta;
        pending.cumulativeTotal = pending.cumulativeTotal + realizedDelta;
      } else {
        pending.status = 'unresolved';
      }
    }
    this.lastObs = obs;

    if (points.length === 0 && (obs.ours.some((s) => s.revealed) || obs.theirs.some((s) => s.revealed))) {
      const score = observationStateScore(obs.ours, obs.theirs);
      points.push({
        sequence: 1,
        turn: obs.turn,
        actionId: 'start',
        actionKind: 'move',
        tera: false,
        status: 'settled',
        expectedDelta: 0,
        minDelta: 0,
        maxDelta: 0,
        realizedDelta: 0,
        cumulativeTotal: score,
        expectedTotal: score,
        minTotal: score,
        maxTotal: score,
        samples: 0,
      });
    } else if (settleNow && !pending && points.length > 0) {
      const last = points[points.length - 1]!;
      if (last.turn !== obs.turn) {
        const score = observationStateScore(obs.ours, obs.theirs);
        const delta = score - last.cumulativeTotal;
        points.push({
          sequence: last.sequence + 1,
          turn: obs.turn,
          actionId: 'sync',
          actionKind: 'move',
          tera: false,
          status: 'settled',
          expectedDelta: delta,
          minDelta: delta,
          maxDelta: delta,
          realizedDelta: delta,
          cumulativeTotal: score,
          expectedTotal: score,
          minTotal: score,
          maxTotal: score,
          samples: 0,
        });
      }
    }

    const turns: LiveTurn[] = points.map((p) => ({
      turn: p.turn,
      roundScore: p.status === 'settled' && p.realizedDelta != null ? p.realizedDelta : p.expectedDelta,
      sampledAction: p.actionId,
    })).slice(-MAX_LIVE_TURNS);

    this.state = {
      ...this.state,
      ts: nowIso(),
      turn: obs.turn,
      field: liveFieldFromObs(obs),
      ours: slotsFromObservation(obs, 'ours'),
      theirs: slotsFromObservation(obs, 'theirs'),
      oursName: opts?.oursName || this.state.oursName,
      theirsName: opts?.theirsName || this.state.theirsName,
      teraUsedOurs: opts?.teraUsedOurs ?? obs.teraUsedOurs ?? this.state.teraUsedOurs,
      teraUsedTheirs: opts?.teraUsedTheirs ?? obs.teraUsedTheirs ?? this.state.teraUsedTheirs,
      warnings: [...slotWarnings(obs), ...(opts?.extraWarnings ?? [])],
      points: points.slice(-MAX_LIVE_POINTS),
      turns,
    };
    this.flush();
    this.writeObservation(obs);
  }

  fromDecision(result: DecideResult, opts?: { rescore?: boolean }): void {
    const probabilities = result.probabilities;
    const choices = toLiveChoices(result.evaluation, probabilities);
    const sampled = result.evaluation.choices.find((c) => c.action.id === result.sampledId)
      ?? result.evaluation.choices[0];

    const points = [...(this.state.points ?? [])];
    // Find the base cumulative total from the latest settled point (or 0 at attach)
    let baseTotal = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i]!.status === 'settled') {
        baseTotal = points[i]!.cumulativeTotal;
        break;
      }
    }

    const expectedDelta = sampled?.choiceScore ?? result.evaluation.expectedRoundScore ?? result.evaluation.roundScore;
    const minDelta = sampled?.minTurnScore ?? result.evaluation.minRoundScore ?? expectedDelta;
    const maxDelta = sampled?.maxTurnScore ?? result.evaluation.maxRoundScore ?? expectedDelta;
    const samples = sampled?.sampleCount ?? 1;
    const actionKind: 'move' | 'switch' = (sampled?.action.type as 'move' | 'switch')
      ?? (result.sampledId.startsWith('switch:') ? 'switch' : 'move');
    const tera = Boolean(sampled?.action.tera || result.sampledId.endsWith(':tera'));

    const newPoint: LiveScorePoint = {
      sequence: points.length + 1,
      turn: this.state.turn,
      actionId: result.sampledId,
      actionKind,
      tera,
      status: 'forecast',
      expectedDelta,
      minDelta,
      maxDelta,
      cumulativeTotal: baseTotal,
      expectedTotal: baseTotal + expectedDelta,
      minTotal: baseTotal + minDelta,
      maxTotal: baseTotal + maxDelta,
      samples,
    };

    const last = points[points.length - 1];
    if (opts?.rescore && last && last.status === 'forecast' && last.turn === this.state.turn) {
      newPoint.sequence = last.sequence;
      points[points.length - 1] = newPoint;
    } else {
      points.push(newPoint);
    }
    const cappedPoints = points.slice(-MAX_LIVE_POINTS);

    const turns: LiveTurn[] = cappedPoints.map((p) => ({
      turn: p.turn,
      roundScore: p.status === 'settled' && p.realizedDelta != null ? p.realizedDelta : p.expectedDelta,
      sampledAction: p.actionId,
    })).slice(-MAX_LIVE_TURNS);

    let weights: ScoreWeights;
    try {
      weights = loadWeights();
    } catch {
      weights = { health: 1, modifier: 1, secondary: 1, switchRisk: 1, sacrifice: 1 };
    }

    this.state = {
      ...this.state,
      ts: nowIso(),
      status: 'waiting',
      points: cappedPoints,
      turns,
      eval: {
        roundScore: result.evaluation.roundScore,
        expectedRoundScore: result.evaluation.expectedRoundScore,
        minRoundScore: result.evaluation.minRoundScore,
        maxRoundScore: result.evaluation.maxRoundScore,
        forcedOutcome: result.evaluation.forcedOutcome,
        mateProbability: result.evaluation.mateProbability,
        sampledAction: result.sampledId,
        choices,
        replies: toLiveReplies(result.evaluation.replies ?? []),
        teraChoices: result.teraOurs ? toLiveChoices(result.teraOurs) : undefined,
        teraReplies: result.teraTheirs ? toLiveReplies(result.teraTheirs.replies ?? []) : undefined,
        quantum: quantumFromDiag(result.diagnostics),
        scoreWeights: weights,
      },
    };
    this.flush();
    this.pushEvent(
      `eval roundScore=${result.evaluation.roundScore.toFixed(3)} sampled ${result.sampledId}`,
    );
  }

  patchForecast(forecast: BattleForecast): void {
    if (!this.state.eval || forecast.turn !== this.state.turn) return;
    this.state.eval.forecast = forecast;
    for (const choice of this.state.eval.choices) {
      const cf = forecast.choices.find((c) => c.actionId === choice.id);
      if (cf) {
        choice.winRate = cf.winRate;
        choice.winRateLow = cf.winRateLow;
        choice.winRateHigh = cf.winRateHigh;
        choice.wins = cf.wins;
        choice.losses = cf.losses;
        choice.draws = cf.draws;
        choice.capped = cf.capped;
        choice.expectedTerminalScore = cf.expectedTerminalScore;
        choice.minTerminalScore = cf.minTerminalScore;
        choice.maxTerminalScore = cf.maxTerminalScore;
        choice.samples = cf.samples;
      }
    }
    this.flush();
  }

  writeObservation(obs: BattleObservation): void {
    const fp = defaultLiveObservationPath(this.path);
    const dir = path.dirname(fp);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(obs) + '\n', 'utf8');
  }

  flush(): void {
    const dir = path.dirname(this.path);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.state) + '\n', 'utf8');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function identityName(identity: string): string {
  const parts = identity.split(':');
  return (parts[1] ?? identity).trim() || identity;
}

function hpText(hp: number, maxHp: number): string {
  return maxHp > 0 ? `${hp}/${maxHp}` : String(hp);
}

function hudSlots(mons: BattleTracker['myMons'], weather = ''): LiveSlot[] {
  return padSlots([...mons.values()].map((m) => {
    const boosts = { ...m.boosts };
    return {
      speciesId: m.speciesId,
      hp: m.hp,
      maxHp: m.maxHp || 100,
      status: m.status,
      fainted: m.fainted,
      active: m.active,
      revealed: true,
      boosts,
      modifiers: modifiersFromSlot({
        slot: 0,
        speciesId: m.speciesId,
        revealed: true,
        hp: m.hp,
        maxHp: m.maxHp || 100,
        status: m.status,
        boosts,
        fainted: m.fainted,
        active: m.active,
        knownMoves: [],
        hypotheses: [],
        modifiers: [],
      }, weather),
      setComplete: false,
    };
  }));
}

function liveSlotFromSnapshot(s: SlotSnapshot, weather: string): LiveSlot {
  if (!s.revealed) {
    return {
      speciesId: '',
      hp: s.hp,
      maxHp: s.maxHp || 100,
      status: '',
      fainted: false,
      active: false,
      revealed: false,
      boosts: emptyBoosts(),
      modifiers: [],
      setComplete: false,
    };
  }
  return {
    speciesId: s.speciesId,
    hp: s.hp,
    maxHp: s.maxHp || 100,
    status: s.status,
    fainted: s.fainted,
    active: s.active,
    revealed: true,
    boosts: { ...s.boosts },
    modifiers: s.modifiers.length ? s.modifiers.map((m) => ({ ...m })) : modifiersFromSlot(s, weather),
    item: s.item,
    ability: s.ability,
    teraType: s.teraType,
    level: s.level,
    knownMoves: s.knownMoves,
    setSource: s.setSource,
    assumedSet: s.set,
    setOptions: s.setOptions,
    candidateProbability: s.candidateProbability,
    setComplete: Boolean(s.setComplete),
    setWarning: s.setWarning,
  };
}

function slotWarnings(obs: BattleObservation): string[] {
  return [...obs.ours, ...obs.theirs].flatMap((s) => (s.setWarning ? [s.setWarning] : []));
}

function blankSlot(): LiveSlot {
  return {
    speciesId: '',
    hp: 0,
    maxHp: 100,
    status: '',
    fainted: false,
    active: false,
    revealed: false,
    boosts: emptyBoosts(),
    modifiers: [],
    setComplete: false,
  };
}

export function padSlots(slots: LiveSlot[]): LiveSlot[] {
  const out = slots.slice(0, LIVE_SLOT_COUNT);
  while (out.length < LIVE_SLOT_COUNT) out.push(blankSlot());
  return out;
}

function toLiveChoices(ev: DecideResult['evaluation'], probabilities?: number[]): LiveChoice[] {
  return ev.choices.map((c, i) => {
    const p = probabilities?.[i] ?? c.probability;
    return {
      id: c.action.id,
      type: c.action.type,
      cta: c.cta,
      cts: c.cts,
      expectedImpact: c.expectedImpact,
      expectedHealthDelta: c.expectedHealthDelta ?? 0,
      expectedModifierDelta: c.expectedModifierDelta ?? 0,
      ourHealth: c.ourHealth ?? 0,
      theirHealth: c.theirHealth ?? 0,
      ourModifier: c.ourModifier ?? 0,
      theirModifier: c.theirModifier ?? 0,
      hitsToKill: c.hitsToKill ?? null,
      choiceScore: c.choiceScore,
      scaledChoiceScore: c.scaledChoiceScore,
      meanPostScore: c.meanPostScore,
      minTurnScore: c.minTurnScore,
      maxTurnScore: c.maxTurnScore,
      minPostScore: c.minPostScore,
      maxPostScore: c.maxPostScore,
      sampleCount: c.sampleCount,
      features: c.features,
      probability: p,
      policyWeight: p,
      hamiltonianInput: c.scaledChoiceScore,
    };
  });
}

function toLiveReplies(replies: NonNullable<DecideResult['evaluation']['replies']>): LiveReply[] {
  return replies.map((r) => ({
    id: r.action.id,
    type: r.action.type,
    expectedImpact: r.expectedImpact,
    hitsToKillUs: r.hitsToKillUs,
    choiceScore: r.choiceScore,
    probability: r.probability,
    policyWeight: r.probability,
    hamiltonianInput: r.choiceScore != null ? r.choiceScore : undefined,
    expectedHealthDelta: r.expectedHealthDelta,
    expectedModifierDelta: r.expectedModifierDelta,
    ourHealth: r.ourHealth,
    theirHealth: r.theirHealth,
    ourModifier: r.ourModifier,
    theirModifier: r.theirModifier,
    features: r.features,
    minTurnScore: r.minTurnScore,
    maxTurnScore: r.maxTurnScore,
    meanPostScore: r.meanPostScore,
    minPostScore: r.minPostScore,
    maxPostScore: r.maxPostScore,
    sampleCount: r.sampleCount,
  }));
}

function emptyHazards(): LiveHazards {
  return { stealthrock: false, spikes: 0, toxicspikes: 0, stickyweb: false };
}

function emptySideField(): LiveSideField {
  return { hazards: emptyHazards(), reflect: 0, lightscreen: 0 };
}

function emptyLiveField(): LiveField {
  return { weather: '', terrain: '', trickroom: false, ours: emptySideField(), theirs: emptySideField() };
}

function sideField(
  oursIsP1: boolean,
  field: FieldSnapshot | BattleTracker['field'],
  ours: boolean,
): LiveSideField {
  const p1 = ours === oursIsP1;
  if ('hazards_p1' in field) {
    return {
      hazards: { ...(p1 ? field.hazards_p1 : field.hazards_p2) },
      reflect: p1 ? field.reflect_p1 : field.reflect_p2,
      lightscreen: p1 ? field.lightscreen_p1 : field.lightscreen_p2,
    };
  }
  return {
    hazards: { ...(p1 ? field.hazards_a : field.hazards_b) },
    reflect: p1 ? field.reflect_a : field.reflect_b,
    lightscreen: p1 ? field.lightscreen_a : field.lightscreen_b,
  };
}

function liveFieldFromObs(obs: BattleObservation): LiveField {
  const oursIsP1 = obs.ourSide !== 'p2';
  return {
    weather: obs.field.weather,
    terrain: obs.field.terrain,
    trickroom: obs.field.trickroom,
    ours: sideField(oursIsP1, obs.field, true),
    theirs: sideField(oursIsP1, obs.field, false),
  };
}

function liveFieldFromTracker(tracker: BattleTracker): LiveField {
  const oursIsP1 = tracker.ourSide !== 'p2';
  return {
    weather: tracker.field.weather,
    terrain: tracker.field.terrain,
    trickroom: tracker.field.trickroom,
    ours: sideField(oursIsP1, tracker.field, true),
    theirs: sideField(oursIsP1, tracker.field, false),
  };
}

function quantumFromDiag(diag?: Record<string, unknown>): LiveQuantum | undefined {
  if (!diag) return undefined;
  const nQubits = diag.n_qubits;
  const shots = diag.shots;
  const exact = diag.exact;
  const params = Array.isArray(diag.params)
    ? diag.params.filter((x): x is number => typeof x === 'number')
    : undefined;
  const cost = typeof diag.cost === 'number' ? diag.cost : undefined;
  return {
    mode: String(diag.mode ?? 'unknown'),
    nQubits: typeof nQubits === 'number' ? nQubits : undefined,
    shots: shots == null ? undefined : Number(shots),
    exact: typeof exact === 'boolean' ? exact : undefined,
    params,
    cost,
  };
}
