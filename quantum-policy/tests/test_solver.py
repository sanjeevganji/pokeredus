import os
import sys
import math
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pokeredus_quantum.solver import decide, qaoa_probs, softmax_probs


class TestSoftmax(unittest.TestCase):
    def test_normalizes(self):
        p = softmax_probs([1.0, 2.0, 3.0])
        self.assertAlmostEqual(sum(p), 1.0, places=9)
        self.assertTrue(all(x > 0 for x in p))

    def test_equal_scores_symmetric(self):
        p = softmax_probs([0.0, 0.0, 0.0])
        for x in p:
            self.assertAlmostEqual(x, 1 / 3, places=9)


class TestQAOA(unittest.TestCase):
    def test_normalizes_and_excludes_pad(self):
        p, diag = qaoa_probs([0.1, 0.2, 0.3])
        self.assertEqual(len(p), 3)
        self.assertAlmostEqual(sum(p), 1.0, places=6)
        self.assertGreater(diag["padded"], 0)
        self.assertTrue(all(x >= 0 for x in p))
        self.assertIn("cost", diag)
        self.assertIn("params", diag)

    def test_exact_is_deterministic(self):
        a, _ = qaoa_probs([1.0, 0.0, -1.0, 0.2], seed=1)
        b, _ = qaoa_probs([1.0, 0.0, -1.0, 0.2], seed=1)
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, places=8)

    def test_equal_scores_symmetric(self):
        p, _ = qaoa_probs([0.5, 0.5])
        self.assertAlmostEqual(p[0], p[1], places=2)

    def test_better_action_gets_more_mass(self):
        p, _ = qaoa_probs([0.0, 2.0, 0.0])
        self.assertEqual(len(p), 3)
        self.assertGreater(p[1], p[0])
        self.assertGreater(p[1], p[2])

    def test_decide_softmax_mode(self):
        out = decide({"actions": ["a", "b"], "scores": [0.0, 0.0], "mode": "softmax"})
        self.assertAlmostEqual(sum(out["probabilities"]), 1.0)
        self.assertEqual(out["diagnostics"]["mode"], "softmax")

    def test_decide_invalid_payload(self):
        with self.assertRaises(ValueError):
            decide({"actions": ["a"], "scores": [1.0, 2.0]})
        with self.assertRaises(ValueError):
            decide({"actions": [], "scores": []})


class TestBenchmark(unittest.TestCase):
    def test_qaoa_vs_softmax_latency_without_advantage_claim(self):
        scores = [0.2, -0.1, 0.4, 0.0]
        t0 = time.perf_counter()
        sp = softmax_probs(scores)
        softmax_ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        qp, _ = qaoa_probs(scores)
        qaoa_ms = (time.perf_counter() - t1) * 1000
        self.assertEqual(len(sp), len(qp))
        self.assertTrue(math.isfinite(softmax_ms) and math.isfinite(qaoa_ms))
        # Latency/distribution snapshot only — no quantum-advantage claim.
        self.assertAlmostEqual(sum(qp), 1.0, places=6)


class TestServerHandshake(unittest.TestCase):
    def test_ready_then_softmax(self):
        import json
        import subprocess
        root = os.path.join(os.path.dirname(__file__), "..")
        proc = subprocess.Popen(
            [sys.executable, "-m", "pokeredus_quantum"],
            cwd=root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            line = proc.stdout.readline()
            self.assertTrue(json.loads(line).get("ready"))
            proc.stdin.write(json.dumps({"actions": ["a", "b"], "scores": [0.0, 0.0], "mode": "softmax"}) + "\n")
            proc.stdin.flush()
            out = json.loads(proc.stdout.readline())
            self.assertEqual(len(out["probabilities"]), 2)
            self.assertAlmostEqual(sum(out["probabilities"]), 1.0)
        finally:
            proc.kill()
            proc.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
