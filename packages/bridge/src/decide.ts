import type { BattleObservation, CanonicalSet, PolicyMode } from '@pokeredus/engine';
import {
  evaluateRound,
  formatChoice,
  sampleAction,
  appendDecisionLog,
  QuantumPolicyProcess,
  loadWeights,
  type RoundEvaluation,
} from '@pokeredus/engine';

export interface DecideClient {
  send(msg: string): void;
}

export interface DecideOptions {
  dryRun?: boolean;
  policy?: PolicyMode;
  process: QuantumPolicyProcess;
  seed?: number;
  shots?: number | null;
  logPath?: string;
  rng?: () => number;
  evaluate?: (obs: BattleObservation) => RoundEvaluation | Promise<RoundEvaluation>;
}

export interface DecideResult {
  evaluation: RoundEvaluation;
  probabilities: number[];
  sampledId: string;
  sent: boolean;
  diagnostics?: Record<string, unknown>;
  teraOurs?: RoundEvaluation;
  teraTheirs?: RoundEvaluation;
}

function probsFromEval(ev: RoundEvaluation): number[] | null {
  const p = ev.choices.map((c) => c.probability ?? 0);
  if (p.length !== ev.choices.length || p.some((x) => x == null)) return null;
  const sum = p.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return null;
  return p.map((x) => x / sum);
}

export async function decideAndAct(
  client: DecideClient,
  obs: BattleObservation,
  opts: DecideOptions,
): Promise<DecideResult> {
  const evaluate = opts.evaluate ?? ((o: BattleObservation) => evaluateRound(o, {
    refine: opts.process,
    policy: opts.policy,
    seed: opts.seed,
    shots: opts.shots,
    weights: loadWeights(),
    refineFallback: 'throw',
  }));
  const evaluation = await Promise.resolve(evaluate(obs));
  const teraOurs: RoundEvaluation | undefined = opts.evaluate ? undefined : {
    ...evaluation,
    choices: evaluation.choices.filter((c) => c.action.tera),
    replies: evaluation.replies,
  };
  const teraTheirs: RoundEvaluation | undefined = opts.evaluate ? undefined : {
    ...evaluation,
    choices: evaluation.choices,
    replies: evaluation.replies.filter((r) => r.action.tera),
  };
  const ids = evaluation.choices.map((c) => c.action.id);
  if (!ids.length) {
    console.warn('[pokeredus] no legal actions this turn');
    // #region agent log
    fetch('http://127.0.0.1:7559/ingest/6200673b-d438-4c7f-9e45-49a0c341555a', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '246bd1' }, body: JSON.stringify({ sessionId: '246bd1', runId: 'pre-fix', hypothesisId: 'D', location: 'decide.ts:decideAndAct', message: 'no legal actions', data: { turn: obs.turn, legalObs: obs.legalActions.length, replies: evaluation.replies.length }, timestamp: Date.now() }) }).catch(() => {});
    // #endregion
    return { evaluation, probabilities: [], sampledId: '', sent: false, teraOurs, teraTheirs };
  }

  let probabilities = probsFromEval(evaluation);
  let diagnostics = evaluation.diagnostics;
  if (!probabilities) {
    const scores = evaluation.choices.map((c) => c.scaledChoiceScore);
    let response;
    try {
      response = await opts.process.decide({
        actions: ids,
        scores,
        mode: opts.policy ?? 'quantum',
        seed: opts.seed,
        shots: opts.shots ?? null,
      });
    } catch (err) {
      console.error('[pokeredus] quantum policy failed; not sending a choice:', err);
      throw err;
    }
    probabilities = response.probabilities;
    diagnostics = response.diagnostics;
    if (probabilities.length !== ids.length) {
      throw new Error('quantum policy returned a distribution that does not match legal actions');
    }
    for (let i = 0; i < evaluation.choices.length; i++) {
      evaluation.choices[i]!.probability = probabilities[i];
    }
  }

  const sampledId = sampleAction(ids, probabilities, opts.rng);
  const choice = evaluation.choices.find((c) => c.action.id === sampledId);
  if (!choice) throw new Error(`sampled illegal action ${sampledId}`);

  for (const c of evaluation.choices) {
    const tag = c.action.type === 'move' ? `cta=${(c.cta ?? 0).toFixed(3)}` : `cts=${(c.cts ?? 0).toFixed(3)}`;
    console.log(`[${c.action.id}] ${tag} impact=${c.expectedImpact.toFixed(3)} choice=${c.choiceScore.toFixed(3)}`);
  }
  console.log(`roundScore=${evaluation.roundScore.toFixed(3)} mate=${evaluation.forcedOutcome} p=${evaluation.mateProbability.toFixed(3)}`);
  console.log(`sampled ${sampledId}`);

  const cmd = formatChoice(choice.action);
  const sent = !opts.dryRun;
  if (opts.dryRun) console.log(`[dry-run] would send: ${cmd}`);
  else client.send(cmd);

  if (opts.logPath) {
    appendDecisionLog(opts.logPath, {
      ts: new Date().toISOString(),
      observation: obs,
      evaluation,
      probabilities,
      sampledAction: sampledId,
      policy: opts.policy ?? 'quantum',
      diagnostics,
    });
  }
  return { evaluation, probabilities, sampledId, sent, diagnostics, teraOurs, teraTheirs };
}

export type { CanonicalSet };
