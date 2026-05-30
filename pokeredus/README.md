# PokeRedus

Class-based Pokémon intelligence system for Pokémon Showdown, focused on the **OU (OverUsed) tier**.

## Core Concepts

- **Pokémon species** are classes with base stats, typing, and learnsets
- **Sets** are competitive configurations (moves + item + ability + nature + EVs + role)
- All intelligence operates at the **Set level** — matchups, scoring, team building
- A **graph-based matchup system** maps relationships between sets using type effectiveness, stat comparisons, and set-specific factors
- The GUI serves as a team builder and knowledge browser

## Architecture

```
Knowledge Layer    →  class definitions, set templates, imported data
Graph Layer        →  matchup relationships between sets (scored, typed)
Intelligence Layer →  algorithms that query the graph for decisions
```

## Project Structure

```
pokeredus/
├── pokeredus/          # main package
│   ├── classes/        # dataclasses: Pokemon, Set, Move, Ability, Item, etc.
│   ├── graph/          # KnowledgeGraph container, matchup engine, queries
│   ├── importers/      # Showdown + Smogon data importers
│   ├── gui/            # Tkinter team builder and graph viewer
│   └── utils/          # I/O helpers
├── data/               # imported JSON, user sets, serialized graphs
├── scripts/            # CLI entry points (build_graph, etc.)
└── tests/              # unit tests
```

## Quick Start

```bash
cd pokeredus
pip install -e ".[dev]"
python scripts/build_graph.py       # import data + compute matchups
python -m pokeredus.gui.app         # launch the GUI
```

## Dependencies

- `networkx` — graph data structure for the knowledge graph
- `pyyaml` — set/team serialization
- `requests` — fetching Showdown/Smogon data
- `tkinter` — GUI (ships with Python)

## Tier Focus

Gen 9 OU — approximately 35–40 Pokémon with 100–150 viable competitive sets. The small pool allows exhaustive pairwise matchup computation and real-time graph queries.
