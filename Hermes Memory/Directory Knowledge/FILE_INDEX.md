# Directory Knowledge — PokeRedus File Index

## Project Root: `/d/PokeRedus`

```
pokeredus/                    → Main Python project
├── pokeredus/               → Package root
│   ├── classes/             → Domain dataclasses
│   ├── graph/               → Knowledge graph, algorithms, AI
│   ├── gui/                 → Tkinter interface
│   ├── importers/           → Showdown/Smogon data importers
│   └── utils/               → I/O helpers
├── data/                    → Game data (raw, graphs, sets, teams, cache)
├── scripts/                 → CLI entry points
├── tests/                   → Unit tests
└── resources/               → Raw resources (gen9ou.json, etc.)

Hermes Memory/               → Obsidian Vault (knowledge base)
```

## Key Package Files

### classes/
| File | Contains |
|------|----------|
| pokemon.py | PokemonClass + classification sets |
| sets.py | SetClass |
| moves.py | MoveClass |
| abilities.py | AbilityClass |
| items.py | ItemClass |
| natures.py | NatureClass + STANDARD_NATURES |
| ev_spread.py | EVSpreadClass |
| types.py | TypeClass + TYPE_CHART + get_effectiveness |
| matchup.py | MatchupRelation |
| attributes.py | Attribute base class + subclasses |

### graph/
| File | Contains |
|------|----------|
| knowledge_graph.py | KnowledgeGraph (NetworkX DiGraph) |
| damage_calc.py | DamageCalculator + DamageModifier system |
| matchup_engine.py | compute_matchup, compute_all_matchups |
| matchup_cache.py | MatchupCache + CachedMatchup |
| matchup_scorer.py | MatchupScorer (MCTS scoring) |
| matchup_graph.py | 3D projection + AI queries + visual layer |
| species_matchup_cache.py | SpeciesMatchupCache (batch cache) |
| battle_simulator.py | BattleSimulator + SpeciesProfile |
| analytics.py | SetStats, rankings, aggregation |
| queries.py | Query functions |
| attribute_engine.py | Attribute engine |
| attribute_registry.py | AttributeRegistry |
| attribute_factory.py | Attribute factory |
| attribute_manager.py | Attribute manager |
| common_attributes.py | Common attribute definitions |
| game_state.py | GameState |
| synergy_detector.py | Team synergy detection |

### gui/
| File | Contains |
|------|----------|
| app.py | Main application window |
| pokemon_panel.py | Pokémon browser |
| team_builder.py | Team builder (2×3 grid) |
| set_editor.py | Set CRUD editor |
| matchup_panel.py | Matchup display panel |
| matchup_graph_view.py | 2D/3D graph views |
| graph_view.py | Graph visualization (placeholder) |
| theme.py | Color palette, fonts, dimensions |
| sprites.py | Sprite management (PIL) |
| team_store.py | Team persistence (YAML) |
| attribute_editor.py | Attribute editor |
| attribute_tuner.py | Attribute tuner |
| team_store.py | Team YAML persistence |

### scripts/
| File | Purpose |
|------|---------|
| build_graph.py | Import data + compute matchups |
| fetch_moves.py | Fetch move data from Showdown |
| fetch_base_stats.py | Fetch base stats from PokeAPI |
| download_sprites.py | Download Pokémon sprites |
| launch.py | Launch GUI |
| sync_obsidian_configs.py | Sync Obsidian docs → code |

### data/
| Directory | Contents |
|-----------|----------|
| raw/ | Imported JSON (moves, base_stats, etc.) |
| sets/ | User-created sets (YAML) |
| graphs/ | Serialized knowledge graphs |
| teams/ | Saved teams (YAML) |
| cache/ | Matchup cache |
| effects/ | Effect definitions |
| sprites/ | Pokémon sprite images |