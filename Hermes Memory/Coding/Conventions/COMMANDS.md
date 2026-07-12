# Coding Reference

## Language
Python 3.11+

## Build System
- `uv` for venv management
- `pip install -e ".[dev]"` for dev install
- No requirements.txt — use `pyproject.toml`

## Key Dependencies
- **networkx**: Graph data structure
- **pyyaml**: Set/team serialization
- **requests**: Fetching Showdown/Smogon data
- **tkinter**: GUI (ships with Python)
- **PIL (Pillow)**: Sprite processing
- **pytest**: Testing framework
- **numpy**: 3D graph matrix operations
- **sounddevice**: Audio (ships optionally)

## Commands
| Command | Purpose |
|---------|---------|
| `python scripts/build_graph.py` | Import data + compute matchups |
| `python -m pokeredus.gui.app` | Launch GUI |
| `python -m pytest tests/` | Run all tests |
| `python scripts/sync_obsidian_configs.py --apply` | Sync Obsidian → code |

## Project Structure Convention
- Absolute imports only (from pokeredus.xxx import yyy)
- TYPE_CHECKING guards for circular imports
- Dataclasses for data objects, classes for services/engines
- Properties over getter methods

## Git Conventions
- Repo root: D:\PokeRedus (NOT inner pokeredus/)
- When committing: `git add <specific files>` (never `git add -A`)
- .gitignore covers \_\_pycache\_\_/, *.pyc, data/cache/, data/graphs/*.json
- Verify with `git status --short` before committing