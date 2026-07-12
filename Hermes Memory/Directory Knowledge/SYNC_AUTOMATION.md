# Obsidian ↔ PokeRedus Code Sync Automation

## Overview
This system allows technical details (formulas, weights, thresholds, type chart, mod priorities) to be edited in Obsidian and reflected in the code. The sync runs via a Python script that reads parameter values from markdown files and generates config updates.

## Architecture

```
Obsidian Vault (.md files)
       ↓ read
sync_configs.py ← cron / manual trigger
       ↓ write
pokeredus/config.py          (constants, thresholds)
pokeredus/graph/damage_calc.py (modifier priorities, formulas)
pokeredus/graph/matchup_graph.py (SCU constants, weights)
pokeredus/graph/matchup_engine.py (scoring parameters)
pokeredus/classes/types.py  (TYPE_CHART entries)
pokeredus/classes/pokemon.py (classification lists)
```

## Syncable Parameters (currently sourced to code)

### From Obsidian → config.py
| Parameter | File/Section | Current Value |
|-----------|-------------|---------------|
| MATCHUP_CONFIDENCE | Formulas & Weights/MATCHUP_SCORING.md | 0.5 (default), 0.7 (both can deal) |
| MIN_MATCHUP_CONFIDENCE | Config Reference | 0.1 |
| SPEED_ADJ_BASE | Formulas & Weights/MATCHUP_SCORING.md | 0.10 |
| SPEED_ADJ_TIE | Formulas & Weights/MATCHUP_SCORING.md | 0.15 |
| TTK_DIFF_SCALING | Formulas & Weights/MATCHUP_SCORING.md | 2.5 (tanh divisor) |

### From Obsidian → damage_calc.py
| Parameter | File/Section | Current Value |
|-----------|-------------|---------------|
| ChoiceBand priority | Damage Calculation/OVERVIEW.md | 50 |
| ChoiceSpecs priority | Damage Calculation/OVERVIEW.md | 50 |
| LifeOrb priority | Damage Calculation/OVERVIEW.md | 80 |
| ChoiceBand multiplier | Damage Calculation/OVERVIEW.md | 1.5 |
| LifeOrb multiplier | Damage Calculation/OVERVIEW.md | 1.3 |

### From Obsidian → matchup_graph.py
| Parameter | File/Section | Current Value |
|-----------|-------------|---------------|
| CONTROL_DENOMINATOR | 3D Matchup Graph/FORMULAS.md | 3.0 |
| UTILITY_HAZARD_SETTER_WEIGHT | 3D Matchup Graph/FORMULAS.md | 0.4 |
| UTILITY_HAZARD_REMOVER_WEIGHT | 3D Matchup Graph/FORMULAS.md | 0.3 |
| UTILITY_FIELD_SETTER_WEIGHT | 3D Matchup Graph/FORMULAS.md | 0.3 |
| SPEED_SCALE_MIN | 3D Matchup Graph/FORMULAS.md | 100 |
| SPEED_SCALE_MAX | 3D Matchup Graph/FORMULAS.md | 150 |

### From Obsidian → matchup_engine.py
| Parameter | File/Section | Current Value |
|-----------|-------------|---------------|
| TTK scaling divisor | Matchup Scoring/FORMULAS.md | 2.5 (tanh) |
| Speed adjustment | Matchup Scoring/FORMULAS.md | 0.10 |
| Speed tiebreaker | Matchup Scoring/FORMULAS.md | 0.15 |

### From Obsidian → types.py
| Parameter | File/Section | Current Value |
|-----------|-------------|---------------|
| TYPE_CHART entries | TYPE_CHART.md | 18×18 matrix |

## Sync Script Usage

### Manual Sync
```bash
cd /d/PokeRedus
python scripts/sync_obsidian_configs.py
```

### Automatic Sync (via cron)
Already configured via Hermes cron. Runs every hour.

## How to Add a New Syncable Parameter

1. Add a `📐 parameter_name = value` line to the relevant Obsidian markdown file
2. Add a parser regex in `scripts/sync_obsidian_configs.py` for that parameter
3. Add a target key in the mapping dict that maps parameter → (file, {old_value, new_value})
4. The sync script will patch the code file on next run

## Vault Organization

### Directory Structure
```
Hermes Memory/
├── Project Knowledge/         # Architecture, formulas, data structures
│   ├── Architecture/          # Layer docs (Knowledge, Graph, GUI, Intelligence)
│   ├── Formulas & Weights/    # All formulas with parameters
│   ├── Data Structures/       # Dataclass references, config
│   ├── API Reference/         # Function signatures
│   └── Phases/                # Phase history and roadmap
├── Attribute Database/        # Attribute system docs
├── Game Engine/               # Damage calc, matchup, battle sim
├── Play Intelligence/         # Queries, analytics, AI decisions
├── GUI/                       # Theme, panels, widgets
├── Matchup Calculations/      # TTK, MCTS, cache
├── Gameplay/                  # Tier lists, set design, team archetypes
├── Coding/                    # Patterns, conventions, debugging
├── Directory Knowledge/       # File-index map
├── Deployment/                # Build, deploy, test instructions
└── Resources/                 # External references
```

### Naming Conventions for Notes
- Use UPPERCASE for root-level knowledge area cards
- Use Title Case for .md files
- Use Obsidian [[wikilinks]] for cross-references between notes
- Use tags like #formula #weight #threshold for machine-parseable parameters
- Use 📐 prefix for syncable parameters