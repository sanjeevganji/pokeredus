# PokeRedus

Gen 9 OU intelligence system powered by **`@smogon/calc`** for damage physics, with PokeRedus-specific knowledge graph, MCTS, and Showdown bridge.

| Project | Location | Role |
|---|---|---|
| **PokeRedus (TS)** | repo root + `packages/*` | Active monorepo |
| **PokeLink (CLI)** | `packages/cli` (`bin`: `pokelink`) | Battle bridge + pack tooling |
| **PokeLink (standalone)** | `pokelink/` | Original TS prototype (superseded) |
| **PokeRedus (Python)** | `pokeredus/` | Legacy GUI + data (frozen; reference only) |

**Requirements:** Node ≥ 20 · Python ≥ 3.11 (legacy only)

---

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
pokelink/   — standalone TS prototype (superseded by packages/*)
pokeredus/  — legacy Python reference + on-disk data
```

## Architecture

- **Damage:** all paths use `@pokeredus/calc` → npm `@smogon/calc` (Gen 9).
- **Intelligence:** Knowledge Pack edges + `biases.json` consumed by `scoreTurn`.
- **Python `pokeredus/`:** data source and reference only — new features land in `packages/*`. See `pokeredus/LEGACY.md`.

---

## One-time setup

### TypeScript monorepo (active)

```bash
npm install
```

### Standalone PokeLink

```bash
cd pokelink && npm install
```

### Python PokeRedus (legacy)

```bash
cd pokeredus && pip install -e ".[dev]"
```

---

## Maintain / verify

### Monorepo (from repo root)

```bash
npm test
npm run typecheck
npm run build
npm test -w @pokeredus/<pkg>
npm run typecheck -w @pokeredus/<pkg>
```

Packages with scripts: `calc`, `pack`, `biases`, `engine`, `bridge`, `core`, `cli` (`dev`/`test`/`typecheck`), `web` (`dev`/`build`/`preview`/`typecheck`).

### Standalone PokeLink

```bash
cd pokelink && npm test
cd pokelink && npm run build
```

### Python

```bash
cd pokeredus && pytest
cd pokeredus && pytest --cov=pokeredus
```

---

## Run applications

### Web GUI

```bash
npm run dev -w @pokeredus/web
npm run build -w @pokeredus/web
npm run preview -w @pokeredus/web
```

### PokeLink CLI (active — `@pokeredus/cli`)

```bash
npm run dev -w @pokeredus/cli -- render-pack --pack <pack.json>
npm run dev -w @pokeredus/cli -- export-pack
npm run dev -w @pokeredus/cli -- export-training
npm run dev -w @pokeredus/cli -- score --replay <transcript.txt> --pack <pack.json>
npm run dev -w @pokeredus/cli -- live --battle <roomid> --pack <pack.json>
```

| Subcommand | Purpose |
|---|---|
| `render-pack` | Print pack stats (#species, #sets, #edges, size, version) |
| `export-pack` | Recompute Knowledge Pack edges from a template |
| `export-training` | Write JSONL training corpus from pack set pairs |
| `score` | Offline: replay a transcript and print a decision per turn |
| `live` | Connect to play.pokemonshowdown.com and play a battle |

**Flags**

| Flag | Purpose |
|---|---|
| `--pack <f>` | Knowledge Pack JSON (default: `knowledge-pack-v1.json`) |
| `--template <f>` | Source pack for `export-pack` |
| `--out <f>` | Output path (`export-pack`, `export-training`) |
| `--mini` | Export first 5 species only (`export-pack`) |
| `--max-species <n>` | Cap species count (`export-pack` debug) |
| `--max-pairs <n>` | Cap training pair count (`export-training`) |
| `--biases <f>` | Biases JSON for scorer (`score`, `live`) |
| `--replay <f>` | Transcript file (`score`) |
| `--battle <id>` | Battle room id (`live`; bare id or `battle-…`) |
| `--user` / `--pass` | Named Showdown account (`live`; omit for guest) |
| `--url <ws>` | Custom Showdown websocket URL (`live`) |
| `--dry-run` | Log chosen move; never send it (`score`, `live`) |

### Standalone PokeLink (`pokelink/`)

Supports `render-pack`, `score`, and `live` only (no export commands). Same flags as above where applicable. Live setup notes: `pokelink/docs/LIVE_SETUP.md`.

```bash
cd pokelink && npm run dev -- render-pack --pack <pack.json>
cd pokelink && npm run dev -- score --replay <transcript.txt> --pack <pack.json>
cd pokelink && npm run dev -- live --battle <roomid> --pack <pack.json>
```

### Python GUI & scripts (`pokeredus/`)

```bash
cd pokeredus && python scripts/launch.py
cd pokeredus && python -m pokeredus.gui.unified_app
cd pokeredus && python -m pokeredus.gui.app
cd pokeredus && python scripts/build_graph.py
cd pokeredus && python scripts/export_knowledge_pack.py
cd pokeredus && python scripts/export_training_data.py
cd pokeredus && python scripts/fetch_moves.py
cd pokeredus && python scripts/fetch_base_stats.py
cd pokeredus && python scripts/download_sprites.py
cd pokeredus && python scripts/download_item_sprites.py
cd pokeredus && python scripts/sync_obsidian_configs.py
```

| Script / flag | Purpose |
|---|---|
| `launch.py` | Build graph if stale, run tests, open Unified GUI |
| `--no-build` | Skip auto-build of the matchup graph |
| `--no-tests` | Skip integration tests before GUI |
| `--tests-only` | Build + tests, no GUI |
| `--legacy` | Old title-screen shell |
| `build_graph.py` | Import data + compute matchups → `data/graphs/ou_matchup_graph.json` |
| `export_knowledge_pack.py` | Emit portable Knowledge Pack JSON for PokeLink |
| `--mini` / `--max-species` / `--out` | Mini pack, species cap, or custom output path |
| `export_training_data.py` | Export training JSONL corpus |
| `--output` / `--teams` / `--max-per-team` / `--demo` | Output path, team count, scene cap, tiny demo run |
| `fetch_moves.py` | Download Showdown moves → `data/raw/moves.json` |
| `fetch_base_stats.py` | Fetch species base stats → `data/raw/base_stats.json` |
| `download_sprites.py` | Download species sprites (needs graph) |
| `download_item_sprites.py` | Download item sprites (needs graph) |
| `sync_obsidian_configs.py` | Dry-run sync of Obsidian params into code |
| `--apply` | Write Obsidian sync changes |
