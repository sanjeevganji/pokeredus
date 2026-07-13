import * as fs from 'node:fs';
import type { PackIndex } from '@pokeredus/pack';
import type { Biases } from '@pokeredus/biases';
import { scoreTurn, type TurnState, type Action, makeMon, emptyField } from '@pokeredus/engine';
import { computeMatchup } from '../matchup/engine.js';
import { KnowledgeGraph } from '../kg/knowledge-graph.js';
import type { SetClass } from '../classes/sets.js';

export interface UnifiedAction {
  kind: 'move' | 'switch' | 'tera';
  label: string;
  detail: Record<string, unknown>;
  score: number;
  reasoning: string[];
  is_recommended: boolean;
}

export interface TrainingSample {
  scene_text: string;
  action_text: string;
  reward?: number;
}

export function recommendActions(
  state: TurnState,
  pack: PackIndex,
  biases: Biases,
  topN = 3,
): UnifiedAction[] {
  const scored = scoreTurn(state, pack, biases);
  return scored.slice(0, topN).map((s, i) => ({
    kind: s.action.type === 'move' ? (s.action.tera ? 'tera' : 'move') : 'switch',
    label: actionLabel(s.action, pack),
    detail: { action: s.action },
    score: s.score,
    reasoning: s.reasoning,
    is_recommended: i === 0,
  }));
}

function actionLabel(action: Action, pack: PackIndex): string {
  if (action.type === 'switch') return `Switch slot ${action.slot ?? '?'}`;
  const move = action.moveId ? pack.getMove(action.moveId) : undefined;
  const name = move?.name ?? action.moveId ?? 'move';
  return action.tera ? `${name} (Tera)` : name;
}

export function renderScene(state: TurnState, pack: PackIndex, verbose = true): string {
  const my = pack.getSet(state.myActive.setId);
  const opp = pack.getSet(state.oppActive.setId);
  const lines = [
    `Turn ${state.turn}`,
    `You: ${my?.set_name ?? state.myActive.setId} HP ${state.myActive.hp}/${state.myActive.maxHp}`,
    `Opp: ${opp?.set_name ?? state.oppActive.setId} HP ${state.oppActive.hp}/${state.oppActive.maxHp}`,
  ];
  if (verbose && state.field.weather) lines.push(`Weather: ${state.field.weather}`);
  return lines.join('\n');
}

export function exportTrainingCorpus(
  samples: TrainingSample[],
  outPath: string,
): void {
  const lines = samples.map((s) => JSON.stringify(s));
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
}

/** Pairwise matchup preview for set editor / GUI. */
export function previewMatchup(
  setA: SetClass,
  setB: SetClass,
  kg: KnowledgeGraph,
) {
  return computeMatchup(setA, setB, kg);
}

/** Build a minimal TurnState from two set ids for simulator/GUI. */
export function stateFromSets(
  mySetId: string,
  oppSetId: string,
  pack: PackIndex,
): TurnState {
  const mySet = pack.getSet(mySetId);
  const oppSet = pack.getSet(oppSetId);
  const myHp = mySet ? 100 : 100;
  const oppHp = oppSet ? 100 : 100;
  return {
    side: 'a',
    turn: 1,
    myActive: makeMon(mySetId, myHp),
    myBench: [],
    oppActive: makeMon(oppSetId, oppHp),
    field: emptyField(),
    teraUsed: false,
    allowThin: true,
  };
}
