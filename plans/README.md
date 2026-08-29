# Implementation plans

Advisor index from `/improve`. Battle evaluation 001–009 is shipped. Do not
reopen those findings. New work starts at **010**.

## Shipped (001–009)

```text
001 theater ──► 002 scoring (partial; remainder → 006–008)
                003 set overrides ──┐
004 rollouts (partial; remainder → 006/008/009)
005 live forecast UI                │
                                    v
006 sim fidelity → 007 valuation/learning → 008 round policy → 009 rollouts
```

| Plan | Shipped |
| --- | --- |
| 001 theater | Full-page `/games/live` |
| 002 scoring | Field/Tera telemetry; remainder in 006–008 |
| 003 set overrides | Validated store, protocol, API, drawer |
| 004 rollouts | Loop/cache/Wilson/QAOA; remainder in 006/008/009 |
| 005 live forecast UI | Versioned points, graph, meters, set drawer |
| 006 sim fidelity | Observed active, PP/item/boosts/Tera, forced revenge, illegal choices throw |
| 007 valuation | CTA/CTS × weighted features, effect JSON, Scenario weight learning |
| 008 round policy | Belief-correct two-sided QAOA over every legal pair |
| 009 rollouts | Realized pair deltas, frozen worlds, `unknown-frontier`; `--forecast` opt-in |

## Contracts (do not regress)

Authoritative code: `packages/engine/src/{sim,actions,evaluate,math,weights,effect-valuation,scenario,policy}.ts`,
`packages/bridge/src/protocol.ts`, `packages/web/server/scenario-handlers.ts`.
Product formulas: [README.md](../README.md).

- Showdown is the mechanics authority. Effect JSON is valuation-only.
- `SlotSnapshot.slot` is the public identity. Simulator packed indices stay private.
- Empty item `""` is known-absent; `undefined` is unknown. Do not refill known-empty.
- Forced revenge = fainted/missing active: no moves, living revealed bench only.
- Illegal Showdown choices throw (action IDs + state). Never score a swallowed no-op.
- Deltas are our-perspective, clamped `[-1,+1]`. CTA/CTS multiply conditional value once.
- Log modifiers sum; a `1×` term does not dilute. Health and modifier stay separate in **policy** features (`scoreRealizedPair`). HUD `observationStateScore` is a mixed diagnostic — do not feed it into QAOA or rollouts.
- Both sides use actor-positive features. Opponent utility is `-D`. Separate side transforms; no 32-pair joint cap.
- Manual set override is the simulation assumption (mass 1). Public hyps stay for display.
- QAOA is policy mass, not confidence or win probability. `availability` is hyp-legal mass.
- Terminal `+1/−1` is all-six KO only. Hidden species → `unknown-frontier`, never Smeargle/copy.
- Scenario reorder is the human learner: bounded `score-weights.json`, atomic save, reset exists.
- Forecast is off the live send path (`--forecast`). Partial results are allowed.

## Verification

```bash
npx vitest run packages/engine/tests/actions.test.ts packages/engine/tests/sim.test.ts packages/engine/tests/math.test.ts packages/engine/tests/weights.test.ts packages/engine/tests/effect-valuation.test.ts packages/engine/tests/integration.test.ts packages/engine/tests/scenario.test.ts packages/engine/tests/policy.test.ts packages/engine/tests/set-overrides.test.ts packages/web/server/scenario-rank.test.ts packages/cli/tests/protocol.test.ts packages/cli/tests/games-sets.test.ts packages/cli/tests/live-state.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/web
```

Expect exit 0. Functional forecast tests inject softmax/fake clock; do not gate on real-QAOA wall time.

## Next work (unplanned)

Number from **010**. Match the contracts above. Candidates, not tickets:

1. Forecast budget — stratified real QAOA still exceeds the default 10s cycle; keep `--forecast` opt-in until a cycle completes without hanging send.
2. Doubles / non-Random-Battle — protocol and packing are singles + no-duplicate-species.
3. Valuation coverage — fill `pokeredus/data/effects/*.json` `valuation` objects; unvalued IDs stay neutral + diagnostic. Do not reimplement mechanics.
4. Team-builder / KG — out of battle-eval scope unless it shares effect JSON.

Rejected (do not plan again): second damage model, metadata for ordinary mechanics, double-counting chance, ML training framework, learning from W/L, separate opponent weights, capped joint-QAOA, exhaustive search, inventing hidden species, blocking send on forecast, calling policy mass “confidence”, UI redesign, new deps.

## Maintenance

- Keep numbering monotonic. Status changes only after focused tests + typecheck.
- Reviewers should reject: swallowed illegal choices, stale field fallback, packed indices in public IDs, TTK in normalized utility, probability applied twice, silent rank-ID filtering, Smeargle/copy terminals, caller-specific legality forks.
