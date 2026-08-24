// Compact battle HUD snapshot for the PokeRedus game-state screen.
// The live CLI overwrites this JSON; the GUI polls it. No sockets.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BattleObservation, Boosts, FieldSnapshot } from '@pokeredus/engine';
import { emptyBoosts, modifiersFromSlot } from '@pokeredus/engine';
import type { DecideResult } from './decide.js';
import type { BattleEvent, BattleTracker } from './protocol.js';

export const MAX_LIVE_EVENTS = 40;
export const MAX_LIVE_TURNS = 16;
export const LIVE_SLOT_COUNT = 6;

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
  probability?: number;
}

export interface LiveReply {
  id: string;
  type: string;
  expectedImpact: number;
  hitsToKillUs: number | null;
  choiceScore?: number;
  probability?: number;
  expectedHealthDelta?: number;
  expectedModifierDelta?: number;
  ourHealth?: number;
  theirHealth?: number;
  ourModifier?: number;
  theirModifier?: number;
}

export interface LiveQuantum {
  mode: string;
  nQubits?: number;
  shots?: number;
  exact?: boolean;
}

export interface LiveEval {
  roundScore: number;
  forcedOutcome: string;
  mateProbability: number;
  sampledAction: string;
  choices: LiveChoice[];
  replies: LiveReply[];
  teraChoices?: LiveChoice[];
  teraReplies?: LiveReply[];
  quantum?: LiveQuantum;
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
  ts: string;
  status: LiveStatus;
  room: string;
  dryRun: boolean;
  policy: string;
  turn: number;
  winner?: string;
  field: LiveField;
  ours: LiveSlot[];
  theirs: LiveSlot[];
  eval?: LiveEval;
  turns: LiveTurn[];
  events: LiveEvent[];
  error?: string;
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
  return padSlots(obs[side].map((s) => ({
    speciesId: s.speciesId,
    hp: s.hp,
    maxHp: s.maxHp || 100,
    status: s.status,
    fainted: s.fainted,
    active: s.active,
    revealed: s.revealed,
    boosts: { ...s.boosts },
    modifiers: s.modifiers.length ? s.modifiers.map((m) => ({ ...m })) : modifiersFromSlot(s, weather),
  })));
}

export class LiveStateWriter {
  readonly path: string;
  state: LiveState;

  constructor(opts: { path?: string; room: string; dryRun: boolean; policy: string }) {
    this.path = opts.path || defaultLiveStatePath();
    this.state = {
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
    };
    this.flush();
  }

  fromObservation(obs: BattleObservation): void {
    this.state = {
      ...this.state,
      ts: nowIso(),
      turn: obs.turn,
      field: liveFieldFromObs(obs),
      ours: slotsFromObservation(obs, 'ours'),
      theirs: slotsFromObservation(obs, 'theirs'),
    };
    this.flush();
    this.writeObservation(obs);
  }

  fromDecision(result: DecideResult): void {
    const probabilities = result.probabilities;
    const turns: LiveTurn[] = [
      ...(this.state.turns ?? []),
      {
        turn: this.state.turn,
        roundScore: result.evaluation.roundScore,
        sampledAction: result.sampledId,
      },
    ].slice(-MAX_LIVE_TURNS);
    this.state = {
      ...this.state,
      ts: nowIso(),
      status: 'waiting',
      turns,
      eval: {
        roundScore: result.evaluation.roundScore,
        forcedOutcome: result.evaluation.forcedOutcome,
        mateProbability: result.evaluation.mateProbability,
        sampledAction: result.sampledId,
        choices: toLiveChoices(result.evaluation, probabilities),
        replies: toLiveReplies(result.evaluation.replies ?? []),
        teraChoices: result.teraOurs ? toLiveChoices(result.teraOurs) : undefined,
        teraReplies: result.teraTheirs ? toLiveReplies(result.teraTheirs.replies ?? []) : undefined,
        quantum: quantumFromDiag(result.diagnostics),
      },
    };
    // #region agent log
    try { fs.appendFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../debug-029c39.log'), JSON.stringify({sessionId:'029c39',runId:'post-fix',hypothesisId:'E',location:'live-state.ts:fromDecision',message:'eval listings',data:{choiceIds:result.evaluation.choices.map((c)=>c.action.id),replyIds:(result.evaluation.replies??[]).map((r)=>r.action.id),teraChoiceIds:(result.teraOurs?.choices??[]).map((c)=>c.action.id),teraReplyIds:(result.teraTheirs?.replies??[]).map((r)=>r.action.id),oursHud:this.state.ours.map((s)=>({species:s.speciesId,active:s.active,revealed:s.revealed}))},timestamp:Date.now()})+'\n'); } catch { /* ignore */ }
    fetch('http://127.0.0.1:7559/ingest/6200673b-d438-4c7f-9e45-49a0c341555a',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'029c39'},body:JSON.stringify({sessionId:'029c39',runId:'post-fix',hypothesisId:'E',location:'live-state.ts:fromDecision',message:'eval listings',data:{choiceIds:result.evaluation.choices.map((c)=>c.action.id),teraN:result.teraOurs?.choices.length??0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    this.pushEvent(
      `eval roundScore=${result.evaluation.roundScore.toFixed(3)} sampled ${result.sampledId}`,
    );
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
    };
  }));
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
  };
}

export function padSlots(slots: LiveSlot[]): LiveSlot[] {
  const out = slots.slice(0, LIVE_SLOT_COUNT);
  while (out.length < LIVE_SLOT_COUNT) out.push(blankSlot());
  return out;
}

function toLiveChoices(ev: DecideResult['evaluation'], probabilities?: number[]): LiveChoice[] {
  return ev.choices.map((c, i) => ({
    id: c.action.id,
    type: c.action.type,
    cta: c.cta,
    cts: c.cts,
    expectedImpact: c.expectedImpact,
    expectedHealthDelta: c.expectedHealthDelta ?? 0,
    expectedModifierDelta: c.expectedModifierDelta ?? 0,
    hitsToKill: c.hitsToKill ?? null,
    choiceScore: c.choiceScore,
    probability: probabilities?.[i],
  }));
}

function toLiveReplies(replies: NonNullable<DecideResult['evaluation']['replies']>): LiveReply[] {
  return replies.map((r) => ({
    id: r.action.id,
    type: r.action.type,
    expectedImpact: r.expectedImpact,
    hitsToKillUs: r.hitsToKillUs,
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
  return {
    mode: String(diag.mode ?? 'unknown'),
    nQubits: typeof nQubits === 'number' ? nQubits : undefined,
    shots: shots == null ? undefined : Number(shots),
    exact: typeof exact === 'boolean' ? exact : undefined,
  };
}
