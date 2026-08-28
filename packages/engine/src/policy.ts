import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyMode } from './observation.js';
import { softmax, signedLog1p } from './math.js';

export interface PolicyRequest {
  id?: string;
  actions: string[];
  scores: number[];
  mode: PolicyMode;
  seed?: number;
  shots?: number | null;
  timeoutMs?: number;
}

export interface PolicyResponse {
  id?: string;
  probabilities: number[];
  diagnostics: Record<string, unknown>;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 40_000;

export function repoRootFromEngine(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

interface PendingItem {
  id?: string;
  resolve: (v: PolicyResponse) => void;
  reject: (e: Error) => void;
}

export class QuantumPolicyProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private pending: PendingItem[] = [];
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private reqSeq = 0;
  readonly timeoutMs: number;
  readonly python: string;
  readonly cwd: string;

  constructor(opts?: { python?: string; cwd?: string; timeoutMs?: number }) {
    this.python = opts?.python ?? process.env.POKEREDUS_PYTHON ?? 'python';
    this.cwd = opts?.cwd ?? path.join(repoRootFromEngine(), 'quantum-policy');
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  start(): void {
    if (this.proc) return;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.failAll(new Error(`quantum-policy failed to start within ${START_TIMEOUT_MS}ms`));
      }, START_TIMEOUT_MS);
    });
    this.ready.catch(() => undefined);
    const proc = spawn(this.python, ['-m', 'pokeredus_quantum'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf('\n');
      while (nl >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (line) this.onLine(line);
        nl = this.buf.indexOf('\n');
      }
    });
    proc.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
    });
    proc.on('error', (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    proc.on('exit', (code) => {
      this.failAll(new Error(`quantum-policy exited (${code})`));
    });
  }

  private markReady(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;
  }

  private failReady(err: Error): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.readyReject?.(err);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private failAll(err: Error): void {
    const proc = this.proc;
    this.proc = null;
    this.failReady(err);
    while (this.pending.length) this.pending.shift()!.reject(err);
    if (proc && !proc.killed) proc.kill();
  }

  private onLine(line: string): void {
    if (!this.pending.length) {
      try {
        const msg = JSON.parse(line) as { ready?: unknown };
        if (msg && msg.ready) this.markReady();
      } catch {
        /* ignore stdout noise before handshake */
      }
      return;
    }
    let waiter: PendingItem | undefined;
    try {
      const parsed = JSON.parse(line) as PolicyResponse & { error?: string };
      if (parsed.id !== undefined) {
        const idx = this.pending.findIndex((p) => p.id === parsed.id);
        if (idx >= 0) {
          waiter = this.pending.splice(idx, 1)[0];
        }
      }
      if (!waiter) {
        waiter = this.pending.shift()!;
      }

      if (parsed.error) {
        throw new Error(`quantum-policy returned error for req ${parsed.id ?? waiter.id ?? 'unknown'}: ${parsed.error}`);
      }
      if (!Array.isArray(parsed.probabilities)) {
        throw new Error(`missing probabilities in quantum-policy response for req ${parsed.id ?? waiter.id ?? 'unknown'}`);
      }
      const probs = parsed.probabilities;
      if (probs.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) {
        throw new Error(`quantum-policy returned non-finite or negative probabilities for req ${parsed.id ?? waiter.id ?? 'unknown'}`);
      }
      const sum = probs.reduce((a, b) => a + b, 0);
      if (!(sum > 0)) {
        throw new Error(`quantum-policy returned zero-mass distribution for req ${parsed.id ?? waiter.id ?? 'unknown'}`);
      }
      waiter.resolve(parsed);
    } catch (e) {
      if (!waiter && this.pending.length) {
        waiter = this.pending.shift();
      }
      if (waiter) {
        waiter.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  }

  async decide(req: PolicyRequest): Promise<PolicyResponse> {
    this.start();
    await this.ready;
    const proc = this.proc;
    if (!proc?.stdin) throw new Error('quantum-policy process is not running');
    const reqId = req.id ?? `req_${++this.reqSeq}_${Date.now()}`;
    const timeout = req.timeoutMs ?? this.timeoutMs;
    const fullReq = { ...req, id: reqId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === wrappedResolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`quantum-policy timed out after ${timeout}ms for req ${reqId}`));
      }, timeout);
      const wrappedResolve = (v: PolicyResponse) => {
        clearTimeout(timer);
        if (v.probabilities.length !== req.actions.length) {
          reject(new Error(`quantum-policy returned distribution of length ${v.probabilities.length}, expected ${req.actions.length} for req ${reqId}`));
          return;
        }
        resolve(v);
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.pending.push({ id: reqId, resolve: wrappedResolve, reject: wrappedReject });
      proc.stdin.write(JSON.stringify(fullReq) + '\n');
    });
  }

  close(): void {
    this.failAll(new Error('quantum-policy closed'));
  }
}

export function sampleAction(ids: string[], probs: number[], rng: () => number = Math.random): string {
  if (!ids.length) throw new Error('no legal actions to sample');
  const sum = probs.reduce((a, b) => a + b, 0);
  if (!(sum > 0) || probs.length !== ids.length) throw new Error('illegal probability distribution');
  let x = rng() * sum;
  for (let i = 0; i < ids.length; i++) {
    x -= probs[i]!;
    if (x <= 0) return ids[i]!;
  }
  return ids[ids.length - 1]!;
}

export interface SidePolicyContext {
  actor: 'ours' | 'theirs';
  /** Present when transforming a hypothesis-conditional opponent policy. Do not put set contents here. */
  hypothesis?: boolean;
}

export interface SidePolicyOptions {
  policy?: PolicyMode;
  seed?: number;
  shots?: number | null;
  refineFallback?: 'throw' | 'softmax';
}

function actorLabel(ctx: SidePolicyContext): string {
  return ctx.hypothesis ? `${ctx.actor} hypothesis` : ctx.actor;
}

function normalizeSideProbs(probs: number[], ids: string[], ctx: SidePolicyContext): number[] {
  if (probs.length !== ids.length) {
    throw new Error(`${actorLabel(ctx)} policy length ${probs.length}, expected ${ids.length}`);
  }
  if (probs.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p < 0)) {
    throw new Error(`${actorLabel(ctx)} policy has non-finite or negative mass`);
  }
  const sum = probs.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) {
    throw new Error(`${actorLabel(ctx)} policy has zero total mass`);
  }
  return probs.map((p) => p / sum);
}

/** Shared validated transform: actor-positive scores in, normalized probabilities out. */
export async function transformSidePolicy(
  process: QuantumPolicyProcess | undefined,
  ids: string[],
  scores: number[],
  opts: SidePolicyOptions,
  ctx: SidePolicyContext,
): Promise<{ probs: number[]; diagnostics: Record<string, unknown> }> {
  if (!ids.length) return { probs: [], diagnostics: { mode: 'empty' } };
  if (scores.length !== ids.length) {
    throw new Error(`${actorLabel(ctx)} score length ${scores.length}, expected ${ids.length}`);
  }
  if (scores.some((s) => !Number.isFinite(s))) {
    throw new Error(`${actorLabel(ctx)} scores must be finite`);
  }

  const useSoftmax = !process || opts.policy === 'softmax';
  if (useSoftmax) {
    return { probs: normalizeSideProbs(softmax(scores), ids, ctx), diagnostics: { mode: 'softmax' } };
  }

  try {
    const res = await process.decide({
      actions: ids,
      scores: scores.map(signedLog1p),
      mode: opts.policy ?? 'quantum',
      seed: opts.seed,
      shots: opts.shots ?? null,
    });
    return {
      probs: normalizeSideProbs(res.probabilities, ids, ctx),
      diagnostics: res.diagnostics ?? { mode: 'quantum' },
    };
  } catch (err) {
    if (opts.refineFallback === 'throw') {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${actorLabel(ctx)} policy failed: ${msg}`);
    }
    return {
      probs: normalizeSideProbs(softmax(scores), ids, ctx),
      diagnostics: { mode: 'softmax', fallback: true },
    };
  }
}
