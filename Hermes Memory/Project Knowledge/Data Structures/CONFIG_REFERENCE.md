# PokeRedus Configuration Reference

## Config File
`pokeredus/config.py`

## Tier Settings
| Constant | Value | Description |
|----------|-------|-------------|
| TIER | "gen9ou" | Current tier slug |
| TIER_DISPLAY | "Gen 9 OU" | Display name |

## Paths (relative to project root)
| Constant | Value |
|----------|-------|
| PROJECT_ROOT | Path(__file__).resolve().parent.parent |
| DATA_DIR | PROJECT_ROOT / "data" |
| RAW_DATA_DIR | DATA_DIR / "raw" |
| SETS_DIR | DATA_DIR / "sets" |
| GRAPHS_DIR | DATA_DIR / "graphs" |
| TEAMS_DIR | DATA_DIR / "teams" |
| CACHE_DIR | DATA_DIR / "cache" |

## Data Files (inside RAW_DATA_DIR)
| Constant | File |
|----------|------|
| POKEDEX_FILE | pokedex.json |
| MOVES_FILE | moves.json |
| ABILITIES_FILE | abilities.json |
| ITEMS_FILE | items.json |
| NATURES_FILE | natures.json |
| TYPECHART_FILE | typechart.json |

## Matchup Engine Defaults
| Constant | Value | Description |
|----------|-------|-------------|
| DEFAULT_MATCHUP_CONFIDENCE | 0.3 | Type-calc only, no battle data |
| MIN_MATCHUP_CONFIDENCE | 0.1 | Floor for graph inclusion |
| MAX_MATCHUP_SAMPLE_COUNT | 0 | No battle data at startup |

## GUI Defaults
| Constant | Value |
|----------|-------|
| GUI_WINDOW_TITLE | "PokeRedus — OU Intelligence Builder" |
| GUI_WINDOW_WIDTH | 1200 |
| GUI_WINDOW_HEIGHT | 800 |
| GUI_THEME | "clam" |

## Pokémon Constants

### 18 Types
Normal, Fire, Water, Electric, Grass, Ice, Fighting, Poison, Ground, Flying, Psychic, Bug, Rock, Ghost, Dragon, Dark, Steel, Fairy

### 6 Stats (STAT_NAMES)
hp, atk, def, spa, spd, spe

### Stat Labels
hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe"

### 12 Roles
sweeper, wall, pivot, wallbreaker, stallbreaker, hazard_setter, hazard_remover, cleric, revenge_killer, setup_sweeper, offensive_pivot, defensive_pivot, tank

### EV Limits
- Per stat: 252
- Total: 508
- Default IV: 31