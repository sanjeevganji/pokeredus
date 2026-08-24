import type { BattleObservation, CanonicalSet, PolicyMode } from '@pokeredus/engine';
import {
  evaluateRound,
  formatChoice,
  sampleAction,
  appendDecisionLog,
  QuantumPolicyProcess,
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
  evaluate?: (obs: BattleObservation) => RoundEvaluation;
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

export async function decideAndAct(
  client: DecideClient,
  obs: BattleObservation,
  opts: DecideOptions,
): Promise<DecideResult> {
  const evaluation = (opts.evaluate ?? evaluateRound)(obs);
  const ids = evaluation.choices.map((c) => c.action.id);
  if (!ids.length) {
    console.warn('[pokeredus] no legal actions this turn');
    return { evaluation, probabilities: [], sampledId: '', sent: false };
  }
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
  const probabilities = response.probabilities;
  if (probabilities.length !== ids.length) {
    throw new Error('quantum policy returned a distribution that does not match legal actions');
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
      diagnostics: response.diagnostics,
    });
  }
  return { evaluation, probabilities, sampledId, sent, diagnostics: response.diagnostics };
}

export type { CanonicalSet };
