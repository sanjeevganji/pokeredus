import { createHash } from 'node:crypto';
import type { GameState } from './game-state.js';
import type { ProbabilisticEngine, SimAction } from './probabilistic-engine.js';

export class MCTSNode {
  visits = 0;
  value_sum = 0;
  children = new Map<string, MCTSNode>();
  untried_actions: SimAction[] = [];

  constructor(
    readonly state_hash: string,
    readonly action: SimAction | null = null,
    readonly parent: MCTSNode | null = null,
  ) {}

  get value(): number {
    return this.visits === 0 ? 0.5 : this.value_sum / this.visits;
  }

  get is_leaf(): boolean {
    return this.children.size === 0;
  }

  get is_fully_expanded(): boolean {
    return this.untried_actions.length === 0;
  }

  ucb1(parentVisits: number, exploration = 2.0): number {
    if (this.visits === 0) return Infinity;
    const exploitation = this.value;
    const explorationTerm = exploration * Math.sqrt(Math.log(parentVisits) / this.visits);
    return exploitation + explorationTerm;
  }
}

export interface MCTSEdge {
  parent_hash: string;
  child_hash: string;
  action: SimAction;
  visit_count: number;
  value: number;
}

export interface MCTSGraph {
  root: MCTSNode;
  nodes: MCTSNode[];
  edges: MCTSEdge[];
  best_path: Array<[MCTSNode, SimAction | null]>;
  iterations: number;
  root_value: number;
}

/** ponytail: minimal mulberry32 PRNG for deterministic expansion order */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bucketHp(current: number, maxHp: number): number {
  if (maxHp <= 0) return 0;
  const pct = current / maxHp;
  if (pct >= 0.75) return 4;
  if (pct >= 0.50) return 3;
  if (pct >= 0.25) return 2;
  if (pct > 0) return 1;
  return 0;
}

export function hashState(state: GameState): string {
  const activeA = state.getActivePokemon('a');
  const activeB = state.getActivePokemon('b');
  const keyParts = {
    turn: state.turn,
    active_a: activeA?.set_id ?? '',
    active_b: activeB?.set_id ?? '',
    hp_a: activeA ? bucketHp(activeA.current_hp, activeA.max_hp) : 0,
    hp_b: activeB ? bucketHp(activeB.current_hp, activeB.max_hp) : 0,
    alive_a: state.team_a.filter((p) => !p.isFainted).map((p) => p.set_id),
    alive_b: state.team_b.filter((p) => !p.isFainted).map((p) => p.set_id),
    trick_room: state.trick_room,
  };
  const raw = JSON.stringify(keyParts);
  return createHash('md5').update(raw).digest('hex').slice(0, 12);
}

export class MCTSSearcher {
  private readonly rng: () => number;

  constructor(
    readonly engine: ProbabilisticEngine,
    readonly maxIterations = 100,
    readonly exploration = 2.0,
    seed: number | null = null,
  ) {
    this.rng = seed != null ? mulberry32(seed) : Math.random;
  }

  search(state: GameState, perspective: 'a' | 'b' = 'a'): MCTSGraph {
    const root = new MCTSNode(hashState(state));
    root.untried_actions = this.engine.getAvailableActions(state, perspective);

    for (let i = 0; i < this.maxIterations; i++) {
      let [node, simState] = this.select(root, state);

      if (!node.is_fully_expanded && simState) {
        node = this.expand(node, simState, perspective);
      }

      let value = 0.5;
      if (simState) {
        const [isOver, winner] = simState.isBattleOver();
        if (isOver) {
          value = winner === perspective ? 1.0 : winner == null ? 0.5 : 0.0;
        } else {
          value = this.simulate(simState, perspective);
        }
      }

      this.backpropagate(node, value);
    }

    return this.extractGraph(root);
  }

  private select(
    root: MCTSNode,
    rootState: GameState,
  ): [MCTSNode, GameState | null] {
    let node = root;
    const state = rootState.clone();

    while (!node.is_leaf && node.is_fully_expanded) {
      let bestChild: MCTSNode | null = null;
      let bestUcb = -Infinity;

      for (const child of node.children.values()) {
        const ucb = child.ucb1(node.visits, this.exploration);
        if (ucb > bestUcb) {
          bestUcb = ucb;
          bestChild = child;
        }
      }

      if (!bestChild) break;
      if (bestChild.action) this.engine.executeAction(state, bestChild.action);
      node = bestChild;
    }

    return [node, state];
  }

  private expand(node: MCTSNode, state: GameState, perspective: 'a' | 'b'): MCTSNode {
    if (!node.untried_actions.length) return node;

    const action = node.untried_actions.shift()!;
    this.shuffle(node.untried_actions);

    const newState = state.clone();
    this.engine.executeAction(newState, action);

    const child = new MCTSNode(hashState(newState), action, node);
    child.untried_actions = this.engine.getAvailableActions(newState, perspective);
    this.shuffle(child.untried_actions);

    node.children.set(child.state_hash, child);
    return child;
  }

  private simulate(state: GameState, perspective: 'a' | 'b'): number {
    const result = this.engine.rollout(state.clone());
    if (result.winner === perspective) return 1.0;
    if (result.winner === 'draw') return 0.5;
    return 0.0;
  }

  private backpropagate(node: MCTSNode, value: number): void {
    let current: MCTSNode | null = node;
    while (current) {
      current.visits++;
      current.value_sum += value;
      current = current.parent;
    }
  }

  private extractGraph(root: MCTSNode): MCTSGraph {
    const allNodes: MCTSNode[] = [];
    const allEdges: MCTSEdge[] = [];

    const visit = (node: MCTSNode): void => {
      allNodes.push(node);
      for (const child of node.children.values()) {
        if (child.action) {
          allEdges.push({
            parent_hash: node.state_hash,
            child_hash: child.state_hash,
            action: child.action,
            visit_count: child.visits,
            value: child.value,
          });
        }
        visit(child);
      }
    };
    visit(root);

    const bestPath: Array<[MCTSNode, SimAction | null]> = [[root, null]];
    let current = root;
    while (current.children.size > 0) {
      let bestChild: MCTSNode | null = null;
      let bestVisits = -1;
      for (const child of current.children.values()) {
        if (child.visits > bestVisits) {
          bestVisits = child.visits;
          bestChild = child;
        }
      }
      if (!bestChild) break;
      bestPath.push([bestChild, bestChild.action]);
      current = bestChild;
    }

    return {
      root,
      nodes: allNodes,
      edges: allEdges,
      best_path: bestPath,
      iterations: this.maxIterations,
      root_value: root.value,
    };
  }

  private shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
  }
}
