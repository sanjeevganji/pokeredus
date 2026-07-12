# Deployment & Build Instructions

## Full Build Pipeline

```bash
cd /d/PokeRedus/pokeredus

# 1. Activate venv
source .venv/Scripts/activate  # or .venv/bin/activate

# 2. Build knowledge graph (import + matchup computation)
python scripts/build_graph.py
# Output: data/graphs/ou_matchup_graph.json (~89 MB)
#          data/sets/{pokemon_id}/{set_name}.yaml (individual set files)

# 3. Sync Obsidian docs to code (optional)
python scripts/sync_obsidian_configs.py --apply

# 4. Launch GUI
python -m pokeredus.gui.app
```

## Step-by-Step: build_graph.py

### Reads
- `resources/gen9ou.json` — Set data for OU tier
- `data/raw/base_stats.json` — Pokémon base stats, types, abilities
- `data/raw/moves.json` — Move data
- `data/graphs/ou_matchup_graph.json` — Existing graph (if any)

### Steps
1. Create KnowledgeGraph
2. Import gen9ou.json via Showdown importer
3. Compute all pairwise matchups (N × N)
4. Save serialized graph to JSON
5. Save individual set YAML files

### Quick Validation
After build, the script prints sample data:
```
Garchomp (Dragon/Ground) — 3 set(s), BST=600
  [Sweeper] Swords Dance: lifeorb, Jolly — 42 favorable, 28 unfavorable
```

## Testing

```bash
# Run all tests
python -m pytest tests/

# Run specific test file
python -m pytest tests/test_matchup.py -v

# Run with output capture
python -m pytest tests/ -s
```

## Performance Notes
- Graph build: ~90 seconds (full matchup computation for ~118 Pokémon, ~270 sets)
- GUI load: <2 seconds
- Query time: O(1) for indexed lookups, O(n) for filtered queries
- Cache build: ~90 seconds (13,924 entries for 118 Pokémon)

## Environment Notes
- Windows 10 (git-bash / MSYS)
- Python 3.11.15
- uv for venv management