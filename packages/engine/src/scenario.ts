import type { BattleObservation, LegalAction, RoundEvaluation, SlotSnapshot, FieldSnapshot } from './observation.js';
import { observationTera } from './observation.js';
import { legalFromSlots } from './actions.js';
import { sampleAction, type QuantumPolicyProcess } from './policy.js';
import { evaluateRound, theirActions, evaluateJointStatePolicy, type EvaluateOptions, type JointPolicyResult } from './evaluate.js';
import { simulateRound } from './sim.js';
import { signedLog1p, wilsonScoreInterval, createSeededRng } from './math.js';

export { legalFromSlots } from './actions.js';

export interface ForecastOptions extends EvaluateOptions {
  rolloutsPerChoice?: number;
  maxTurns?: number;
  timeBudgetMs?: number;
  seed?: number;
  signal?: AbortSignal;
  onProgress?: (partial: BattleForecast) => void;
  cache?: Map<string, JointPolicyResult>;
}

export interface ChoiceForecast {
  actionId: string;
  samples: number;
  wins: number;
  losses: number;
  draws: number;
  capped: number;
  expectedTerminalScore: number;
  minTerminalScore: number;
  maxTerminalScore: number;
  winRate: number;
  winRateLow: number;
  winRateHigh: number;
  policyWeight?: number;
}

export interface BattleForecast {
  turn: number;
  status: 'running' | 'complete' | 'partial' | 'cancelled' | 'incomplete-assumptions' | 'error';
  choices: ChoiceForecast[];
  totalSamples: number;
  elapsedMs: number;
  assumptionsComplete: boolean;
  diagnostics?: Record<string, unknown>;
  error?: string;
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

function ended(ours: SlotSnapshot[], theirs: SlotSnapshot[]): 'win' | 'loss' | null {
  if (theirs.every((s) => s.fainted || s.hp <= 0)) return 'win';
  if (ours.every((s) => s.fainted || s.hp <= 0)) return 'loss';
  return null;
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

function stateCacheKey(obs: BattleObservation): string {
  const slotKey = (s: SlotSnapshot) => {
    const moves = s.moveSlots?.map((m) => `${m.id}:${m.pp}:${m.disabled ? 1 : 0}`).join(',') ?? s.knownMoves.join(',');
    const b = `${s.boosts.atk},${s.boosts.def},${s.boosts.spa},${s.boosts.spd},${s.boosts.spe},${s.boosts.accuracy},${s.boosts.evasion}`;
    const setKey = s.set ? `${s.set.species}:${s.set.ability}:${s.set.item}:${s.set.moves.join(',')}` : '';
    return `${s.slot}:${s.speciesId}:${s.hp}/${s.maxHp}:${s.status}:${s.fainted ? 1 : 0}:${s.active ? 1 : 0}:${s.terastallized ? 1 : 0}:${s.choiceLock ?? ''}:${s.trapped ? 1 : 0}:${b}:${moves}:${setKey}`;
  };

  const fieldKey = `${obs.field.weather}:${obs.field.terrain}:${obs.field.trickroom ? 1 : 0}:${obs.field.hazards_p1.stealthrock ? 1 : 0}:${obs.field.hazards_p1.spikes}:${obs.field.hazards_p1.toxicspikes}:${obs.field.hazards_p1.stickyweb ? 1 : 0}:${obs.field.reflect_p1}:${obs.field.lightscreen_p1}:${obs.field.hazards_p2.stealthrock ? 1 : 0}:${obs.field.hazards_p2.spikes}:${obs.field.hazards_p2.toxicspikes}:${obs.field.hazards_p2.stickyweb ? 1 : 0}:${obs.field.reflect_p2}:${obs.field.lightscreen_p2}`;

  const ourSlots = obs.ours.map(slotKey).join('|');
  const theirSlots = obs.theirs.map(slotKey).join('|');
  return `${obs.ourSide};${obs.teraUsedOurs ? 1 : 0};${obs.teraUsedTheirs ? 1 : 0};${fieldKey};${ourSlots};${theirSlots}`;
}

export function validateAssumptionsComplete(obs: BattleObservation): boolean {
  // All active and non-fainted revealed slots must have complete assumed sets
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
  cumulativeTurnScore: number;
  terminalResult: 'win' | 'loss' | 'draw' | 'capped';
  terminalUtility: number;
  turns: number;
}

export async function forecastBattle(
  obs: BattleObservation,
  opts?: ForecastOptions,
): Promise<BattleForecast> {
  const startTime = Date.now();
  const rolloutsPerChoice = opts?.rolloutsPerChoice ?? 4;
  const maxTurns = opts?.maxTurns ?? 64;
  const timeBudgetMs = opts?.timeBudgetMs ?? 10_000;
  const rng = opts?.seed !== undefined ? createSeededRng(opts.seed) : Math.random;
  const signal = opts?.signal;
  const cache = opts?.cache ?? new Map<string, JointPolicyResult>();

  let cacheHits = 0;
  let cacheMisses = 0;

  if (!validateAssumptionsComplete(obs)) {
    return {
      turn: obs.turn,
      status: 'incomplete-assumptions',
      choices: [],
      totalSamples: 0,
      elapsedMs: Date.now() - startTime,
      assumptionsComplete: false,
      error: 'Incomplete assumed sets for active or revealed combatants',
    };
  }

  const evalOpts: EvaluateOptions = {
    ...opts,
    chanceSeeds: opts?.chanceSeeds ?? 1,
  };

  // 1. Evaluate root state
  const rootPolicy = await evaluateJointStatePolicy(obs, evalOpts);
  const rootActions = rootPolicy.evaluation.choices.map((c) => c.action);
  if (!rootActions.length) {
    return {
      turn: obs.turn,
      status: 'error',
      choices: [],
      totalSamples: 0,
      elapsedMs: Date.now() - startTime,
      assumptionsComplete: true,
      error: 'No legal root actions available',
    };
  }

  const samplesByAction = new Map<string, StratifiedSampleRecord[]>();
  for (const a of rootActions) {
    samplesByAction.set(a.id, []);
  }

  const getOrEvalPolicy = async (state: BattleObservation): Promise<JointPolicyResult> => {
    const key = stateCacheKey(state);
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

  const buildPartialForecast = async (
    currentStatus: BattleForecast['status'],
    computeWeights = false,
  ): Promise<BattleForecast> => {
    const choiceForecasts: ChoiceForecast[] = [];
    const rootMeanUtilities: number[] = [];
    const rootIds: string[] = [];

    for (const a of rootActions) {
      const recs = samplesByAction.get(a.id) ?? [];
      const n = recs.length;
      let wins = 0;
      let losses = 0;
      let draws = 0;
      let capped = 0;
      let utilSum = 0;
      const scores = recs.map((r) => r.terminalUtility);

      for (const r of recs) {
        if (r.terminalResult === 'win') wins++;
        else if (r.terminalResult === 'loss') losses++;
        else if (r.terminalResult === 'capped') { draws++; capped++; }
        else draws++;
        utilSum += r.terminalUtility;
      }

      const meanUtil = n > 0 ? utilSum / n : 0;
      const minScore = scores.length ? Math.min(...scores) : 0;
      const maxScore = scores.length ? Math.max(...scores) : 0;
      const winRate = n > 0 ? wins / n : 0;
      const wilson = wilsonScoreInterval(wins, n);

      choiceForecasts.push({
        actionId: a.id,
        samples: n,
        wins,
        losses,
        draws,
        capped,
        expectedTerminalScore: meanUtil,
        minTerminalScore: minScore,
        maxTerminalScore: maxScore,
        winRate,
        winRateLow: wilson.low,
        winRateHigh: wilson.high,
      });

      rootIds.push(a.id);
      rootMeanUtilities.push(meanUtil);
    }

    // Step 5: Compute final root Hamiltonian weights if requested and samples exist
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
        // Fallback or leave undefined without throwing
      }
    }

    return {
      turn: obs.turn,
      status: currentStatus,
      choices: choiceForecasts,
      totalSamples,
      elapsedMs: Date.now() - startTime,
      assumptionsComplete: true,
      diagnostics: {
        cacheHits,
        cacheMisses,
        legalPairCount: rootPolicy.diagnostics.legalPairCount,
        rolloutsRequested: rolloutsPerChoice * rootActions.length,
        rolloutsCompleted: totalSamples,
      },
    };
  };

  // Stratified cycle loop:
  // Allocate at least one rollout to every root our action before adding samples to any action
  for (let cycle = 0; cycle < rolloutsPerChoice; cycle++) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }
    if (Date.now() - startTime >= timeBudgetMs) {
      status = 'partial';
      break;
    }

    for (const rootAction of rootActions) {
      if (signal?.aborted) {
        status = 'cancelled';
        break;
      }
      if (Date.now() - startTime >= timeBudgetMs) {
        status = 'partial';
        break;
      }

      // Root action step:
      // Sample opponent reply conditional on rootAction from root policy
      const oppReplies = rootPolicy.evaluation.replies.map((r) => r.action);
      const oppProbs = rootPolicy.evaluation.replies.map((r) => {
        const key = `${rootAction.id}\t${r.action.id}`;
        return rootPolicy.jointProbs.get(key) ?? 0;
      });
      const oppSum = oppProbs.reduce((a, b) => a + b, 0);
      const chosenOppId = oppSum > 0
        ? sampleAction(oppReplies.map((r) => r.id), oppProbs, rng)
        : (oppReplies[0]?.id ?? 'move:splash');
      const rootOpp = oppReplies.find((r) => r.id === chosenOppId) ?? oppReplies[0] ?? { id: 'move:splash', type: 'move' as const, moveId: 'splash' };

      // Simulate root round
      const rootSim = simulateRound(obs, rootAction, rootOpp, [1 + (totalSamples % 4), 2, 3, 4]);
      let cumulativeScore = rootPolicy.evaluation.choices.find((c) => c.action.id === rootAction.id)?.choiceScore ?? 0;
      let currentState = applySimResult(obs, rootSim.afterOurs, rootSim.afterTheirs, rootSim.afterField, rootAction, rootOpp);

      let terminal: 'win' | 'loss' | 'draw' | 'capped' | null = null;
      if (rootSim.weWin) terminal = 'win';
      else if (rootSim.theyWin) terminal = 'loss';
      else terminal = ended(currentState.ours, currentState.theirs);

      let turns = 1;

      // Rollout future turns until terminal or safety cap
      while (!terminal && turns < maxTurns) {
        if (signal?.aborted || Date.now() - startTime >= timeBudgetMs) {
          terminal = 'capped';
          break;
        }

        const statePolicy = await getOrEvalPolicy(currentState);
        if (!statePolicy.evaluation.choices.length) {
          terminal = 'draw';
          break;
        }

        // Sample joint pair
        const ourChoices = statePolicy.evaluation.choices.map((c) => c.action);
        const theirChoices = statePolicy.evaluation.replies.map((r) => r.action);
        if (!ourChoices.length || !theirChoices.length) {
          terminal = 'draw';
          break;
        }

        const ourId = sampleAction(ourChoices.map((c) => c.id), statePolicy.pOur, rng);
        const ourAct = ourChoices.find((c) => c.id === ourId) ?? ourChoices[0]!;

        const oppId = sampleAction(theirChoices.map((r) => r.id), statePolicy.pTheir, rng);
        const oppAct = theirChoices.find((r) => r.id === oppId) ?? theirChoices[0]!;

        const simRes = simulateRound(currentState, ourAct, oppAct, [1 + (turns % 4), 2, 3, 4]);
        const choiceScore = statePolicy.evaluation.choices.find((c) => c.action.id === ourAct.id)?.choiceScore ?? 0;
        cumulativeScore += choiceScore;

        turns++;
        if (simRes.weWin) { terminal = 'win'; break; }
        if (simRes.theyWin) { terminal = 'loss'; break; }

        currentState = applySimResult(currentState, simRes.afterOurs, simRes.afterTheirs, simRes.afterField, ourAct, oppAct);
        terminal = ended(currentState.ours, currentState.theirs);
      }

      if (!terminal) {
        terminal = 'capped';
      }

      const winInd = terminal === 'win' ? 1 : 0;
      const lossInd = terminal === 'loss' ? 1 : 0;
      const terminalUtility = cumulativeScore + 6 * (winInd - lossInd);

      samplesByAction.get(rootAction.id)!.push({
        actionId: rootAction.id,
        cumulativeTurnScore: cumulativeScore,
        terminalResult: terminal,
        terminalUtility,
        turns,
      });
      totalSamples++;
    }

    // Emit progress after each completed stratification cycle
    if (opts?.onProgress) {
      const partial = await buildPartialForecast('running', false);
      opts.onProgress(partial);
    }
  }

  const finalStatus: BattleForecast['status'] =
    status !== 'running' ? status : (totalSamples >= rolloutsPerChoice * rootActions.length ? 'complete' : 'partial');

  return await buildPartialForecast(finalStatus, true);
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
