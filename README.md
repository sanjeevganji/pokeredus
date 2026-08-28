# PokeRedus

Random Battle decision engine plus a knowledge-graph team builder.

The live policy is a one-round official Showdown simulation plus PennyLane
QAOA, not a search tree or weighted heuristic. Each turn the bot
builds an immutable observation, updates opponent set beliefs from imported
Random Battle set data, simulates **one official Showdown round** for every
legal action pair under each set hypothesis, scores pairs with CTA/CTS times a
weighted actor-local feature vector (health, modifier, field, switch-risk,
sacrifice), then transforms each side separately with PennyLane QAOA.
Opponent replies are weighted from the negative of our pair delta. Scenario
reordering can update the persisted score weights. A classical softmax exists
only as a benchmark CLI mode. If the quantum process fails, no battle action
is sent.

## Layout

| Path | Role |
| --- | --- |
| `packages/engine` | Observation, set beliefs, official Showdown one-round sim, CTA/CTS math |
| `packages/bridge` | Showdown protocol tracker, async decide-and-act, dry-run |
| `packages/cli` | `export-pack`, `score`, `live` |
| `packages/core` | Knowledge graph, pairwise matchups, attribute views |
| `packages/calc` | Damage calculator used by the KG |
| `packages/web` | Team builder, matchup graph, and Games (detect / attach Showdown battles) |
| `packages/pack` | Knowledge-pack schema/load |
| `quantum-policy` | Persistent PennyLane QAOA JSON-lines subprocess |
| `pokeredus/` | Python knowledge-graph pipeline (matchup graph, tests) |
| `tools/pr.py` | Arrow-key launcher and one-liner commands |

Graph-only role/coverage weights in the team builder are visualization, not
battle policy. Pokémon physical `weight` (mass) is a species field, not a
policy weight.

**PokeLink** is the Showdown battle CLI (`packages/cli`) plus the Games page
in the web UI. **PokeRedus** is the web team-builder and knowledge-graph
pipeline. Open the web UI and use **Games** to detect battles on your Showdown
account and attach the live engine. Attach opens `/games/live`, a full-page
theater for cumulative battle score, win forecast, 6v6 benches, and ranked
choices.

## Terminal launcher

Arrow-key menu for setup, PokeRedus, PokeLink tools, training, quantum,
maintain, and settings:

```bash
python tools/pr.py
```

Keys: `↑` `↓` move · Enter run · Esc / Backspace back · `q` quit.

Saved options (policy, dry-run, Showdown account, decision log, QAOA seed/shots)
live in `tools/launch-settings.json` (gitignored). Env overrides:
`POKELINK_USER`, `POKELINK_PASS`, `POKELINK_URL`, `POKEREDUS_POLICY`,
`POKELINK_STATE` (HUD snapshot path, default `live-state.json` at repo root).

### Simple commands

Battle id is a Showdown room (`gen9randombattle-…` or `battle-gen9randombattle-…`).
Default live mode is dry-run; pass `--send` to actually choose moves.
`pokelink` / `live` / `quantum` / `softmax` start the web UI alongside the
battle so the Games page can follow eval scores and live updates. You can also
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

npm equivalents (from repo root):

```bash
npm run menu
npm run setup
npm run web
npm run pokelink -- <battle-id>
npm run live -- <battle-id> --send
npm run train
```

| Command | Purpose |
| --- | --- |
| `setup` | `npm install` + `pip install -e pokeredus[dev]` + `pip install -e quantum-policy` |
| `web` | Vite web UI (team builder + Games) |
| `pokelink` / `live` | Web UI + Showdown live (quantum or settings policy) |
| `quantum` / `softmax` | Live forcing QAOA or the softmax benchmark |
| `train` | Export knowledge pack + rebuild matchup graph |
| `pack` / `graph` | Standalone pack and graph updates |
| `score` | Replay a transcript into the decision log |
| `quantum-test` | `python -m unittest discover -s quantum-policy/tests` |
| `test` | npm test + typecheck + build + pytest + quantum tests |
| `settings` | Print or set launcher options (`key=value`) |

`setup` also accepts `node`, `python`, or `quantum` to install one stack.

## Random Battle assumptions

- Our six sets are known.
- Each revealed opponent starts at the most frequent compatible set in the
  empirical `gen9randombattle` pool, then hypotheses are filtered and
  renormalized as moves, item, ability, level, and Tera are revealed.
- An empty candidate set fails visibly; the bot does not invent a set.
- Unrevealed opponent slots are neutral full-health placeholders so early
  scores are not falsely favorable.

Generate the pool from the official generator:

```bash
python tools/pr.py pool
```

## Formulas

Scores use our perspective unless a row is explicitly actor-local. Positive is
favorable to that actor. Each simulated branch attributes effects to the
submitted action that caused them. Recoil and drain may affect both sides.
Residuals (Leftovers, weather chip, status damage) are unattributed and
excluded from selected-action score.

```
health(side)        = Σ clamp(currentHP / maxHP, 0, 1)
logModifier(slot)   = Σ ln(multiplier) × probability × expectedTurns
modifier(slot)      = 0.5 × tanh(logModifier(slot))
modifier(side)      = Σ modifier(living slots)

actorHealthFeature     = ((Δhealth(actor) − Δhealth(foe)) / 6)   ∈ [-1, +1]
actorModifierFeature   = ((Δmodifier(actor) − Δmodifier(foe)) / 6) ∈ [-1, +1]
secondaryFeature       = actor-local hazards/screens/weather/terrain ∈ [-1, +1]
switchRisk, sacrifice  = actor-local, in [0, 1]

conditionalValue    = clamp(
                        healthWeight × health
                      + modifierWeight × modifier
                      + secondaryWeight × secondary
                      + sacrificeWeight × sacrifice
                      − switchRiskWeight × switchRisk,
                      -1, +1)

CTA(move)           = P(executes ∧ hit/succeeds ∧ actor alive at resolution)  ∈ [0, 1]
moveScore           = CTA × E[conditionalValue | successful move]

CTS(switch)         = P(legal switch completes); forced legal revenge switch = 1
switchScore         = CTS × E[conditionalValue | completed switch]

PairScore.score     = clamp(ourActionScore − opponentActionScore, -1, +1)
```

Each turn the engine scores every legal our action against every legal
opponent reply under each active-set hypothesis. Chance branches average only
inside a specific `(hypothesis, our action, opponent action)` cell. Belief
mass `P(h)` is applied afterward.

Opponent policy uses **our** pair delta with the sign flipped once (`-D`).
Both sides use the same transform `T` (QAOA live; softmax only as an explicit
benchmark):

```
P_ours starts uniform
opponentUtility(j|h) = Σ_i P_ours(i) × (−D(i,j,h))
P_theirs(j|h)        = T(legal replies under h, opponentUtility)
ourUtility(i)        = Σ_h P(h) × Σ_j P_theirs(j|h) × D(i,j,h)
P_ours(i)            = T(our actions, ourUtility)
roundScore           = Σ_i P_ours(i) × ourUtility(i)   ∈ [-1, +1]
```

Two iterations is the default. Every legal our action stays in the
distribution; there is no 32-pair joint cap. Display opponent probabilities
are the belief-weighted mix of the conditional policies and sum to one.
`availability` is the hypothesis mass where that reply is legal; it is not
policy mass or confidence.

`ChoiceEvaluation.expectedUtility` is the final `E[D]`.
`ReplyEvaluation.expectedUtility` is opponent-perspective `E[-D]`.
`choiceScore` on both rows remains the actor-local value used by Scenario
reordering. A compatible manual set override is the simulation assumption
with mass one; public hypotheses stay on the observation for display.

CTA and CTS are computed from represented branch mass, not editable
coefficients. Failure/no-op branches contribute zero successful mass; do not
average them in and then multiply by CTA again. Independent modifiers add in
log space; a `1×` term does not dilute another effect. Health and modifier
stay separate, so setup at full HP still has value.

`hitsToKill` and raw HP parts are display diagnostics. They do not feed the
normalized score. `expectedImpact` is the unweighted sum of health, modifier,
and secondary features. Signed `log1p` is used only when scaling scores for
the policy / display.

`ChoiceEvaluation.choiceScore` is our actor-local `moveScore`/`switchScore`.
`ReplyEvaluation.choiceScore` is the opponent's actor-local score from the
same scorer (opponent passed as actor). Scenario reordering updates
`score-weights.json` with bounded elastic updates; reset restores defaults.

Showdown remains authoritative for mechanics, legality, accuracy, and actual
HP/status/field transitions. `pokeredus/data/effects/*.json` may add an
optional `valuation` object for future multiplier/turns/probability; absent
entries are neutral.

`forcedOutcome` is `win | loss | none`. `policyWeight` is QAOA output mass
used for ranking and sampling, not confidence or a win probability. `winRate`
is an empirical terminal-rollout frequency with a 95% Wilson interval.

The official `pokemon-showdown` simulator is the rules engine for speed,
priority, Trick Room, switches, accuracy, healing, status, boosts, field
effects, and chance branches. Battles are cloned with `Battle.toJSON` /
`Battle.fromJSON` for counterfactual branches. The observed weather,
terrain, Trick Room, hazards, and screens are restored through Showdown
field APIs before each counterfactual round.

## Quantum policy

```bash
python tools/pr.py setup quantum
python tools/pr.py quantum-test
```

Or by hand:

```bash
pip install -e quantum-policy
python -m unittest discover -s quantum-policy/tests
```

Node talks to `python -m pokeredus_quantum` over JSON lines:

```json
{"actions":["move:earthquake","switch:2"],"scores":[0.4,-0.1],"mode":"quantum"}
```

```json
{"probabilities":[0.72,0.28],"diagnostics":{"mode":"quantum","n_qubits":1}}
```

`--policy softmax` is an explicit benchmark. Quantum is the live default.

## CLI

PokeLink one-liners (battle id required for live):

```bash
python tools/pr.py pokelink <battle-id>
python tools/pr.py pokelink <battle-id> --send
python tools/pr.py score
python tools/pr.py pack --mini
```

Underlying `packages/cli` (same flags as before):

```bash
npx tsx packages/cli/src/cli.ts render-pack --pack pokeredus/data/knowledge-pack/knowledge-pack-mini.json
npx tsx packages/cli/src/cli.ts export-pack --mini
npx tsx packages/cli/src/cli.ts score --replay packages/cli/tests/fixtures/transcript.txt --policy softmax --dry-run
npx tsx packages/cli/src/cli.ts live --battle <roomid> --policy quantum --dry-run --decision-log decisions.jsonl --live-state live-state.json
```

`--dry-run` logs the sampled choice and never sends it. The launcher default is dry-run; `--send` turns that off.

The live CLI overwrites `live-state.json` (or `$POKELINK_STATE`) each event and
decision. Open **Games** in the web UI, then **Attach** (or **Open battle**) to
reach `/games/live` for cumulative battle score, a live forecast graph,
ranked choice rows (QAOA policy weight, expected TTK, win intervals),
6v6 HP, and field badges. Use **Connect & detect** to list battles on
your Showdown account.

## Decision log

Append-only JSONL. Each line has observation features, set-belief
probabilities, raw and scaled scores, policy probabilities, the sampled
action, and optional `nextRoundOutcome`. This is the learning boundary;
this change does not train weights.

## Knowledge graph / team builder

```bash
python tools/pr.py web
python tools/pr.py graph
```

The web UI has Pokémon Browser, Team Builder, Matchup Graph, and Games
(detect / attach Showdown battles). Games talks to Showdown from the Vite
dev server; it does not put a websocket in the browser.

Or by hand: `npm --workspace @pokeredus/web run dev`.

Attribute formula inputs live in `pokeredus/data/config/` (`attribute_formulas.yaml`,
`team_radial_formulas.json`, `radar_config.json`).

## Limitations

- Singles Random Battles only.
- One-round lookahead; no deeper search.
- Chance branches are a small seeded sample, not a full damage-roll enumeration.
- Finite-shot QAOA is optional; exact `default.qubit` is the correctness default.

## Verification

```bash
python tools/pr.py test
python tools/pr.py --self-check
```

Or by hand:

```bash
npm test && npm run typecheck && npm run build
python -m unittest discover -s quantum-policy/tests
cd pokeredus && pytest tests/test_matchup_graph_8attr.py tests/test_matchup_graph_view.py tests/test_attribute_engine.py tests/test_phase5.py tests/test_game_state.py
```
