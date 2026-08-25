# Implementation plans

Advisor index from `/improve`. Executors pick the next TODO in order and update Status.

Current plan set written against commit `a400fd1`.

## Order

1. [001-pokelink-battle-theater.md](001-pokelink-battle-theater.md) — DONE; no dependencies.
2. [002-correct-battle-scoring.md](002-correct-battle-scoring.md) — correct the shared simulator/scoring/Tera boundary before any forecast consumes it.
3. [003-discovered-set-overrides.md](003-discovered-set-overrides.md) — depends on 002; supply explicit, editable full-set assumptions.
4. [004-terminal-qaoa-rollouts.md](004-terminal-qaoa-rollouts.md) — depends on 002 and 003; run budgeted terminal forecasts from trustworthy complete inputs.
5. [005-live-forecast-ui.md](005-live-forecast-ui.md) — depends on 002, 003, and 004; expose the versioned live contract and UI last.

Dependency graph:

```text
001 (DONE)
  └─ 002 scoring/simulator/Tera
       ├─ 003 assumed-set overrides
       │    └─ 004 terminal QAOA rollouts
       │         └─ 005 live forecast UI
       └─────────────────────────────┘
```

## Status

| Plan | Finding | Status |
| --- | --- | --- |
| 001-pokelink-battle-theater | PokeLink HUD stays on Games; open a full-page theater with scores/bars only | DONE |
| 002-correct-battle-scoring | Showdown fields, CTA, switch scoring, ranges, and legal Tera are incorrect or incomplete | TODO |
| 003-discovered-set-overrides | Public candidates cannot be selected, corrected, persisted, or labeled as assumptions | TODO |
| 004-terminal-qaoa-rollouts | Existing winrate simulation is bounded, non-progressive, and does not use QAOA at future states | TODO |
| 005-live-forecast-ui | Live history is independent round means; graph/choice rows lack cumulative ranges and honest confidence semantics | TODO |

## Decisions

- Use budgeted terminal Monte Carlo rollouts, not an exact exhaustive game tree.
- Invoke QAOA as a joint-action policy at represented simulated states. QAOA circuit depth is not labeled as battle turns.
- QAOA output is `policyWeight`; empirical rollout win rate and Wilson interval provide forecast/confidence information.
- Public Random Battle data provides candidate assumptions, not hidden ground truth. Manual overrides remain labeled `Assumed`.
- Forecasting runs outside the live send critical path and may publish progressive partial results.
- Reuse the official Showdown simulator, existing set pool/beliefs, `estimateWinrate`, JSON polling, custom SVG/CSS, and PennyLane subprocess. Add no dependency.

## Considered and rejected

- Opening the battle with `window.open` — popup blockers; `/api/live` is same-origin.
- Adding Tailwind — web UI already uses custom neon CSS; no new dependency.
- Calling `@pokeredus/calc` for hits-to-kill on the live path — second damage model; derive HKO from the existing Showdown one-round sim HP fractions.
- Encoding the whole battle as one QAOA circuit with one semantic layer per turn — legal choices and state transitions depend on prior stochastic outcomes; QAOA layers repeat cost/mixer evolution and do not model that game tree.
- Treating QAOA amplitudes as calibrated win probability or confidence — they are sampling weights over classical costs.
- Exact exhaustive full-battle search — joint choices and chance branches grow exponentially.
- Claiming both hidden teams are known from public data — the live protocol does not reveal unrevealed species or exact opponent sets.
- Blocking the sent move on terminal forecasting — current per-state QAOA latency makes that unsafe; use a separate progressive process.
- Replacing QAOA with softmax while still labeling the forecast quantum — softmax remains an explicit benchmark/fallback only.

## Verification baseline

Read-only baseline run at `a400fd1`:

```text
npx vitest run packages/engine/tests/math.test.ts packages/engine/tests/scenario.test.ts packages/engine/tests/integration.test.ts packages/cli/tests/live-state.test.ts
  4 files, 24 tests passed

python -m unittest discover -s quantum-policy/tests
  9 tests passed
```

The Python suite emitted `ResourceWarning` messages for unclosed subprocess streams but exited successfully. Plans must not treat those warnings as a failed baseline.

Every executor must run the focused commands in its plan plus relevant workspace typechecks. Plan 005 also requires web build and keyboard/browser checks at 375, 768, and 1440px.

## Audit scope

Audited:

- live observation → one-round simulation → scoring → QAOA → live JSON → theater;
- terminal scenario simulation and quantum subprocess;
- public set beliefs, Tera availability, and scenario/live persistence patterns;
- graph/choice accessibility and polling behavior.

Not audited:

- the knowledge-graph/team-builder Python stack beyond reusable set concepts;
- deployment/production server architecture outside the Vite development server;
- doubles or non-Random-Battle formats;
- full repository security and dependency review.

## Drift and maintenance

- Plan 001 remains DONE; plans 002–005 extend it rather than reopening it.
- Before executing a TODO against a commit newer than `a400fd1`, re-read every file in that plan's Current state section and update excerpts/line assumptions.
- Update this index status only after the plan's tests and done criteria pass.
- If a plan is intentionally skipped or superseded, record the reason here so a later `/improve` run does not rediscover it.
