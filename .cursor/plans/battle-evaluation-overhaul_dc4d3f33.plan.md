---
name: battle-evaluation-overhaul
overview: Produce four self-contained executor plans that repair simulator fidelity first, replace move valuation with the agreed normalized CTA/CTS contract, then rebuild two-sided round weighting and terminal rollouts. Only `plans/` markdown will be changed; source implementation remains for later executors.
todos:
  - id: reconcile-index
    content: Reconcile the existing plan index and status drift at commit b97a334
    status: pending
  - id: plan-simulator
    content: Author plan 006 for faithful state reconstruction and revenge-switch legality
    status: pending
  - id: plan-valuation
    content: Author plan 007 for normalized CTA/CTS move valuation and editable effect metadata
    status: pending
  - id: plan-round-policy
    content: Author plan 008 for belief-correct adversarial two-sided round weighting
    status: pending
  - id: plan-rollouts
    content: Author plan 009 for realized terminal rollouts and neutral hidden frontiers
    status: pending
isProject: false
---

# Battle Evaluation Overhaul Plans

## Deliverables
- Reconcile [`plans/README.md`](plans/README.md) against commit `b97a334`: preserve completed history, mark partially implemented 002–005 accurately, and supersede their unresolved scoring/forecast sections with plans 006–009.
- Write [`plans/006-simulator-state-fidelity.md`](plans/006-simulator-state-fidelity.md): restore the observed active slots and all score-relevant state in [`packages/engine/src/sim.ts`](packages/engine/src/sim.ts) and [`packages/bridge/src/protocol.ts`](packages/bridge/src/protocol.ts); derive forced-switch/revenge legality in [`packages/engine/src/actions.ts`](packages/engine/src/actions.ts); reject illegal branches; repair the bridge typecheck baseline.
- Write [`plans/007-normalized-move-valuation.md`](plans/007-normalized-move-valuation.md): replace mixed CTA/TTK/HP units in [`packages/engine/src/math.ts`](packages/engine/src/math.ts) and [`packages/engine/src/evaluate.ts`](packages/engine/src/evaluate.ts) with a branch-tested six-Pokémon utility delta clamped to `[-1,+1]`. CTA and CTS are computed branch probabilities multiplying conditional value exactly once. Modifier composition uses summed logs (`product(multiplier^(probability × expectedTurns))`) and remains separate from health so setup at full HP retains value.
- Reuse [`pokeredus/data/effects/moves.json`](pokeredus/data/effects/moves.json), [`abilities.json`](pokeredus/data/effects/abilities.json), and [`items.json`](pokeredus/data/effects/items.json) as the editable valuation source. Showdown Dex/simulation remains authoritative for mechanics, conditions, and default probabilities; validated overrides provide valuation multiplier, expected turns, and optional probability replacement. No new dependency or editor UI.
- Write [`plans/008-two-sided-round-policy.md`](plans/008-two-sided-round-policy.md): evaluate every our-action × opponent-action branch, calculate the opponent policy from opponent-perspective net utility, preserve hypothesis availability mass/manual overrides/revealed bench sets, and compute `roundScore = Σ P(ours) × P(theirs|hypothesis) × pairDelta`. Replace capped joint-QAOA reconstruction with separate side policy transforms so all legal actions remain represented.
- Write [`plans/009-realized-terminal-rollouts.md`](plans/009-realized-terminal-rollouts.md): consume the completed round evaluator, accumulate realized pair deltas, sample beliefs consistently, preserve cache-relevant state, and stop honestly at an unrevealed-team frontier instead of simulating Smeargle or duplicate active sets. Terminal `+1/-1` remains reserved for all-six win/loss.

## Verification contract embedded in every plan
- Add focused failing-first tests for active-slot reconstruction, cleared fields, PP/item/lock state, forced revenge switches, CTA/CTS partitioning, multiplicative metadata, weights changing rankings, hypothesis-weighted replies, adversarial signs, normalized bounds, and realized rollout accumulation.
- Require focused Vitest commands plus `npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge`; document the current baseline of 44 focused tests passing and bridge typecheck failing on duplicate `toId` exports.
- Include exact in-scope/out-of-scope files, expected outputs, drift checks, maintenance notes, and STOP conditions. No UI redesign, new battle mechanics model, new dependency, doubles, or hidden-species invention.