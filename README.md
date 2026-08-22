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

Graph-only role/coverage weights in the team builder are visualization, not
battle policy. Pokémon physical `weight` (mass) is a species field, not a
policy weight.

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
npx tsx packages/cli/src/cli.ts generate-pool --samples 200 --seed 1 --out packages/engine/data/gen9randombattle-pool.v1.json
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

```bash
npx tsx packages/cli/src/cli.ts render-pack --pack pokeredus/data/knowledge-pack/knowledge-pack-mini.json
npx tsx packages/cli/src/cli.ts export-pack --mini
npx tsx packages/cli/src/cli.ts score --replay packages/cli/tests/fixtures/transcript.txt --pool packages/engine/data/gen9randombattle-pool.v1.json --policy softmax --dry-run
npx tsx packages/cli/src/cli.ts live --battle <roomid> --policy quantum --dry-run --decision-log decisions.jsonl
```

`--dry-run` logs the sampled choice and never sends it.

## Decision log

Append-only JSONL. Each line has observation features, set-belief
probabilities, raw and scaled scores, policy probabilities, the sampled
action, and optional `nextRoundOutcome`. This is the learning boundary;
this change does not train weights.

## Knowledge graph / team builder

Python GUI: `python pokeredus/scripts/launch.py`

Attribute formula inputs live in `pokeredus/data/config/` (`attribute_formulas.yaml`,
`team_radial_formulas.json`, `radar_config.json`).

Web UI: `npm --workspace @pokeredus/web run dev`

## Limitations

- Singles Random Battles only.
- One-round lookahead; no deeper search.
- Chance branches are a small seeded sample, not a full damage-roll enumeration.
- Finite-shot QAOA is optional; exact `default.qubit` is the correctness default.

## Verification

```bash
npm test && npm run typecheck && npm run build
python -m unittest discover -s quantum-policy/tests
cd pokeredus && pytest tests/test_matchup_graph_8attr.py tests/test_matchup_graph_view.py tests/test_attribute_engine.py tests/test_phase5.py
```
