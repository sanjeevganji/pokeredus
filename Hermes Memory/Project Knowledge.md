---
tags: [index, project-knowledge]
updated: {{date}}
---
# Project Knowledge

Welcome to the PokeRedus Obsidian knowledge base.

## Quick Navigation

### Architecture
- [[Project Knowledge/Architecture/OVERVIEW|Architecture Overview]]
- [[Project Knowledge/Architecture/GRAPH_LAYER|Graph Layer]]
- [[Project Knowledge/Architecture/INTELLIGENCE_LAYER|Intelligence Layer]]
- [[Project Knowledge/Architecture/GUI_LAYER|GUI Layer]]

### Formulas & Weights
- [[Project Knowledge/Formulas & Weights/DAMAGE_FORMULAS|Damage Formulas]]
- [[Project Knowledge/Formulas & Weights/MATCHUP_SCORING|Matchup Scoring]]
- [[Project Knowledge/Formulas & Weights/3D_MATCHUP_GRAPH|3D Matchup Graph]]

### Data Structures
- [[Project Knowledge/Data Structures/CONFIG_REFERENCE|Config Reference]]
- [[Project Knowledge/Phases/PHASE_HISTORY|Phase History]]

### Game Engine
- [[Game Engine/Damage Calculation/OVERVIEW|Damage Calculation]]
- [[Game Engine/Matchup Scoring/OVERVIEW|Matchup Scoring]]
- [[Game Engine/Battle Simulation/OVERVIEW|Battle Simulation]]
- [[Game Engine/TYPE_CHART|Type Chart]]

### Attribute System
- [[Attribute Database/OVERVIEW|Attribute Overview]]
- [[Attribute Database/Attributes/SUBCLASSES|Attribute Subclasses]]
- [[Attribute Database/REGISTRY|Attribute Registry]]

### Play Intelligence
- [[Play Intelligence/AI Decisions/QUERIES|AI Queries]]

### GUI
- [[GUI/Theme/COLORS|Theme Colors]]
- [[GUI/Theme/COLORS#Panels|GUI Panels]]

### Matchup Calculations
- [[Matchup Calculations/Cache Strategy/OVERVIEW|Cache Strategy]]

### Gameplay
- [[Gameplay/Set Design/OVERVIEW|Set Design]]
- [[Gameplay/Team Archetypes/OVERVIEW|Team Archetypes]]

### Coding
- [[Coding/Conventions/CONVENTIONS|Conventions]]

### Automation
- [[Directory Knowledge/SYNC_AUTOMATION|Sync Automation]]
- [[Directory Knowledge/SYNC_AUTOMATION#Sync Script Usage|Running the Sync]]

## Quick Stats
- **Pokémon**: ~118 species
- **Sets**: ~270 competitive sets
- **Moves**: ~954 moves
- **Matchup Graph**: ~72,630 edges
- **Graph Size**: ~89 MB serialized
- **Current Phase**: 8 (3D Matchup Graph + AI Queries)
- **Next Phase**: 9 (Battle Simulation & Decision Engine)

## How to Use This Vault

### Viewing Knowledge
Navigate the folders in the left sidebar. Each section has an OVERVIEW.md index file that links to deeper docs.

### Editing Parameters (Formula Change Workflow)
1. Find the parameter in its Obsidian note (look for 📐 prefix)
2. Edit the value in the markdown table
3. Run `python scripts/sync_obsidian_configs.py --apply`
4. Rebuild the knowledge graph: `python scripts/build_graph.py`
5. Verify the output

### Adding New Knowledge
1. Use the template `/templates/Concept Note.md` or `/templates/Formula Note.md`
2. Place the file in the correct subdirectory
3. Add [[wikilinks]] to related notes
4. Update the parent OVERVIEW.md if needed