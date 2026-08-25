"""Shallow QAOA / softmax action probabilities."""
from __future__ import annotations

import math
from typing import Any

import numpy as np

PAD_PENALTY = 8.0
QAOA_STEPS = 16



def softmax_probs(scores: list[float]) -> list[float]:
    if not scores:
        raise ValueError("no scores")
    arr = np.asarray(scores, dtype=float)
    arr = arr - np.max(arr)
    ex = np.exp(arr)
    probs = ex / np.sum(ex)
    return [float(x) for x in probs]


def _n_qubits(n_actions: int) -> int:
    if n_actions <= 1:
        return 1
    return int(math.ceil(math.log2(n_actions)))


def qaoa_probs(scores: list[float], *, seed: int | None = None, shots: int | None = None) -> tuple[list[float], dict[str, Any]]:
    if not scores:
        raise ValueError("no scores")
    n = len(scores)
    if n == 1:
        return [1.0], {"n_qubits": 1, "padded": 0, "shots": shots, "exact": shots is None}

    import pennylane as qml

    n_qubits = _n_qubits(n)
    dim = 2 ** n_qubits
    costs = np.full(dim, PAD_PENALTY, dtype=float)
    for i, s in enumerate(scores):
        costs[i] = -float(s)

    if seed is not None:
        np.random.seed(int(seed))

    wires = list(range(n_qubits))
    if shots is None:
        dev = qml.device("default.qubit", wires=n_qubits)
    else:
        dev = qml.device("default.qubit", wires=n_qubits, shots=int(shots), seed=seed)

    @qml.qnode(dev)
    def circuit(params):
        gamma, beta = params[0], params[1]
        for w in wires:
            qml.Hadamard(w)
        qml.DiagonalQubitUnitary(qml.math.exp(-1j * gamma * costs), wires=wires)
        for w in wires:
            qml.RX(2 * beta, w)
        return qml.probs(wires=wires)

    def cost_fn(gamma: float, beta: float) -> float:
        probs = circuit(np.array([gamma, beta], dtype=float))
        return float(np.dot(np.asarray(probs, dtype=float), costs))

    # ponytail: 1-layer QAOA has two parameters; a coarse grid is enough
    # and more stable than autodiff on DiagonalQubitUnitary. Upgrade to
    # GradientDescentOptimizer / p>1 if action counts grow.
    best_params = (0.4, 0.4)
    best_cost = cost_fn(*best_params)
    gammas = np.linspace(0.05, math.pi, QAOA_STEPS)
    betas = np.linspace(0.05, math.pi, QAOA_STEPS)
    for gamma in gammas:
        for beta in betas:
            val = cost_fn(float(gamma), float(beta))
            if val < best_cost:
                best_cost = val
                best_params = (float(gamma), float(beta))

    params = np.array(best_params, dtype=float)
    raw = np.asarray(circuit(params), dtype=float)
    legal = raw[:n].copy()
    if float(legal.sum()) <= 0:
        legal = np.ones(n, dtype=float)
    legal = legal / legal.sum()
    diag = {
        "n_qubits": n_qubits,
        "padded": dim - n,
        "shots": shots,
        "exact": shots is None,
        "params": [float(x) for x in params],
        "cost": float(np.dot(raw, costs)),
    }
    return [float(x) for x in legal], diag


def decide(payload: dict[str, Any]) -> dict[str, Any]:
    actions = list(payload.get("actions") or [])
    scores = [float(x) for x in (payload.get("scores") or [])]
    if len(actions) != len(scores) or not actions:
        raise ValueError("actions and scores must be nonempty equal-length lists")
    mode = payload.get("mode") or "quantum"
    seed = payload.get("seed")
    shots = payload.get("shots")
    if mode == "softmax":
        probs = softmax_probs(scores)
        diag: dict[str, Any] = {"mode": "softmax"}
    else:
        probs, diag = qaoa_probs(
            scores,
            seed=None if seed is None else int(seed),
            shots=None if shots in (None, 0) else int(shots),
        )
        diag["mode"] = "quantum"
    s = sum(probs)
    if s <= 0:
        raise ValueError("policy produced zero mass")
    probs = [p / s for p in probs]
    return {"probabilities": probs, "diagnostics": diag}
