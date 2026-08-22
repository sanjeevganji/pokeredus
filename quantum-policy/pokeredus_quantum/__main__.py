"""JSON-lines stdin/stdout policy server."""
from __future__ import annotations

import json
import sys

from .solver import decide


def main() -> None:
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
