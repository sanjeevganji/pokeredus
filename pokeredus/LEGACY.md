# Legacy Python package (frozen)

The active codebase is the TypeScript monorepo under `packages/`.

This directory is retained for:
- Historical reference and golden fixtures
- On-disk data (`data/knowledge-pack/`, `data/teams/`, raw JSON)
- Optional one-off Python scripts

**Do not add new Python domain logic.** Use:
- `@pokeredus/calc` for damage
- `@pokeredus/core` for KG/matchup/MCTS
- `@pokeredus/cli export-pack` for Knowledge Pack export
- `@pokeredus/web` for GUI
