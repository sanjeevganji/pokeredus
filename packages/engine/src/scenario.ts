import type {
  BattleObservation,
  CanonicalSet,
  FieldSnapshot,
  LegalAction,
  RoundEvaluation,
  SlotSnapshot,
} from './observation.js';
import { observationTera } from './observation.js';
import { legalFromSlots } from './actions.js';
import { sampleAction, type QuantumPolicyProcess } from './policy.js';
import {
  evaluateRound,
  theirActions,
  evaluateJointStatePolicy,
  scoreRealizedPair,
  type EvaluateOptions,
  type HypothesisPolicy,
  type JointPolicyResult,
} from './evaluate.js';
import { canonicalizeSet } from './beliefs.js';
import { setIsComplete } from './set-overrides.js';
import { loadDefaultValuations, type EffectValuationRegistry } from './effect-valuation.js';
import { setsFromSlotMap, simulateRound, type RoundSimResult } from './sim.js';
import {
  clamp,
  signedLog1p,
  wilsonScoreInterval,
  createSeededRng,
  DEFAULT_WEIGHTS,
  type ScoreWeights,
} from './math.js';

export { legalFromSlots } from './actions.js';

const TEAM = 6;

export type RolloutOutcome =
  | 'win'
  | 'loss'
  | 'unknown-frontier'
  | 'turn-cap'
  | 'time-cap'
  | 'cancelled'
  | 'error';

export interface ForecastOptions extends EvaluateOptions {
  rolloutsPerChoice?: number;
  maxTurns?: number;
  timeBudgetMs?: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (partial: BattleForecast) => void;
  cache?: Map<string, JointPolicyResult>;
  /** Test seam: injectable clock. */
  now?: () => number;
  /** Test seam: replace Showdown for functional rollout tests. */
  simulate?: (
    obs: BattleObservation,
    our: LegalAction,
    opp: LegalAction,
    seed: number[],
    theirSets?: CanonicalSet[],
  ) => RoundSimResult;
}

export interface ChoiceForecast {
  actionId: string;
  samples: number;
  wins: number;
  losses: number;
  /** @deprecated Compatibility alias: unknownFrontiers + turnCaps + timeCaps. */
  draws: number;
  /** @deprecated Compatibility alias: turnCaps + timeCaps. */
  capped: number;
  unknownFrontiers: number;
  turnCaps: number;
  timeCaps: number;
  errors: number;
  expectedTerminalScore: number;
  minTerminalScore: number;
  maxTerminalScore: number;
  expectedCumulativeDelta: number;
  winRate: number | null;
  winRateLow: number | null;
  winRateHigh: number | null;
  policyWeight?: number;
}

export interface BattleForecast {
  turn: number;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'incomplete-assumptions' | 'error';
  choices: ChoiceForecast[];
  totalSamples: number;
  elapsedMs: number;
  assumptionsComplete: boolean;
  outcomeCounts: Record<RolloutOutcome, number>;
  terminalSamples: number;
  winRate: number | null;
  frontierReason?: string;
  diagnostics?: Record<string, unknown>;
  error?: string;
}

export interface RolloutWorld {
  revealedSetBySideSlot: Map<string, CanonicalSet>;
  beliefKeyBySideSlot: Map<string, string>;
  unrevealedTheirSlots: Set<number>;
}

export type RolloutClassification =
  | { kind: 'continue' }
  | { kind: RolloutOutcome; reason?: string };

export function sideSlotKey(side: 'ours' | 'theirs', slot: number): string {
  return `${side}:${slot}`;
}

export function emptyOutcomeCounts(): Record<RolloutOutcome, number> {
  return {
    win: 0,
    loss: 0,
    'unknown-frontier': 0,
    'turn-cap': 0,
    'time-cap': 0,
    cancelled: 0,
    error: 0,
  };
}

export function flipObservation(obs: BattleObservation): BattleObservation {
  const legal = theirActions(obs, obs.theirs.find((s) => s.active)?.set ?? obs.theirs.find((s) => s.active)?.hypotheses[0]?.set);
  const tera = observationTera(obs);
  return {
    ...obs,
    ourSide: obs.ourSide === 'p1' ? 'p2' : 'p1',
    ours: obs.theirs.map((s) => ({ ...s })),
    theirs: obs.ours.map((s) => ({ ...s })),
    legalActions: legal,
    teraUsedOurs: tera.theirs,
    teraUsedTheirs: tera.ours,
  };
}

function livingRevealed(slots: SlotSnapshot[]): SlotSnapshot[] {
  return slots.filter((s) => s.revealed && !s.fainted && s.hp > 0);
}

function allSixKnownFainted(slots: SlotSnapshot[]): boolean {
  if (slots.length < TEAM) return false;
  return slots.slice(0, TEAM).every((s) => s.revealed && (s.fainted || s.hp <= 0));
}

function allSixOursFainted(slots: SlotSnapshot[]): boolean {
  if (slots.length < TEAM) return false;
  return slots.slice(0, TEAM).every((s) => s.fainted || s.hp <= 0);
}

function needsReplacement(slot: SlotSnapshot | undefined): boolean {
  return !slot || slot.fainted || slot.hp <= 0;
}

export function classifyRolloutState(obs: BattleObservation): RolloutClassification {
  if (allSixKnownFainted(obs.theirs)) return { kind: 'win' };
  if (allSixOursFainted(obs.ours)) return { kind: 'loss' };

  const ourActive = obs.ours.find((s) => s.active);
  const theirActive = obs.theirs.find((s) => s.active);
  const ourForced = needsReplacement(ourActive);
  const theirForced = needsReplacement(theirActive);

  if (ourForced) {
    if (livingRevealed(obs.ours).length) return { kind: 'continue' };
    return { kind: 'error', reason: 'no legal replacement among our revealed living slots' };
  }
  if (theirForced) {
    if (livingRevealed(obs.theirs).length) return { kind: 'continue' };
    const hidden = obs.theirs.some((s) => !s.revealed && !(s.fainted || s.hp <= 0)) || obs.theirs.length < TEAM;
    if (hidden) return { kind: 'unknown-frontier', reason: 'replacement requires an unrevealed slot' };
    return { kind: 'error', reason: 'no legal opponent replacement' };
  }
  if (theirActive && !theirActive.revealed) {
    return { kind: 'unknown-frontier', reason: 'active opponent is unrevealed' };
  }

  const ourLegal = obs.legalActions.length ? obs.legalActions : legalFromSlots(obs.ours, obs.teraUsedOurs);
  if (ourLegal.length) return { kind: 'continue' };
  return { kind: 'error', reason: 'no legal actions in a non-terminal state' };
}

function pickReply(ev: RoundEvaluation, rng: () => number): LegalAction {
  const ids = ev.replies.map((r) => r.action.id);
  if (!ids.length) return { id: 'move:splash', type: 'move', moveId: 'splash' };
  const probs = ev.replies.map((r) => r.probability ?? 0);
  const sum = probs.reduce((a, b) => a + b, 0);
  const id = sum > 0 ? sampleAction(ids, probs, rng) : ids[0]!;
  return ev.replies.find((r) => r.action.id === id)?.action ?? ev.replies[0]!.action;
}

export function applySimResult(
  obs: BattleObservation,
  afterOurs: SlotSnapshot[],
  afterTheirs: SlotSnapshot[],
  afterField?: FieldSnapshot,
  chosenAction?: LegalAction,
  chosenOppAction?: LegalAction,
): BattleObservation {
  const teraUsedOurs = obs.teraUsedOurs || Boolean(chosenAction?.tera);
  const teraUsedTheirs = obs.teraUsedTheirs || Boolean(chosenOppAction?.tera);

  const ours = afterOurs.map((s) => {
    if (s.active && chosenAction?.tera) {
      return { ...s, terastallized: true };
    }
    return s;
  });

  const theirs = afterTheirs.map((s) => {
    if (s.active && chosenOppAction?.tera) {
      return { ...s, terastallized: true };
    }
    return s;
  });

  return {
    ...obs,
    turn: obs.turn + 1,
    ours,
    theirs,
    field: afterField ?? obs.field,
    teraUsedOurs,
    teraUsedTheirs,
    legalActions: legalFromSlots(ours, teraUsedOurs),
  };
}

export interface PlayTurnResult {
  observation: BattleObservation;
  sampledOpp: string;
  weWin: boolean;
  theyWin: boolean;
}

export async function playTurn(
  obs: BattleObservation,
  actionIdOrAction: string | LegalAction,
  facing: 'ours' | 'theirs',
  opts?: EvaluateOptions & { rng?: () => number; evaluation?: RoundEvaluation },
): Promise<PlayTurnResult> {
  const view = facing === 'theirs' ? flipObservation(obs) : obs;
  const ev = opts?.evaluation && facing === 'ours'
    ? opts.evaluation
    : await evaluateRound(view, opts);
  const wantId = typeof actionIdOrAction === 'string' ? actionIdOrAction : actionIdOrAction.id;
  const human = ev.choices.find((c) => c.action.id === wantId) ?? ev.choices[0];
  if (!human) throw new Error('no legal action to play');
  const rng = opts?.rng ?? Math.random;
  const opp = pickReply(ev, rng);
  const result = simulateRound(view, human.action, opp, [1, 2, 3, 4]);
  const nextView = applySimResult(view, result.afterOurs, result.afterTheirs, result.afterField, human.action, opp);
  const next = facing === 'theirs' ? flipObservation(nextView) : nextView;
  return {
    observation: next,
    sampledOpp: opp.id,
    weWin: facing === 'theirs' ? result.theyWin : result.weWin,
    theyWin: facing === 'theirs' ? result.weWin : result.theyWin,
  };
}

export interface WinrateResult {
  wins: number;
  losses: number;
  draws: number;
  n: number;
  avgTurns: number;
}

function speciesIdOf(set: CanonicalSet): string {
  return set.species.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickRevealedSet(s: SlotSnapshot, rng: () => number): { set: CanonicalSet; key: string } | null {
  if (s.setSource === 'manual') {
    if (!setIsComplete(s.set)) return null;
    return { set: s.set!, key: canonicalizeSet(s.set!) };
  }
  if (s.hypotheses?.length) {
    const mass = s.hypotheses.reduce((a, h) => a + h.probability, 0);
    if (!(mass > 0) || !Number.isFinite(mass)) return null;
    const keys = s.hypotheses.map((h) => canonicalizeSet(h.set));
    const probs = s.hypotheses.map((h) => h.probability / mass);
    const key = sampleAction(keys, probs, rng);
    const hyp = s.hypotheses.find((h) => canonicalizeSet(h.set) === key);
    return hyp ? { set: hyp.set, key } : null;
  }
  if (setIsComplete(s.set)) return { set: s.set!, key: canonicalizeSet(s.set!) };
  return null;
}

export function buildRolloutWorld(
  obs: BattleObservation,
  rng: () => number,
  activeHyp?: { set: CanonicalSet; key: string },
): RolloutWorld | { error: 'incomplete-assumptions' } {
  const revealedSetBySideSlot = new Map<string, CanonicalSet>();
  const beliefKeyBySideSlot = new Map<string, string>();
  const unrevealedTheirSlots = new Set<number>();

  for (const s of obs.ours) {
    if (!s.revealed) continue;
    if (setIsComplete(s.set)) {
      revealedSetBySideSlot.set(sideSlotKey('ours', s.slot), s.set!);
      beliefKeyBySideSlot.set(sideSlotKey('ours', s.slot), canonicalizeSet(s.set!));
    } else if (!s.fainted && s.hp > 0) {
      return { error: 'incomplete-assumptions' };
    }
  }

  const theirActive = obs.theirs.find((s) => s.active);
  for (const s of obs.theirs) {
    if (!s.revealed) {
      unrevealedTheirSlots.add(s.slot);
      continue;
    }
    let picked: { set: CanonicalSet; key: string } | null = null;
    if (activeHyp && theirActive && s.slot === theirActive.slot) {
      picked = activeHyp;
    } else {
      picked = pickRevealedSet(s, rng);
    }
    if (!picked) {
      if (!s.fainted && s.hp > 0) return { error: 'incomplete-assumptions' };
      continue;
    }
    revealedSetBySideSlot.set(sideSlotKey('theirs', s.slot), picked.set);
    beliefKeyBySideSlot.set(sideSlotKey('theirs', s.slot), picked.key);
  }

  return { revealedSetBySideSlot, beliefKeyBySideSlot, unrevealedTheirSlots };
}

function freezeObservation(obs: BattleObservation, world: RolloutWorld): BattleObservation {
  const overlay = (side: 'ours' | 'theirs', slots: SlotSnapshot[]): SlotSnapshot[] =>
    slots.map((s) => {
      const set = world.revealedSetBySideSlot.get(sideSlotKey(side, s.slot));
      if (!set) return s;
      return {
        ...s,
        set,
        hypotheses: [{ set, count: 1, probability: 1 }],
        setSource: s.setSource === 'manual' ? 'manual' : 'public',
      };
    });
  const ours = overlay('ours', obs.ours);
  return {
    ...obs,
    ours,
    theirs: overlay('theirs', obs.theirs),
    legalActions: legalFromSlots(ours, obs.teraUsedOurs),
  };
}

function assertWorldHolds(obs: BattleObservation, world: RolloutWorld): void {
  for (const s of obs.theirs) {
    if (world.unrevealedTheirSlots.has(s.slot) && s.revealed) {
      throw new Error(`rollout world conflict: unrevealed slot ${s.slot} became revealed (${s.speciesId})`);
    }
    const set = world.revealedSetBySideSlot.get(sideSlotKey('theirs', s.slot));
    if (!set || !s.revealed) continue;
    const frozen = speciesIdOf(set);
    const seen = s.speciesId.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen && frozen && seen !== frozen) {
      throw new Error(`rollout world conflict slot ${s.slot}: frozen ${set.species} vs revealed ${s.speciesId}`);
    }
  }
}

function theirSetsFromWorld(obs: BattleObservation, world: RolloutWorld): CanonicalSet[] {
  const bySlot = new Map<number, CanonicalSet>();
  for (const s of obs.theirs) {
    const set = world.revealedSetBySideSlot.get(sideSlotKey('theirs', s.slot));
    if (set) bySlot.set(s.slot, set);
  }
  return setsFromSlotMap(obs.theirs, bySlot);
}

function emptyTel(): RoundSimResult['ours'] {
  return {
    announced: true,
    first: true,
    missed: false,
    failed: false,
    executed: true,
    hit: true,
    aliveAtExecution: true,
    effects: [],
  };
}

function passthroughSim(obs: BattleObservation): RoundSimResult {
  return {
    afterOurs: obs.ours.map((s) => ({ ...s, boosts: { ...s.boosts }, modifiers: [...s.modifiers] })),
    afterTheirs: obs.theirs.map((s) => ({ ...s, boosts: { ...s.boosts }, modifiers: [...s.modifiers] })),
    afterField: { ...obs.field },
    pHit: 1,
    pExecute: 1,
    aliveAtExecution: 1,
    weWin: false,
    theyWin: false,
    ours: emptyTel(),
    theirs: emptyTel(),
  };
}

function valuationFingerprint(reg: EffectValuationRegistry): string {
  const dump = (m: Map<string, Array<{ multiplier: number; expectedTurns: number; probabilityOverride?: number }>>) =>
    [...m.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, vs]) => `${k}:${vs.map((v) => `${v.multiplier},${v.expectedTurns},${v.probabilityOverride ?? ''}`).join(';')}`)
      .join('|');
  return `m=${dump(reg.moves)};a=${dump(reg.abilities)};i=${dump(reg.items)}`;
}

function weightsKey(w: ScoreWeights): string {
  return `${w.health},${w.modifier},${w.secondary},${w.switchRisk},${w.sacrifice}`;
}

export function forecastCacheKey(obs: BattleObservation, opts?: EvaluateOptions): string {
  const slotKey = (s: SlotSnapshot) => {
    const moves = s.moveSlots?.map((m) => `${m.id}:${m.pp}:${m.maxpp}:${m.disabled ? 1 : 0}`).sort().join(',')
      ?? [...s.knownMoves].sort().join(',');
    const b = `${s.boosts.atk},${s.boosts.def},${s.boosts.spa},${s.boosts.spd},${s.boosts.spe},${s.boosts.accuracy},${s.boosts.evasion}`;
    const mods = [...s.modifiers]
      .map((m) => `${m.name}:${m.multiplier}:${m.remainingTurns}:${m.probability ?? 1}`)
      .sort()
      .join(',');
    const hyps = [...s.hypotheses]
      .map((h) => `${canonicalizeSet(h.set)}:${h.probability}`)
      .sort()
      .join(',');
    const setKey = s.set ? canonicalizeSet(s.set) : '';
    return [
      s.slot, s.speciesId, s.revealed ? 1 : 0, s.active ? 1 : 0, s.fainted ? 1 : 0,
      `${s.hp}/${s.maxHp}`, s.status, s.item ?? '', s.ability ?? '', s.teraType ?? '',
      s.terastallized ? 1 : 0, s.choiceLock ?? '', s.trapped ? 1 : 0, b, moves, mods,
      s.setSource ?? '', setKey, hyps,
    ].join(':');
  };
  const hz = (h: FieldSnapshot['hazards_p1']) =>
    `${h.stealthrock ? 1 : 0},${h.spikes},${h.toxicspikes},${h.stickyweb ? 1 : 0}`;
  const fieldKey = [
    obs.field.weather, obs.field.weatherTurns ?? '',
    obs.field.terrain, obs.field.terrainTurns ?? '',
    obs.field.trickroom ? 1 : 0, obs.field.trickroomTurns ?? '',
    hz(obs.field.hazards_p1), obs.field.reflect_p1, obs.field.lightscreen_p1,
    hz(obs.field.hazards_p2), obs.field.reflect_p2, obs.field.lightscreen_p2,
  ].join(':');
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const valuations = opts?.valuations ?? loadDefaultValuations();
  const policy = `${opts?.policy ?? ''},${opts?.shots ?? ''},${opts?.refineIters ?? ''}`;
  return [
    obs.ourSide, obs.teraUsedOurs ? 1 : 0, obs.teraUsedTheirs ? 1 : 0, fieldKey,
    obs.ours.map(slotKey).join('|'), obs.theirs.map(slotKey).join('|'),
    weightsKey(weights), valuationFingerprint(valuations), policy,
  ].join(';');
}

export function validateAssumptionsComplete(obs: BattleObservation): boolean {
  for (const s of obs.ours) {
    if (s.revealed && !s.fainted) {
      if (s.setComplete === false && !s.set) return false;
    }
  }
  for (const s of obs.theirs) {
    if (s.revealed && !s.fainted) {
      if (s.setComplete === false && !s.set && (!s.hypotheses || s.hypotheses.length === 0)) return false;
    }
  }
  return true;
}

interface StratifiedSampleRecord {
  actionId: string;
  cumulativeRealizedDelta: number;
  outcome: RolloutOutcome;
  terminalUtility: number;
  turns: number;
  hypothesisKeys: string[];
  sampledIds: string[];
  residualHealth: number;
  residualModifier: number;
}

function terminalUtilityOf(outcome: RolloutOutcome, cumulative: number): number {
  if (outcome === 'win') return 1;
  if (outcome === 'loss') return -1;
  return clamp(cumulative, -1, 1);
}

function sampleHypothesis(hyps: HypothesisPolicy[], rng: () => number): HypothesisPolicy {
  if (!hyps.length) throw new Error('no represented hypothesis to sample');
  if (hyps.length === 1) return hyps[0]!;
  const key = sampleAction(hyps.map((h) => h.key), hyps.map((h) => h.probability), rng);
  return hyps.find((h) => h.key === key) ?? hyps[0]!;
}

function sampleConditionalReply(hyp: HypothesisPolicy, rng: () => number): LegalAction {
  if (!hyp.actions.length) throw new Error(`hypothesis ${hyp.key} has no legal replies`);
  const id = sampleAction(hyp.actions.map((a) => a.id), hyp.probabilities, rng);
  const act = hyp.actions.find((a) => a.id === id);
  if (!act) throw new Error(`sampled illegal reply ${id} under hypothesis ${hyp.key}`);
  return act;
}

function hypForActive(policy: JointPolicyResult, world: RolloutWorld, obs: BattleObservation): HypothesisPolicy | undefined {
  const active = obs.theirs.find((s) => s.active);
  if (!active) return policy.hypotheses[0];
  const key = world.beliefKeyBySideSlot.get(sideSlotKey('theirs', active.slot));
  return policy.hypotheses.find((h) => h.key === key) ?? policy.hypotheses[0];
}

export async function forecastBattle(
  obs: BattleObservation,
  opts?: ForecastOptions,
): Promise<BattleForecast> {
  const now = opts?.now ?? Date.now;
  const startTime = now();
  const rolloutsPerChoice = opts?.rolloutsPerChoice ?? 4;
  const maxTurns = opts?.maxTurns ?? 64;
  const timeBudgetMs = opts?.timeBudgetMs ?? 10_000;
  const rng = opts?.seed !== undefined ? createSeededRng(opts.seed) : Math.random;
  const signal = opts?.signal;
  const cache = opts?.cache ?? new Map<string, JointPolicyResult>();
  const weights = opts?.weights ?? DEFAULT_WEIGHTS;
  const valuations = opts?.valuations ?? loadDefaultValuations();
  const usePairDelta = Boolean(opts?.pairDelta);

  let cacheHits = 0;
  let cacheMisses = 0;
  let frontierReason: string | undefined;

  const elapsed = () => now() - startTime;
  const timedOut = () => elapsed() >= timeBudgetMs;

  const emptyForecast = (
    status: BattleForecast['status'],
    extra?: Partial<BattleForecast>,
  ): BattleForecast => ({
    turn: obs.turn,
    status,
    choices: [],
    totalSamples: 0,
    elapsedMs: elapsed(),
    assumptionsComplete: status !== 'incomplete-assumptions',
    outcomeCounts: emptyOutcomeCounts(),
    terminalSamples: 0,
    winRate: null,
    ...extra,
  });

  if (!validateAssumptionsComplete(obs)) {
    return emptyForecast('incomplete-assumptions', {
      assumptionsComplete: false,
      error: 'Incomplete assumed sets for active or revealed combatants',
    });
  }

  const evalOpts: EvaluateOptions = {
    ...opts,
    chanceSeeds: opts?.chanceSeeds ?? 1,
  };

  const rootPolicy = await evaluateJointStatePolicy(obs, evalOpts);
  const rootActions = rootPolicy.evaluation.choices.map((c) => c.action);
  if (!rootActions.length) {
    return emptyForecast('error', { error: 'No legal root actions available' });
  }

  const samplesByAction = new Map<string, StratifiedSampleRecord[]>();
  for (const a of rootActions) samplesByAction.set(a.id, []);

  const getOrEvalPolicy = async (state: BattleObservation): Promise<JointPolicyResult> => {
    const key = forecastCacheKey(state, evalOpts);
    const cached = cache.get(key);
    if (cached) {
      cacheHits++;
      return cached;
    }
    cacheMisses++;
    const res = await evaluateJointStatePolicy(state, evalOpts);
    cache.set(key, res);
    return res;
  };

  let status: BattleForecast['status'] = 'running';
  let totalSamples = 0;
  const allRecords: StratifiedSampleRecord[] = [];

  const tally = (recs: StratifiedSampleRecord[]) => {
    const counts = emptyOutcomeCounts();
    for (const r of recs) counts[r.outcome]++;
    return counts;
  };

  const buildPartialForecast = async (
    currentStatus: BattleForecast['status'],
    computeWeights = false,
  ): Promise<BattleForecast> => {
    const choiceForecasts: ChoiceForecast[] = [];
    const rootMeanUtilities: number[] = [];
    const rootIds: string[] = [];
    const global = tally(allRecords);
    const terminalSamples = global.win + global.loss;
    const globalWinRate = terminalSamples > 0 ? global.win / terminalSamples : null;
    let firstFrontier: string | undefined = frontierReason;

    for (const a of rootActions) {
      const recs = samplesByAction.get(a.id) ?? [];
      const n = recs.length;
      const c = tally(recs);
      const scores = recs.map((r) => r.terminalUtility);
      const deltas = recs.map((r) => r.cumulativeRealizedDelta);
      const utilSum = scores.reduce((s, x) => s + x, 0);
      const deltaSum = deltas.reduce((s, x) => s + x, 0);
      const meanUtil = n > 0 ? utilSum / n : 0;
      const meanDelta = n > 0 ? deltaSum / n : 0;
      const minScore = scores.length ? Math.min(...scores) : 0;
      const maxScore = scores.length ? Math.max(...scores) : 0;
      const termN = c.win + c.loss;
      const winRate = termN > 0 ? c.win / termN : null;
      const wilson = termN > 0 ? wilsonScoreInterval(c.win, termN) : null;
      const draws = c['unknown-frontier'] + c['turn-cap'] + c['time-cap'];
      choiceForecasts.push({
        actionId: a.id,
        samples: n,
        wins: c.win,
        losses: c.loss,
        draws,
        capped: c['turn-cap'] + c['time-cap'],
        unknownFrontiers: c['unknown-frontier'],
        turnCaps: c['turn-cap'],
        timeCaps: c['time-cap'],
        errors: c.error,
        expectedTerminalScore: meanUtil,
        minTerminalScore: minScore,
        maxTerminalScore: maxScore,
        expectedCumulativeDelta: meanDelta,
        winRate,
        winRateLow: wilson?.low ?? null,
        winRateHigh: wilson?.high ?? null,
      });
      rootIds.push(a.id);
      rootMeanUtilities.push(meanUtil);
      if (!firstFrontier) {
        const fr = recs.find((r) => r.outcome === 'unknown-frontier');
        if (fr) firstFrontier = 'unknown-frontier';
      }
    }

    if (computeWeights && opts?.refine && choiceForecasts.some((c) => c.samples > 0)) {
      try {
        const hamiltonianInputs = rootMeanUtilities.map(signedLog1p);
        const policyRes = await opts.refine.decide({
          actions: rootIds,
          scores: hamiltonianInputs,
          mode: opts.policy ?? 'quantum',
          seed: opts.seed,
          shots: opts.shots ?? null,
        });
        for (let i = 0; i < choiceForecasts.length; i++) {
          choiceForecasts[i]!.policyWeight = policyRes.probabilities[i];
        }
      } catch {
        // leave undefined
      }
    }

    return {
      turn: obs.turn,
      status: currentStatus,
      choices: choiceForecasts,
      totalSamples,
      elapsedMs: elapsed(),
      assumptionsComplete: true,
      outcomeCounts: global,
      terminalSamples,
      winRate: globalWinRate,
      frontierReason: firstFrontier,
      diagnostics: {
        cacheHits,
        cacheMisses,
        legalPairCount: rootPolicy.diagnostics.legalPairCount,
        rolloutsRequested: rolloutsPerChoice * rootActions.length,
        rolloutsCompleted: totalSamples,
        sampleRecords: allRecords.map((r) => ({
          actionId: r.actionId,
          cumulativeRealizedDelta: r.cumulativeRealizedDelta,
          outcome: r.outcome,
          terminalUtility: r.terminalUtility,
          turns: r.turns,
          hypothesisKeys: r.hypothesisKeys,
          sampledIds: r.sampledIds,
        })),
      },
    };
  };

  const scoreRound = (
    before: BattleObservation,
    ourAct: LegalAction,
    oppAct: LegalAction,
    simRes: RoundSimResult,
    hypKey: string,
  ): { delta: number; residualHealth: number; residualModifier: number } => {
    if (usePairDelta && opts?.pairDelta) {
      return { delta: clamp(opts.pairDelta(ourAct.id, oppAct.id, hypKey), -1, 1), residualHealth: 0, residualModifier: 0 };
    }
    const scored = scoreRealizedPair(before, ourAct, oppAct, simRes, weights, valuations);
    return { delta: scored.pairDelta, residualHealth: scored.residualHealth, residualModifier: scored.residualModifier };
  };

  const runOneSample = async (rootAction: LegalAction): Promise<StratifiedSampleRecord | 'aborted'> => {
    if (signal?.aborted) return 'aborted';
    if (timedOut()) return 'aborted';

    let sampledIds: string[] = [rootAction.id];
    let hypothesisKeys: string[] = [];
    let residualHealth = 0;
    let residualModifier = 0;

    try {
      if (!rootPolicy.hypotheses.length) {
        throw new Error('root policy has no represented hypothesis');
      }
      const rootHyp = sampleHypothesis(rootPolicy.hypotheses, rng);
      const world = buildRolloutWorld(obs, rng, { set: rootHyp.set, key: rootHyp.key });
      if ('error' in world) {
        return {
          actionId: rootAction.id,
          cumulativeRealizedDelta: 0,
          outcome: 'error',
          terminalUtility: 0,
          turns: 0,
          hypothesisKeys: [],
          sampledIds,
          residualHealth: 0,
          residualModifier: 0,
        };
      }
      hypothesisKeys = [...world.beliefKeyBySideSlot.values()].sort();
      const rootOpp = sampleConditionalReply(rootHyp, rng);
      sampledIds.push(rootOpp.id);

      const theirSets = theirSetsFromWorld(obs, world);
      const seed = [1 + (totalSamples % 4), 2, 3, 4];
      const rootSim = opts?.simulate
        ? opts.simulate(obs, rootAction, rootOpp, seed, theirSets)
        : usePairDelta
          ? passthroughSim(obs)
          : simulateRound(obs, rootAction, rootOpp, seed, theirSets);
      const rootScore = scoreRound(obs, rootAction, rootOpp, rootSim, rootHyp.key);
      let cumulative = rootScore.delta;
      residualHealth += rootScore.residualHealth;
      residualModifier += rootScore.residualModifier;
      let currentState = overlayWorld(
        applySimResult(obs, rootSim.afterOurs, rootSim.afterTheirs, rootSim.afterField, rootAction, rootOpp),
        world,
      );
      assertWorldHolds(currentState, world);

      let turns = 1;
      let classified = classifyRolloutState(currentState);
      if (classified.kind !== 'continue') {
        if (classified.kind === 'unknown-frontier' && classified.reason) frontierReason ??= classified.reason;
        return {
          actionId: rootAction.id,
          cumulativeRealizedDelta: cumulative,
          outcome: classified.kind,
          terminalUtility: terminalUtilityOf(classified.kind, cumulative),
          turns,
          hypothesisKeys,
          sampledIds,
          residualHealth,
          residualModifier,
        };
      }

      while (classified.kind === 'continue' && turns < maxTurns) {
        if (signal?.aborted) return 'aborted';
        if (timedOut()) {
          return {
            actionId: rootAction.id,
            cumulativeRealizedDelta: cumulative,
            outcome: 'time-cap',
            terminalUtility: terminalUtilityOf('time-cap', cumulative),
            turns,
            hypothesisKeys,
            sampledIds,
            residualHealth,
            residualModifier,
          };
        }

        const frozen = freezeObservation(currentState, world);
        classified = classifyRolloutState(frozen);
        if (classified.kind !== 'continue') break;

        const statePolicy = await getOrEvalPolicy(frozen);
        if (!statePolicy.evaluation.choices.length) {
          classified = { kind: 'error', reason: 'no legal represented action' };
          break;
        }
        const ourId = sampleAction(
          statePolicy.evaluation.choices.map((c) => c.action.id),
          statePolicy.pOur,
          rng,
        );
        const ourAct = statePolicy.evaluation.choices.find((c) => c.action.id === ourId)?.action;
        if (!ourAct) throw new Error(`sampled illegal our action ${ourId}`);
        const hyp = hypForActive(statePolicy, world, frozen);
        if (!hyp) throw new Error('frozen world has no matching hypothesis');
        const oppAct = sampleConditionalReply(hyp, rng);
        sampledIds.push(ourAct.id, oppAct.id);

        const stepSets = theirSetsFromWorld(frozen, world);
        const stepSeed = [1 + (turns % 4), 2, 3, 4];
        const simRes = opts?.simulate
          ? opts.simulate(frozen, ourAct, oppAct, stepSeed, stepSets)
          : usePairDelta
            ? passthroughSim(frozen)
            : simulateRound(frozen, ourAct, oppAct, stepSeed, stepSets);
        const stepScore = scoreRound(frozen, ourAct, oppAct, simRes, hyp.key);
        cumulative += stepScore.delta;
        residualHealth += stepScore.residualHealth;
        residualModifier += stepScore.residualModifier;
        turns++;
        currentState = overlayWorld(
          applySimResult(frozen, simRes.afterOurs, simRes.afterTheirs, simRes.afterField, ourAct, oppAct),
          world,
        );
        assertWorldHolds(currentState, world);
        classified = classifyRolloutState(currentState);
      }

      let outcome: RolloutOutcome;
      if (classified.kind !== 'continue') {
        outcome = classified.kind;
        if (outcome === 'unknown-frontier' && classified.reason) frontierReason ??= classified.reason;
      } else {
        outcome = 'turn-cap';
      }
      return {
        actionId: rootAction.id,
        cumulativeRealizedDelta: cumulative,
        outcome,
        terminalUtility: terminalUtilityOf(outcome, cumulative),
        turns,
        hypothesisKeys,
        sampledIds,
        residualHealth,
        residualModifier,
      };
    } catch (err) {
      return {
        actionId: rootAction.id,
        cumulativeRealizedDelta: 0,
        outcome: 'error',
        terminalUtility: 0,
        turns: 0,
        hypothesisKeys,
        sampledIds,
        residualHealth,
        residualModifier,
      };
    }
  };

  function overlayWorld(state: BattleObservation, world: RolloutWorld): BattleObservation {
    return freezeObservation(state, world);
  }

  for (let cycle = 0; cycle < rolloutsPerChoice; cycle++) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }
    if (timedOut()) {
      status = 'partial';
      break;
    }

    for (const rootAction of rootActions) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }
      if (timedOut()) {
        status = 'partial';
        break;
      }
      const rec = await runOneSample(rootAction);
      if (rec === 'aborted') {
        status = signal?.aborted ? 'cancelled' : 'partial';
        break;
      }
      samplesByAction.get(rootAction.id)!.push(rec);
      allRecords.push(rec);
      outcomeCounts[rec.outcome]++;
      totalSamples++;
    }

    if (status !== 'running') break;

    if (opts?.onProgress) {
      const partial = await buildPartialForecast('running', false);
      opts.onProgress(partial);
    }
  }

  const requested = rolloutsPerChoice * rootActions.length;
  const finalStatus: BattleForecast['status'] =
    status !== 'running'
      ? status
      : (totalSamples >= requested ? 'complete' : 'partial');
  const useful = totalSamples > 0 && allRecords.some((r) => r.outcome !== 'error');
  const doneStatus = finalStatus === 'running' ? 'complete' : finalStatus;
  const reported = !useful && allRecords.every((r) => r.outcome === 'error') && totalSamples > 0
    ? 'error'
    : doneStatus;

  return await buildPartialForecast(reported, true);
}

export async function estimateWinrate(
  obs: BattleObservation,
  opts?: EvaluateOptions & { n?: number; maxTurns?: number; rng?: () => number },
): Promise<WinrateResult> {
  const n = opts?.n ?? 16;
  const maxTurns = opts?.maxTurns ?? 12;
  const rolloutsPerChoice = Math.max(1, Math.ceil(n / Math.max(1, obs.legalActions.length || 1)));

  const forecast = await forecastBattle(obs, {
    ...opts,
    rolloutsPerChoice,
    maxTurns,
  });

  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const c of forecast.choices) {
    wins += c.wins;
    losses += c.losses;
    draws += c.draws;
  }
  const total = wins + losses + draws;
  return {
    wins,
    losses,
    draws,
    n: total,
    avgTurns: 0,
  };
}

export type { QuantumPolicyProcess };
