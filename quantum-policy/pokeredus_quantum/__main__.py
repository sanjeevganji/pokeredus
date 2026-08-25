"""JSON-lines stdin/stdout policy server."""
from __future__ import annotations

import json
import sys

from .solver import decide


def main() -> None:
    # Load PennyLane before serving. Node's per-request timeout does not
    # cover this (~8s cold import); the ready line is the handshake.
    import pennylane as _qml  # noqa: F401

    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
            out = decide(payload)
        except Exception as exc:
            out = {"error": str(exc), "probabilities": []}
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
