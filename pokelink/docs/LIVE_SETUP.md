# PokeLink — Live Battle Setup

This documents how to run the PokeLink Showdown Bridge end-to-end against a real
Gen9OU battle on `play.pokemonshowdown.com`.

## 1. Export the Knowledge Pack (one-time)

From the Python repo:

    cd pokeredus
    python scripts/export_knowledge_pack.py

This writes `pokeredus/data/knowledge-pack/knowledge-pack-v1.json`. Copy or
reference it from the `pokelink/` working directory.

For a tiny offline pack (good for tests / fast iteration):

    python scripts/export_knowledge_pack.py --mini
    # → knowledge-pack-mini.json (copy to pokelink/tests/fixtures/)

## 2. Build the TypeScript app

    cd pokelink
    npm install
    npm run build        # tsc type-check

## 3. Sanity-check the pack

    npm run dev -- render-pack --pack knowledge-pack-v1.json

Expect a one-line stats block: `#species=…, #sets=…, #edges=…, byteSizeMB=…`.

## 4. (Offline) Replay a saved transcript

    npm run dev -- score --replay tests/fixtures/transcript.txt --pack tests/fixtures/pack.mini.json --dry-run

This prints a top-3 decision per `|request|` line and never connects to a
server — the human fine-tuning surface.

## 5. Play a live battle

1. Open https://play.pokemonshowdown.com in a browser.
2. Start a **Gen9OU** battle (or have someone challenge you).
3. Copy the battle room id from the URL — it looks like
   `battle-gen9ou-1234567890-abcdef`. The bare `gen9ou-1234567890-abcdef`
   also works; the CLI prepends `battle-` automatically.
4. In a terminal:

       npm run dev -- live --battle <roomid> --pack knowledge-pack-v1.json

   For a named account (so the bot plays *your* team), add credentials:

       npm run dev -- live --battle <roomid> --pack knowledge-pack-v1.json \
           --user YOURNAME --pass YOURPASS

   Omit `--user/--pass` to join as a random guest (useful for observing).

5. Watch the CLI log the top-3 ranked actions with reasoning, then post the
   chosen move within ~2s of each `|request|`. Press Ctrl-C to quit.

### Dry-run (observe without moving)

Add `--dry-run` to any `live` or `score` command to log the decision without
sending it to the server:

    npm run dev -- live --battle <roomid> --pack knowledge-pack-v1.json --dry-run

## 6. How it works (one paragraph)

`ShowdownClient` opens the websocket, handles the `|challstr|`→`|/trn` auth
handshake, and joins the battle room. Every protocol line is parsed by
`parseLine` into a `BattleEvent` and folded by `BattleTracker` into a
normalized `TurnState`. On each `|request|` (your turn), `decideAndAct` calls
`scoreTurn` (the MCTS-style scorer in `src/engine/`), logs the top-3 with
reasoning, and posts `|/choose move <id>` (or `|/choose switch <n>`) back over
the socket. All scoring intelligence comes from the downloaded Knowledge Pack +
`biases.json` — no Python at runtime.

## 7. Tuning

Edit `biases.json` (or pass `--biases my.json`) to reweight the scorer
(type-eff, STAB, edge prior, rollout depth/breadth, switch threshold, …). The
loader prints overridden keys at startup so you can see exactly what changed.

## Verified

- Framework verified on: 2026-07-08 (offline `score` replay + type-check clean).
- Live guest battle: run step 5 yourself against a low-ladder match; if the
  engine ever picks an obviously-wrong move (e.g. an immune attack), note it as
  a follow-up — bias tuning, not a framework bug.
