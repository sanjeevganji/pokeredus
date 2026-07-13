# PokeRedus (TypeScript)

Gen 9 OU intelligence system powered by **`@smogon/calc`** for damage physics, with PokeRedus-specific knowledge graph, MCTS, and Showdown bridge.

## Monorepo layout

```
packages/
  calc/     @pokeredus/calc   — sole @smogon/calc adapter
  pack/     @pokeredus/pack   — Knowledge Pack schema + PackIndex
  biases/   @pokeredus/biases — tunable scorer weights
  engine/   @pokeredus/engine — leaf + scoreTurn (MCTS-style)
  bridge/   @pokeredus/bridge — Showdown websocket client
  cli/      @pokeredus/cli    — render-pack | export-pack | score | live
  core/     @pokeredus/core   — KG, matchup, battle sim, MCTS, unified
  web/      @pokeredus/web    — React GUI (replaces tkinter)
pokeredus/  — legacy Python reference (frozen; use TS packages for new work)
```

## Quick start

```bash
npm install
npm test
npm run typecheck --workspaces --if-present

# CLI
npm run dev -w @pokeredus/cli -- render-pack --pack pokeredus/data/knowledge-pack/knowledge-pack-mini.json
npm run dev -w @pokeredus/cli -- export-pack --mini
npm run dev -w @pokeredus/cli -- export-training --pack pokeredus/data/knowledge-pack/knowledge-pack-mini.json
npm run dev -w @pokeredus/cli -- score --replay packages/cli/tests/fixtures/transcript.txt --pack packages/cli/tests/fixtures/pack.mini.json

# Web GUI
npm run dev -w @pokeredus/web
npm run build -w @pokeredus/web
```

## Architecture

- **Damage:** all paths use `@pokeredus/calc` → npm `@smogon/calc` (Gen 9).
- **Intelligence:** Knowledge Pack edges + `biases.json` consumed by `scoreTurn`.
- **Python `pokeredus/`:** retained as reference and data source only; new features land in `packages/*`.

## Verification

```bash
npm test
npm run typecheck --workspaces --if-present
```
