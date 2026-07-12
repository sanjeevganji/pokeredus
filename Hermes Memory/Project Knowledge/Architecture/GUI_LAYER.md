# PokeRedus Architecture - GUI Layer

## App Structure (app.py)
- Main window with navigation tabs
- Pokémon Browser (pokemon_panel.py)
- Team Builder (team_builder.py)
- Graph View (graph_view.py) - placeholder

## Pokémon Panel (pokemon_panel.py)
- Sidebar: Scrollable Pokémon list with filters
- Detail Panel: Species card, base stats, abilities, sets, matchups
- Filters: RegexSearchFilter, TypeFilter, ClassificationFilter
- Sprite Management: PIL-based with async download

## Team Builder (team_builder.py)
- 6-slot team grid (2×3 layout)
- TeamSlotCard: Empty or filled (sprite, name, set, type badges, moves)
- Set Selector Dialog: Modal for choosing Pokémon + set
- Save/Load: YAML serialization
- Showdown Export: Text format for Pokémon Showdown

## Set Editor (set_editor.py)
- Create/edit/duplicate/delete sets
- Form fields: moves, ability, item, nature, EVs, IVs, role, tera_type
- Matchup recomputation on save

## Matchup Graph View (matchup_graph_view.py)
- MatchupGraph2D: Radial polygon visualization with "elaborate by types" toggle
- MatchupGraph3D: Stacked-disc cylinder with arrow keys / drag / wheel / click-to-pick
- MatchupGraphView: Combined 2D/3D toggle with set_set() and set_team()
- MatchupGraphPage: Page wrapper with toolbar + set-list sidebar + view body

## Data Flow

```
1. Import Phase (scripts/build_graph.py)
   Showdown/Smogon JSON → Importers → KnowledgeGraph → Save to JSON

2. Matchup Computation Phase
   KnowledgeGraph → MatchupEngine → MatchupRelation edges → Save to JSON
   KnowledgeGraph → MatchupCache → CachedMatchup entries → Save to JSON

3. Query Phase
   User Query → Intelligence Layer → KnowledgeGraph → Results

4. GUI Phase
   User Action → GUI Layer → Intelligence Layer → KnowledgeGraph → Display
```

## GUI Preferences (from user)
- NO gradient backgrounds (laggy/ugly) — use type-colored badges instead
- Notification badges for counts (not text labels)
- Side-by-side layouts over stacked
- Lazy loading (+5 on demand) for long lists
- Bigger fonts filling width
- Stat bars: yellow→green gradient mapping for dominance
- Dark-themed scrollbars
- Sprites in headings and list items
- Numeric sort column visible in list