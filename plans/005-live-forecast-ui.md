# 005 — Incremental score graph and interpretable live choices

**Status:** DONE  
**Commit:** `a400fd1`  
**Effort:** L  
**Risk:** Medium — additive live JSON migration plus dense dashboard UI  
**Depends on:** 002, 003, 004

## Why

The live theater already has a custom SVG line chart and compact choice rows, so this is an evolution rather than a redesign. Current graph points are independent `roundScore` values:

```ts
export interface LiveTurn {
  turn: number;
  roundScore: number;
  sampledAction: string;
}
```

The chart silently clamps each value to `[-6,+6]`, spaces points by array index without an action axis, and exposes exact values only through SVG `<title>`:

```ts
const yAt = (s: number) => t + ((6 - Math.max(-6, Math.min(6, s))) / 12) * innerH;
const xAt = (i: number) => (pts.length <= 1 ? l + innerW / 2 : l + (i / (pts.length - 1)) * innerW);
```

Choice rows label QAOA sampling mass as probability/confidence-adjacent UI, while terminal rollout intervals do not exist in the live contract. The result must make model meaning obvious without adding chart or design dependencies.

## UX contract

### Primary values

Show three values above the theater body:

1. **Battle score** — the settled cumulative score since attach, signed and shown to two decimals.
2. **This action** — sampled action expected delta and observed min/max branch range.
3. **Win forecast** — empirical rollout win rate with 95% interval and sample count.

Use `—` plus a short status (`Waiting for first decision`, `Forecasting`, `Incomplete sets`, or `Forecast unavailable`) instead of substituting zero for missing data.

### Terminology

- `QAOA policy weight` — circuit output mass used for ranking/sampling.
- `Win forecast` — empirical terminal rollout frequency.
- `95% interval` — Wilson interval from rollout samples.
- `Pool frequency` — public candidate frequency for an assumed set.
- `Expected`, `best observed`, `worst observed` — chance/rollout sample statistics.

Never use `quantum probability`, `quantum confidence`, `guaranteed best`, or `known set` for assumptions.

### Graph

Use the existing SVG and CSS. Render:

- settled cumulative score as the primary line;
- expected next total as a second line from the latest settled point;
- min/max totals as two thin lines with a muted filled envelope;
- a zero baseline;
- sparse x labels using decision sequence and turn/action kind;
- markers for switch, Tera, and faint events when those facts are available;
- a visible latest-value summary and legend;
- a screen-reader list of every point and range.

Use a dynamic symmetric Y-domain:

```text
maxAbs = max(1, ceil(max(abs(all visible values)) × 1.1))
domain = [-maxAbs, +maxAbs]
```

Do not clip without a visible cue. X spacing follows decision sequence because a turn can contain a move request and a forced switch request. Display the Showdown turn number beneath the point.

Do not invent Opening/Midgame/Endgame boundaries. If a future source supplies explicit phases, the graph may render them; alive-count thresholds are not part of this plan.

## Live data contract

Replace `LiveTurn` with an additive, versioned point in [`packages/bridge/src/live-state.ts`](packages/bridge/src/live-state.ts):

```ts
export interface LiveScorePoint {
  sequence: number;
  turn: number;
  actionId: string;
  actionKind: 'move' | 'switch';
  tera: boolean;
  status: 'forecast' | 'settled' | 'unresolved';
  expectedDelta: number;
  minDelta: number;
  maxDelta: number;
  realizedDelta?: number;
  cumulativeTotal: number;
  expectedTotal: number;
  minTotal: number;
  maxTotal: number;
  samples: number;
}
```

Add to `LiveEval`:

```ts
forecast?: BattleForecast;
scoreWeights: ScoreWeights;
quantum?: {
  mode: string;
  nQubits?: number;
  shots?: number;
  exact?: boolean;
  params?: number[];
  cost?: number;
};
```

Add to each `LiveChoice`/`LiveReply`:

- plan 002 mean/min/max/sample fields;
- plan 004 `ChoiceForecast` fields where available;
- `policyWeight` as the replacement name for ambiguous `probability`;
- `hamiltonianInput` (scaled) and raw terminal utility when available.

Write `schemaVersion: 2` on `LiveState`.

### Compatibility

At the web read boundary in [`packages/web/src/lib/games.ts`](packages/web/src/lib/games.ts), convert old `turns[]` entries into unresolved compatibility points:

- cumulative total is the old `roundScore` only for that compatibility display;
- expected/min/max all equal the old value;
- status is `unresolved`;
- label the series `Legacy round score`; do not present it as cumulative.

The bridge writer only emits version 2 after migration. Remove compatibility after one documented release, not in the same change.

## Settling score points

In [`packages/bridge/src/live-state.ts`](packages/bridge/src/live-state.ts):

1. On `fromDecision`, find the sampled choice and append a `forecast` point:
   - base is the latest settled `cumulativeTotal`, or 0 at attach;
   - expected/min/max deltas come from plan 002;
   - expected/min/max totals are base plus those deltas;
   - `samples` is the represented branch count.
2. On the next observation/request, settle the prior point with the realized action score produced by plan 002's shared telemetry/scoring boundary.
3. Set `cumulativeTotal = prior settled total + realizedDelta`.
4. If actual action attribution is unavailable (dry-run user chose another move, disconnect, incomplete protocol), mark `unresolved`; do not copy expected delta into realized delta.
5. A forced switch request creates its own point. Do not add another point merely because the 250ms poll read the same snapshot.
6. Keep at least 64 points or the full current battle, whichever is smaller; 16 is insufficient for a normal game.

Forecast progress from plan 004 updates `LiveEval.forecast` and choice forecast fields for the matching turn only. Ignore stale turn IDs.

## Implementation steps

### 1. Widen the typed chain once

Update in this order:

1. engine exports from plans 002/004;
2. bridge `Live*` interfaces and writer mapping;
3. [`packages/web/src/lib/games.ts`](packages/web/src/lib/games.ts) mirrors and compatibility normalization;
4. [`packages/web/src/pages/BattleLive.tsx`](packages/web/src/pages/BattleLive.tsx) consumers;
5. [`packages/web/src/lib/scenarios.ts`](packages/web/src/lib/scenarios.ts) and [`packages/web/src/pages/Scenarios.tsx`](packages/web/src/pages/Scenarios.tsx) only where shared evaluation names changed.

Do not introduce a third hand-written shape. Where package boundaries permit, import shared types instead of duplicating fields.

### 2. Rebuild `ScoreStrip` around semantic values

Keep one `<section>` with:

- the three primary values;
- the graph;
- a compact legend;
- a `<details>` block named `How this score is calculated`.

The disclosure shows:

- score weights with plain labels (`Damage/health`, `Modifiers`, and any plan-002 retained features);
- raw turn/terminal utility;
- logarithmically scaled Hamiltonian input;
- QAOA mode, qubits, exact/shots, parameters, and cost;
- rollout samples/capped count and assumptions status.

Do not put CTA/CTS acronyms in primary chrome. Tooltips/disclosure may spell them out.

### 3. Evolve `TurnGraph`

Refactor the current inline SVG only enough to support three series and the envelope.

Accessibility:

- `<figure>` with visible `<figcaption>`;
- SVG `<title>` and `<desc>` with current range;
- no exact value available only on hover;
- render a visually hidden ordered list such as `Turn 7, switch, total +1.20, expected +1.45, range +0.80 to +1.90`;
- use shape/dash differences as well as color;
- keep contrast at WCAG AA for text and focus indicators.

Rendering:

- preserve marker shape by avoiding `preserveAspectRatio="none"` distortion;
- use `vector-effect="non-scaling-stroke"` for all lines;
- render no envelope when sample count is zero;
- use a dashed expected line and solid settled line;
- animate updates for 150–250ms only when reduced motion is not requested.

### 4. Make choice rows decision-oriented

Continue showing the top three by default, with an accessible `Show all choices` disclosure when more legal actions exist. Never discard an action from data solely because it is not in the first three.

Each row shows:

- action label and raw expected turn score;
- min–max observed range;
- projected cumulative total;
- expected TTK (`OHKO`, `2 turns`, etc.; avoid `HKO` jargon);
- QAOA policy weight as a raw percentage;
- empirical win forecast and interval/sample count when available.

Highlight:

- `Recommended` on highest `expectedTerminalScore`;
- `Sampled` separately on the action selected by the live policy;
- Tera with an explicit once-per-game badge only on legal Tera action rows.

Do not maintain a local TERA mode that swaps in a separate unrefined list. Plans 002/004 put legal Tera variants in the same ranking.

Opponent rows show their policy weight when present and remain sorted from most harmful to us. The visual label must say `Opponent model weight`.

### 5. Apply logarithmic visual scaling honestly

Keep raw values in text and ARIA. For non-negative policy weights, use one documented display helper:

```ts
displayFraction(p) = log1p(9 * clamp(p, 0, 1)) / log(10)
```

This makes small weights visible without changing order. The meter's `aria-valuenow` remains raw `p`, not transformed width.

For signed score bars, continue using an origin-centered domain but calculate ARIA min/max from the same dynamic visual domain. Do not rescale health/modifier segments until their sum appears to equal a different composite score. Either:

- render actual scored feature contributions from plan 002; or
- render one net score segment and list raw parts in the disclosure.

Fix [`packages/web/src/components/ScoreBar.tsx`](packages/web/src/components/ScoreBar.tsx), where the visual domain can exceed ±1 but ARIA remains ±1.

### 6. Add the set discovery drawer

Render plan 003's drawer from the clicked revealed slot. Follow the interaction contract in plan 003 and keep it secondary to the score/choice dashboard.

The bench row must show:

- `Manual assumption`, `Public assumption`, `Revealed`, or `Incomplete`;
- Tera type when part of the assumed set;
- pool frequency only in the detail drawer.

### 7. Make polling quiet and race-safe

Replace the unconditional interval in [`packages/web/src/pages/BattleLive.tsx`](packages/web/src/pages/BattleLive.tsx) with the smallest reusable polling effect:

- one request in flight at a time;
- 250ms while visible and live;
- pause while `document.hidden`;
- resume immediately on visibility change;
- abort/ignore results after unmount;
- skip `setLive` when `ts` and schema version are unchanged.

Do not add websockets for this page.

### 8. Finish responsive and motion states

In [`packages/web/src/theme.css`](packages/web/src/theme.css):

- keep the existing neutral/neon dashboard palette;
- use an 8px spacing rhythm;
- use border or subtle background hierarchy, not additional card shadows;
- make primary metrics scan in one row at 1440px, two/one columns at 768/375px;
- make chart horizontally readable without tiny text;
- give all buttons 44px touch targets on mobile;
- add `prefers-reduced-motion` to disable shimmer/chart transitions;
- add visible focus states for graph controls, drawer fields, disclosures, and choice rows.

## Runnable check

Add one small test file for non-trivial display/data logic, for example:

```text
packages/web/src/lib/live-score.test.ts
```

Test:

- old snapshot compatibility mapping;
- cumulative point settlement and unresolved behavior;
- dynamic graph domain includes all mean/min/max values;
- log display fraction maps 0→0 and 1→1 and preserves order;
- recommended action uses expected terminal score, not policy weight;
- raw ARIA values differ from transformed visual widths where expected.

Do not add a UI test framework.

## Verification

```bash
npx vitest run packages/cli/tests/live-state.test.ts packages/web/src/lib/live-score.test.ts
npm run typecheck --workspace @pokeredus/bridge --workspace @pokeredus/cli --workspace @pokeredus/web
npm run build --workspace @pokeredus/web
```

Browser matrix:

1. 1440px: settled line, expected line, envelope, three primary values, top choices, and benches fit without overlap.
2. 768px: metrics wrap intentionally and both side columns remain readable.
3. 375px: one-column flow, 44px targets, drawer full width, no horizontal page overflow.
4. Keyboard: reach every action/disclosure, open/edit/close drawer, Escape returns focus.
5. Screen reader snapshot: graph description/list includes all visible point values and ranges; meters report raw domains.
6. Reduced motion: no shimmer or chart transition.
7. Hidden tab: network polling pauses; returning triggers one immediate request without a burst.
8. Legacy version-1 live JSON: renders `Legacy round score` without claiming cumulative data.

## Out of scope

- Tailwind, a chart library, websockets, or a component dependency.
- Sending a move by clicking a theater row.
- Invented game-phase labels.
- Treating QAOA mass as confidence or a win probability.
- Replacing Scenarios with the live theater.

## Escape hatches

- If realized action attribution is missing, mark the point unresolved and keep the settled line at its last valid value.
- If terminal forecasting misses plan 004's benchmark gate, render progressive sample counts/status; do not block or fake complete ranges.
- If all graph values are zero/missing, use a ±1 domain and an explicit waiting state.
- If imported snapshots have an unknown future schema version, show an incompatibility alert instead of coercing fields.

## Maintenance

The live JSON schema is the source of truth for display semantics. Reviewers should reject UI-derived confidence, silently clipped ranges, expected values copied into realized totals, transformed values used as ARIA values, or a return of the separate display-only Tera mode.
