# PokeRedus

Random Battle decision engine plus a knowledge-graph team builder.

The live policy is a one-round official Showdown simulation plus PennyLane
QAOA, not a search tree or weighted heuristic. Each turn the bot builds an
immutable observation, updates opponent set beliefs, simulates **one official
Showdown round** for every legal action pair under each set hypothesis, scores
pairs with CTA/CTS times a weighted actor-local feature vector, then transforms
each side separately with QAOA. Opponent replies use the negative of our pair
delta. Scenario reordering can update persisted score weights. A background
forecast (opt-in `--forecast`) rolls out realized pair deltas until all-six
elimination or an unknown hidden-team frontier. Softmax is a benchmark CLI
mode only. If the quantum process fails, no battle action is sent.

Scoring contracts and “do not reopen” notes live in [plans/README.md](plans/README.md).

## Layout

| Path | Role |
| --- | --- |
| `packages/engine` | Observation, set beliefs, Showdown one-round sim, CTA/CTS math |
| `packages/bridge` | Showdown protocol tracker, async decide-and-act, dry-run |
| `packages/cli` | `export-pack`, `score`, `live` |
| `packages/core` | Knowledge graph, pairwise matchups, attribute views |
| `packages/calc` | Damage calculator used by the KG |
| `packages/web` | Team builder, matchup graph, Games (detect / attach) |
| `packages/pack` | Knowledge-pack schema/load |
| `quantum-policy` | Persistent PennyLane QAOA JSON-lines subprocess |
| `pokeredus/` | Python knowledge-graph pipeline |
| `tools/pr.py` | Arrow-key launcher |

Graph-only role/coverage weights in the team builder are visualization, not
battle policy. Pokémon physical `weight` (mass) is a species field, not a
policy weight.

**PokeLink** is the Showdown battle CLI plus the Games page. **PokeRedus** is
the web team-builder and KG pipeline. Attach opens `/games/live`: cumulative
score, win forecast, 6v6 benches, ranked choices.

## Terminal launcher

```bash
python tools/pr.py
```

Keys: `↑` `↓` move · Enter run · Esc / Backspace back · `q` quit.

Saved options live in `tools/launch-settings.json` (gitignored). Env:
`POKELINK_USER`, `POKELINK_PASS`, `POKELINK_URL`, `POKEREDUS_POLICY`,
`POKELINK_STATE` (HUD snapshot, default `live-state.json`).

Battle id is a Showdown room (`gen9randombattle-…` or `battle-gen9randombattle-…`).
Default live mode is dry-run; pass `--send` to actually choose. `pokelink` /
`live` / `quantum` / `softmax` start the web UI alongside the battle. You can
skip the battle id and detect/attach from **Games** after `python tools/pr.py web`.

```bash
python tools/pr.py setup
python tools/pr.py web
python tools/pr.py pokelink <battle-id>
python tools/pr.py live <battle-id>
python tools/pr.py quantum <battle-id>
python tools/pr.py softmax <battle-id>
python tools/pr.py train
python tools/pr.py settings
python tools/pr.py settings policy=quantum dry_run=true
```

npm: `npm run menu|setup|web|train` and `npm run pokelink -- <battle-id>`,
`npm run live -- <battle-id> --send`.

| Command | Purpose |
| --- | --- |
| `setup` | `npm install` + `pip install -e pokeredus[dev]` + `pip install -e quantum-policy` |
| `web` | Vite (team builder + Games) |
| `pokelink` / `live` | Web UI + Showdown live |
| `quantum` / `softmax` | Force QAOA or the softmax benchmark |
| `train` | Export pack + rebuild matchup graph |
| `score` | Replay a transcript into the decision log |
| `quantum-test` | `python -m unittest discover -s quantum-policy/tests` |
| `test` | npm test + typecheck + build + pytest + quantum tests |
| `settings` | Print or set launcher options (`key=value`) |

`setup` also accepts `node`, `python`, or `quantum` to install one stack.

## Random Battle assumptions

- Our six sets are known.
- Each revealed opponent starts at the most frequent compatible set, then
  hypotheses filter as moves/item/ability/level/Tera are revealed.
- An empty candidate set fails visibly; the bot does not invent a set.
- Unrevealed slots are neutral placeholders so early scores are not falsely
  favorable. A rollout that needs a hidden species stops at `unknown-frontier`.

Generate the pool: `python tools/pr.py pool`.

## Scoring

Our perspective unless a row is actor-local. Positive favors that actor.
Chance branches average only inside a `(hypothesis, our action, opponent
action)` cell. Residuals (Leftovers, weather chip) are unattributed and
excluded from selected-action score. `hitsToKill` is a UI diagnostic.

```
health(side)      = Σ clamp(HP/maxHP, 0, 1)
logModifier(slot) = Σ ln(multiplier) × probability × expectedTurns
modifier(slot)    = 0.5 × tanh(logModifier)
actorHealth       = ((Δactor − Δfoe) / 6) ∈ [-1, +1]
actorModifier     = ((Δactor − Δfoe) / 6) ∈ [-1, +1]

conditionalValue  = clamp(w·features, -1, +1)
CTA(move)         = P(executes ∧ hits ∧ actor alive) ∈ [0, 1]
CTS(switch)       = P(legal switch completes); forced revenge = 1
actionScore       = CTA_or_CTS × E[conditionalValue | success]
D = PairScore     = clamp(ourActionScore − opponentActionScore, -1, +1)

P_ours starts uniform
opponentUtility(j|h) = Σ_i P_ours(i) × (−D(i,j,h))
P_theirs(j|h)        = T(legal replies under h, opponentUtility)
ourUtility(i)        = Σ_h P(h) × Σ_j P_theirs(j|h) × D(i,j,h)
P_ours(i)            = T(our actions, ourUtility)
roundScore           = Σ_i P_ours(i) × ourUtility(i)   ∈ [-1, +1]
```

Two iterations default. Every legal our action stays in the distribution.
Display opponent probabilities are the belief-weighted mix and sum to one.
`availability` is hyp mass where that reply is legal — not policy mass.

`ChoiceEvaluation.choiceScore` / `ReplyEvaluation.choiceScore` are actor-local
`actionScore` values used by Scenario reordering. `expectedUtility` is `E[D]`
(ours) or `E[-D]` (replies). Forecasts accumulate `scoreRealizedPair` deltas,
not `choiceScore`. Terminal utility is `+1`/`-1` only for all-six KO.

CTA/CTS come from represented branch mass. Do not average failure branches and
then multiply by CTA again. Independent modifiers add in log space. Health and
modifier stay separate in policy features so setup at full HP still has value.

Showdown owns mechanics. `pokeredus/data/effects/*.json` may add optional
`valuation` (`multiplier`, `expectedTurns`, `probabilityOverride`); absent is
neutral. `policyWeight` is QAOA mass. `winRate` is `wins/(wins+losses)` among
terminal samples, with a 95% Wilson interval; absent when there are no
terminals, never zero-filled from frontiers/caps.

## Quantum policy

```bash
python tools/pr.py setup quantum
python tools/pr.py quantum-test
```

Node talks to `python -m pokeredus_quantum` over JSON lines:

```json
{"actions":["move:earthquake","switch:2"],"scores":[0.4,-0.1],"mode":"quantum"}
{"probabilities":[0.72,0.28],"diagnostics":{"mode":"quantum","n_qubits":1}}
```

`--policy softmax` is an explicit benchmark. Quantum is the live default.

## CLI

```bash
npx tsx packages/cli/src/cli.ts live --battle <roomid> --policy quantum --dry-run --decision-log decisions.jsonl --live-state live-state.json
```

`--dry-run` logs and never sends (launcher default). `--send` turns that off.
`--forecast` starts a second QAOA process for background terminal rollouts; it
is opt-in because a full stratified cycle currently exceeds the default 10s
budget. The sent action never waits on it.

The live CLI overwrites `live-state.json` (or `$POKELINK_STATE`). Open **Games**
→ **Attach** for the theater. **Connect & detect** lists battles on your
Showdown account. Games talks to Showdown from the Vite server; no browser
websocket.

Decision log is append-only JSONL (observation, beliefs, scores, sampled
action, optional `nextRoundOutcome`). It is the learning boundary; this does
not train weights.

## Knowledge graph / team builder

```bash
python tools/pr.py web
python tools/pr.py graph
```

Attribute formula inputs live in `pokeredus/data/config/`.

## Limitations

- Singles Random Battles only.
- One-round lookahead for the sent action; background forecasts roll out until
  all-six KO, an unknown frontier, or a safety cap.
- Chance branches are a small seeded sample, not a full damage-roll enumeration.
- Finite-shot QAOA is optional; exact `default.qubit` is the correctness default.
- Forecasting may stay partial if QAOA is slow.

## Verification

```bash
python tools/pr.py test
python tools/pr.py --self-check
```

Or: `npm test && npm run typecheck && npm run build`, then
`python -m unittest discover -s quantum-policy/tests` and
`cd pokeredus && pytest tests/test_matchup_graph_8attr.py tests/test_matchup_graph_view.py tests/test_attribute_engine.py tests/test_phase5.py tests/test_game_state.py`.
