import * as fs from 'node:fs';
import type { BattleObservation, RoundEvaluation } from './observation.js';

export interface DecisionRecord {
  ts: string;
  observation: BattleObservation;
  evaluation: RoundEvaluation;
  probabilities: number[];
  sampledAction: string;
  policy: string;
  diagnostics?: Record<string, unknown>;
  nextRoundOutcome?: unknown;
}

export function appendDecisionLog(filePath: string, record: DecisionRecord): void {
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}
