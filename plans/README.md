# Implementation plans

Advisor index from `/improve`. Executors pick the next TODO in order and update Status.

Written against commit `1ac76f2`.

## Order

1. [001-pokelink-battle-theater.md](001-pokelink-battle-theater.md) — no dependencies.

## Status

| Plan | Finding | Status |
| --- | --- | --- |
| 001-pokelink-battle-theater | PokeLink HUD stays on Games; open a full-page theater with scores/bars only | DONE |

## Considered and rejected

- Opening the battle with `window.open` — popup blockers; `/api/live` is same-origin.
- Adding Tailwind — web UI already uses custom neon CSS; no new dependency.
- Calling `@pokeredus/calc` for hits-to-kill on the live path — second damage model; derive HKO from the existing Showdown one-round sim HP fractions.
