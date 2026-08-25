import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyMode } from './observation.js';

export interface PolicyRequest {
  actions: string[];
  scores: number[];
  mode: PolicyMode;
  seed?: number;
  shots?: number | null;
}

export interface PolicyResponse {
  probabilities: number[];
  diagnostics: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 40_000;

export function repoRootFromEngine(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

export class QuantumPolicyProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private pending: Array<{ resolve: (v: PolicyResponse) => void; reject: (e: Error) => void }> = [];
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((e: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.failReady(err);
    while (this.pending.length) this.pending.shift()!.reject(err);
    this.proc = null;
  }

  private onLine(line: string): void {
    const waiter = this.pending.shift();
    if (!waiter) {
      this.markReady();
      return;
    }
    try {
      const parsed = JSON.parse(line) as PolicyResponse;
      if (!Array.isArray(parsed.probabilities)) throw new Error('missing probabilities');
      waiter.resolve(parsed);
    } catch (e) {
      waiter.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async decide(req: PolicyRequest): Promise<PolicyResponse> {
    this.start();
    await this.ready;
    const proc = this.proc;
    if (!proc?.stdin) throw new Error('quantum-policy process is not running');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.resolve === wrappedResolve);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(new Error(`quantum-policy timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      const wrappedResolve = (v: PolicyResponse) => {
        clearTimeout(timer);
        resolve(v);
      };
      const wrappedReject = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.pending.push({ resolve: wrappedResolve, reject: wrappedReject });
      proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  close(): void {
    this.proc?.kill();
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
