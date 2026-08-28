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
    return { evaluation, probabilities: [], sampledId: '', sent: false, teraOurs, teraTheirs };
  }

  let probabilities = probsFromEval(evaluation);
  if (!probabilities) {
    throw new Error('evaluation did not return a policy distribution');
  }
  const diagnostics = evaluation.diagnostics;

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
