# Implementation plans

Advisor index from `/improve`. Executors pick the next TODO in order, run its
done criteria, and update both the plan and this index.

Current overhaul plans were written against commit `b97a334`.

## Recommended order

1. [006-simulator-state-fidelity.md](006-simulator-state-fidelity.md) — make
   counterfactual state and forced revenge switches trustworthy.
2. [007-normalized-move-valuation.md](007-normalized-move-valuation.md) —
   replace mixed score units and connect the existing move-reordering input to
   bounded, persisted human-correction learning.
3. [008-two-sided-round-policy.md](008-two-sided-round-policy.md) — preserve set
   belief mass and weight both actors adversarially over every legal pair.
4. [009-realized-terminal-rollouts.md](009-realized-terminal-rollouts.md) —
   accumulate realized pair deltas, freeze sampled beliefs, and stop at honest
   hidden-team frontiers.

Dependency graph:

```text
001 theater (DONE)
002 scoring foundation (PARTIAL; superseded remainder)
003 set overrides (DONE) ──────────────┐
                                       v
006 simulator fidelity -> 007 valuation/learning -> 008 round policy -> 009 rollouts

004 rollout foundation (PARTIAL; superseded remainder by 006/008/009)
005 live forecast UI (DONE)
```

## Status

| Plan | Current result | Status |
| --- | --- | --- |
| 001-pokelink-battle-theater | Full-page battle theater exists | DONE |
| 002-correct-battle-scoring | Field/Tera telemetry and ranges were implemented; active-state fidelity, normalized valuation, and policy semantics remain | PARTIAL — remainder superseded by 006–008 |
| 003-discovered-set-overrides | Validated store, protocol application, API, provenance, and drawer exist; 35 focused tests pass | DONE |
| 004-terminal-qaoa-rollouts | Rollout loop, cache, Wilson intervals, QAOA calls, and progress exist; remainder superseded by 006/008/009 | PARTIAL — remainder superseded by 006, 008, 009 |
| 005-live-forecast-ui | Versioned points, cumulative/expected graph, log policy meters, choice rows, set drawer, quiet polling, and v1 compatibility | DONE |
| 006-simulator-state-fidelity | Faithful active/state reconstruction and legal revenge switches | TODO |
| 007-normalized-move-valuation | Normalized CTA/CTS valuation, editable effect values, and human reordering learning | TODO |
| 008-two-sided-round-policy | Belief-correct adversarial policies over every legal pair | DONE |
| 009-realized-terminal-rollouts | Realized pair-delta rollouts, frozen worlds, unknown-frontier, +1/-1 terminals; live forecast opt-in (`--forecast`) | DONE |

## Decided contracts

- The official pinned Showdown simulator remains the mechanics authority.
- Move/round deltas use our perspective and are bounded to `[-1,+1]`.
- CTA and CTS are computed success probabilities multiplying conditional value
  exactly once.
- Modifier composition uses summed logs:
  `product(multiplier^(probability × expectedTurns))`.
- Health and modifier value remain separate so setup at full HP retains value.
- Existing `pokeredus/data/effects/{moves,abilities,items}.json` files are the
  editable future-valuation source. They do not reimplement mechanics.
- The existing Scenario drag/keyboard move ordering is the human correction
  input. Corrections update bounded score weights, persist atomically, affect
  reevaluation/live policy, and can be reset. No autonomous ML framework is
  added.
- Both sides use actor-positive policy inputs. Opponent utility is the negative
  of our pair delta.
- Set hypothesis availability and manual overrides remain explicit through
  policy calculation.
- QAOA transforms classical action scores into policy mass. It is not a battle
  simulator, calibrated confidence, or win probability.
- Terminal win/loss is reserved for all-six elimination. Unrevealed species
  produce an `unknown-frontier`, not a fabricated Smeargle/copy battle.
- Forecasting runs outside the live send critical path and may publish partial
  results.

## Verification baseline at `b97a334`

Run on August 28, 2026 before writing plans:

```text
npx vitest run packages/engine/tests/math.test.ts packages/engine/tests/actions.test.ts packages/engine/tests/integration.test.ts packages/engine/tests/scenario.test.ts packages/engine/tests/weights.test.ts
  5 files, 44 tests
  43 passed
  1 failed: integration forecast expected "complete", received "partial"
  Cause observed: real QAOA exceeded the default 10-second forecast budget.

npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge
  engine passed
  bridge failed: src/index.ts duplicate star-export "toId"

npx vitest run packages/engine/tests/set-overrides.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/games-sets.test.ts packages/cli/tests/live-state.test.ts
  4 files, 35 tests passed
```

Plan 006 repairs the bridge typecheck baseline. Plan 009 removes hardware-speed
dependence from functional tests while retaining the real-QAOA benchmark.

## Considered and rejected

- A second damage/speed model — Showdown already owns mechanics.
- Metadata for ordinary mechanics — editable data is valuation-only.
- Applying both sampled effect chance and metadata probability — double counts
  chance (for example, 30% becomes 9%).
- New training framework or correction database — persisted bounded weights
  and saved Scenario rankings already provide the required human-learning
  boundary.
- Learning automatically from wins/losses — no clean human label and outside
  the requested correction workflow.
- Separate opponent score weights — one actor-perspective value model is easier
  to correct and test.
- Capped joint-QAOA reconstruction — drops/warps legal action and hypothesis
  mass; separate side transforms represent every legal action.
- Exact exhaustive battle search — branching grows exponentially.
- Inventing hidden species from public data — public candidates do not reveal
  the unrevealed team.
- Blocking a sent move on terminal forecasting — unsafe at current QAOA
  latency.
- Calling policy mass confidence — empirical rollout intervals provide the
  statistical statement.
- UI redesign or new dependencies — existing Scenario and live controls are
  sufficient.

## Scope not audited

- Knowledge-graph/team-builder behavior unrelated to reusable effect JSON.
- Full repository security/dependency posture.
- Production deployment beyond the current local Vite/CLI architecture.
- Doubles and non-Random-Battle formats.
- Exact strategy quality of every individual valuation constant; the plans
  provide an editable and correctable model rather than claiming universal
  constants.

## Drift and maintenance

- Before executing against a commit newer than `b97a334`, re-read every file in
  that plan's Current state section and update stale excerpts/assumptions.
- Do not reopen completed portions of 002–005. New work belongs to 006–009
  unless a compatibility consumer in an older plan must be migrated.
- Update status only after all focused tests, relevant typechecks, and explicit
  done criteria pass.
- If a plan is blocked or intentionally skipped, record the reason and smallest
  failing fixture here.
- Keep numbering monotonic. Do not create another plan for the same unresolved
  scoring/forecast findings.
