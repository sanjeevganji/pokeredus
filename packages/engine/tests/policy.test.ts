import { describe, it, expect, afterEach } from 'vitest';
import { QuantumPolicyProcess, sampleAction } from '../src/policy.js';

describe('QuantumPolicyProcess hardening', () => {
  let proc: QuantumPolicyProcess | null = null;

  afterEach(() => {
    if (proc) {
      proc.close();
      proc = null;
    }
  });

  it('rejects illegal distribution with non-matching length', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 10_000 });
    await expect(proc.decide({
      actions: ['a', 'b', 'c'],
      scores: [1.0, 2.0], // mismatch length
      mode: 'softmax',
    })).rejects.toThrow();
  });

  it('times out and cleans up pending waiter', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 50 });
    // Intentionally request with very short timeout
    await expect(proc.decide({
      actions: ['a', 'b'],
      scores: [0.1, 0.2],
      mode: 'quantum',
      timeoutMs: 1,
    })).rejects.toThrow(/timed out/);
  });

  it('returns valid normalized probabilities in softmax mode', async () => {
    proc = new QuantumPolicyProcess({ timeoutMs: 10_000 });
    const res = await proc.decide({
      actions: ['m1', 'm2', 'm3'],
      scores: [0.1, 0.5, 0.2],
      mode: 'softmax',
    });
    expect(res.probabilities).toHaveLength(3);
    const sum = res.probabilities.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('sampleAction rejects empty or invalid probabilities', () => {
    expect(() => sampleAction([], [])).toThrow('no legal actions');
    expect(() => sampleAction(['a'], [0])).toThrow('illegal probability distribution');
    expect(() => sampleAction(['a', 'b'], [0.5])).toThrow('illegal probability distribution');
  });
});
