# 001 — PokeLink full-page battle theater

**Status:** DONE  
**Commit:** `1ac76f2`  
**Effort:** M  
**Risk:** Low–medium (live `choiceScore` will start counting pre-sim modifiers; HUD-only otherwise)

## Why

Games ([packages/web/src/pages/Games.tsx](packages/web/src/pages/Games.tsx)) keeps detect/attach and the live HUD on one page. `EvalBlock` prints CTA/CTS. `slotsFromObservation` drops unrevealed mons. `LiveState.field` only has weather/terrain/trickroom. After Attach (or when `live-state.json` is already live from the CLI), open a dedicated full-viewport route that is a data dashboard: scores and bars only.

## Current state

```109:120:packages/bridge/src/live-state.ts
export function slotsFromObservation(obs: BattleObservation, side: 'ours' | 'theirs'): LiveSlot[] {
  return obs[side]
    .filter((s) => s.revealed || s.active)
    .map((s) => ({
      speciesId: s.speciesId,
      hp: s.hp,
      maxHp: s.maxHp || 100,
      status: s.status,
      fainted: s.fainted,
      active: s.active,
      revealed: s.revealed,
    }));
}
```

`toObservation` writes `modifiers: []`, so `M` is 0 before sim. `evaluateRound` already loops hypothesized opponent replies but only emits our `ChoiceEvaluation`.

## Contract

Widen types in [packages/bridge/src/live-state.ts](packages/bridge/src/live-state.ts) and [packages/web/src/lib/games.ts](packages/web/src/lib/games.ts).

- `LiveSlot`: pad/truncate to 6; add `boosts` + `modifiers`. Unrevealed slots stay in the array; UI hides identity.
- `LiveState.field`: weather, terrain, trickroom, plus `ours`/`theirs` hazards/screens. Map p1/p2 using `ourSide` — UI never sees raw p1/p2.
- Our choices: `choiceScore`, `expectedImpact`, `expectedHealthDelta`, `expectedModifierDelta`, `hitsToKill` (nullable), `probability`. Do not display `cta`/`cts`.
- `LiveEval.replies`: opponent hypothesized actions with `expectedImpact` (our perspective) and `hitsToKillUs`.
- `LiveEval.quantum`: `{ mode, nQubits?, shots?, exact? }` from policy diagnostics.
- `LiveState.turns`: append `{ turn, roundScore, sampledAction }` on each decision, cap 16.

Hits-to-kill: from weighted expected HP fraction on the **same slot index** as the pre-sim active — `ceil(hBefore / max(eps, hBefore - hAfter))`; `null` if no damage. Do not call `@pokeredus/calc`.

## Ranking and bars

- Ours: sort by `choiceScore` descending. Sampled row marked green.
- Theirs: sort by `expectedImpact` ascending (worst for us first).
- Overall: bipolar bar, domain `[-6, +6]`.
- Per choice: signed bar; our rows get a second thinner quantum-p bar.
- ΔM / HKO: compact meta (`OHKO`/`2HKO`/`3HKO` only when 1–3, else `—`).
- Turn history: one vertical bar per `turns[]` entry.

## Routing

- `/games/live` renders **without** the sidebar.
- After `attachGame`, `navigate('/games/live')`.
- Lobby shows **Open battle** when attached or live status is not idle.
- Theater polls `/api/live` every 250ms and works if the CLI was launched from the terminal (`snap.attached` may be null).

## Steps

1. `impactParts` in [packages/engine/src/math.ts](packages/engine/src/math.ts); `impact()` returns `.total`.
2. Fill `modifiersFromSlot` in `toObservation` and live-state slot mapping.
3. In `evaluateRound`, reuse the existing hyp×reply×seed loop — no extra `simulateRound`. Emit parts, `hitsToKill`, `replies[]`.
4. Pass `diagnostics` on `DecideResult`; `fromDecision` copies quantum, choices, replies, turns.
5. Pad slots to 6; invert the “drops unrevealed” test.
6. New [packages/web/src/pages/BattleLive.tsx](packages/web/src/pages/BattleLive.tsx); strip HUD from Games; neon CSS only (no Tailwind).

## Out of scope

Tailwind, new deps, websocket HUD, QAOA math changes, doubles, click-to-send moves, printing CTA/CTS in the theater, removing the debug ingest fetch in `protocol.ts`.

## Tests

1. `impactParts` split; `impact() === total`.
2. `evaluateRound` fixture: replies nonempty; damaging move can yield finite `hitsToKill`; `choiceScore === success * expectedImpact`.
3. Live snapshot: 6+6 slots, unrevealed kept, field hazards present, `turns` grows, `quantum.mode` set.
4. `npm run typecheck --workspace @pokeredus/web`.

## Verification

```
npx vitest run packages/engine/tests/math.test.ts packages/engine/tests/integration.test.ts
npx vitest run packages/cli/tests/live-state.test.ts
npm run typecheck --workspace @pokeredus/engine --workspace @pokeredus/bridge --workspace @pokeredus/cli --workspace @pokeredus/web
```

Browser: Attach → theater → Back → Open battle → Detach; empty state; 375 and 1440 widths.

## Escape hatches

- Replies must not add a new sim loop.
- If HKO is nonsense, ship `null` / `—` rather than calc.
- Softmax diagnostics may only have `mode` — skip qubit badges.
- If HEAD drifted from `1ac76f2`, re-read `live-state.ts` / `Games.tsx` first.

## Maintenance

New HUD fields go on `LiveState`. Reject CTA/CTS returning to the theater, filtering unrevealed slots, and Tailwind.
