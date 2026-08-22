# PokeRedus

Random Battle decision engine plus a knowledge-graph team builder.

The live policy is a one-round official Showdown simulation plus PennyLane
QAOA, not a search tree or weighted heuristic. Each turn the bot
builds an immutable observation, updates opponent set beliefs from an empirical
Showdown Random Battle pool, simulates **one official Showdown round**, scores
legal actions with explicit CTA/CTS mathematics, then samples from a PennyLane
QAOA probability distribution. A classical softmax exists only as a benchmark
CLI mode. If the quantum process fails, no battle action is sent.

## Layout

| Path | Role |
| --- | --- |
| `packages/engine` | Observation, set beliefs, official Showdown one-round sim, CTA/CTS math |
| `packages/bridge` | Showdown protocol tracker, async decide-and-act, dry-run |
| `packages/cli` | `export-pack`, `generate-pool`, `score`, `live` |
| `packages/core` | Knowledge graph, pairwise matchups, attribute views |
| `packages/calc` | Damage calculator used by the KG |
| `packages/web` | Team builder + matchup graph UI (no simulator) |
| `packages/pack` | Knowledge-pack schema/load |
| `quantum-policy` | Persistent PennyLane QAOA JSON-lines subprocess |
| `pokeredus/` | Python KG / team-builder GUI (visualization only) |
| `tools/pr.py` | Arrow-key launcher and one-liner commands |

Graph-only role/coverage weights in the team builder are visualization, not
battle policy. Pokémon physical `weight` (mass) is a species field, not a
policy weight.

**PokeLink** is the Showdown battle CLI (`packages/cli`). **PokeRedus** is the
team-builder GUI / web UI and knowledge-graph pipeline.

## Terminal launcher

Arrow-key menu for setup, PokeRedus, PokeLink, combined launch, training,
quantum, maintain, and settings:

```bash
python tools/pr.py
```

Keys: `↑` `↓` move · Enter run · Esc / Backspace back · `q` quit.

Saved options (policy, dry-run, Showdown account, decision log, QAOA seed/shots)
live in `tools/launch-settings.json` (gitignored). Env overrides:
`POKELINK_USER`, `POKELINK_PASS`, `POKELINK_URL`, `POKEREDUS_POLICY`.

### Simple commands

Battle id is a Showdown room (`gen9randombattle-…` or `battle-gen9randombattle-…`).
Default live mode is dry-run; pass `--send` to actually choose moves.

```bash
python tools/pr.py setup
python tools/pr.py gui
python tools/pr.py web
python tools/pr.py pokelink <battle-id>
python tools/pr.py live <battle-id>
python tools/pr.py combined <battle-id>
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
npm run gui
npm run web
npm run pokelink -- <battle-id>
npm run live -- <battle-id> --send
npm run combined -- <battle-id>
npm run train
```

| Command | Purpose |
| --- | --- |
| `setup` | `npm install` + `pip install -e pokeredus[dev]` + `pip install -e quantum-policy` |
| `gui` | Python team-builder (`pokeredus/scripts/launch.py`) |
| `web` | Vite team-builder UI |
| `pokelink` / `live` | Join a Showdown battle with the quantum (or settings) policy |
| `combined` | GUI + web; with a battle id, also start PokeLink live |
| `quantum` / `softmax` | Live battle forcing QAOA or the softmax benchmark |
| `train` | Generate Random Battle pool + export pack + rebuild matchup graph |
| `pool` / `pack` / `graph` | Standalone model/data updates |
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

For each Pokémon, `h = hp/maxHp`, `L` is the alive flag, and `M` is the mean of
`log(effect multiplier) × expected remaining turns` over active modifiers.

```
value      = L × clamp(h + 0.5×tanh(M), 0, 1)
stateScore = Σ value(ours) − Σ value(theirs)     ∈ [-6, +6]
CTA(move)  = P(executes) × P(hit | executed) × alive-at-execution   ∈ [0, 1]
CTS(switch)= sigmoid((stateScore(after switch) − stateScore(stay)) / max(|stay|, ε))
             forced switches have CTS = 1
impact     = Σ_revealed (Δhealth + Δmodifier × expectedValueTurns)  (our perspective)
choiceScore(c) = success(c) × E[impact]
roundScore = uniform mean of simulated post-round stateScore over our legal choices
```

`forcedOutcome` is `win | loss | none`. For the next round only, forced-win
probability is `max_our_choice min_opponent_reply P(opponent terminal)`; forced
loss is defined symmetrically. Signed `log1p` is used only when scaling scores
for the policy / learning log; raw values stay in the output.

The official `pokemon-showdown` simulator is the rules engine for speed,
priority, Trick Room, switches, accuracy, healing, status, boosts, field
effects, and chance branches. Battles are cloned with `Battle.toJSON` /
`Battle.fromJSON` for counterfactual branches.

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
npx tsx packages/cli/src/cli.ts generate-pool --samples 200 --seed 1 --out packages/engine/data/gen9randombattle-pool.v1.json
npx tsx packages/cli/src/cli.ts score --replay packages/cli/tests/fixtures/transcript.txt --pool packages/engine/data/gen9randombattle-pool.v1.json --policy softmax --dry-run
npx tsx packages/cli/src/cli.ts live --battle <roomid> --policy quantum --dry-run --decision-log decisions.jsonl
```

`--dry-run` logs the sampled choice and never sends it. The launcher default is dry-run; `--send` turns that off.

## Decision log

Append-only JSONL. Each line has observation features, set-belief
probabilities, raw and scaled scores, policy probabilities, the sampled
action, and optional `nextRoundOutcome`. This is the learning boundary;
this change does not train weights.

## Knowledge graph / team builder

```bash
python tools/pr.py gui
python tools/pr.py web
python tools/pr.py graph
```

Or by hand: `python pokeredus/scripts/launch.py` and `npm --workspace @pokeredus/web run dev`.

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
cd pokeredus && pytest tests/test_matchup_graph_8attr.py tests/test_matchup_graph_view.py tests/test_attribute_engine.py tests/test_phase5.py
```
