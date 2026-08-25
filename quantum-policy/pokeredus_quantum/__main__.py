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
        req_id = None
        try:
            payload = json.loads(line)
            req_id = payload.get("id") if isinstance(payload, dict) else None
            out = decide(payload)
            if req_id is not None:
                out["id"] = req_id
        except Exception as exc:
            out = {"error": str(exc), "probabilities": []}
            if req_id is not None:
                out["id"] = req_id
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
