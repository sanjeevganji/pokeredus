## Set Design Overview

### Source
`pokeredus/classes/sets.py` — `SetClass` dataclass.

### SetClass — The Primary Unit of Intelligence
Every competitive Pokémon configuration is a **Set**. All matchup scoring, team building, and graph queries operate at the Set level.

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | `str` | Auto-generated: `{pokemon_id}_{set_name_slug}` |
| `pokemon_id` | `str` | References the Pokémon species |
| `set_name` | `str` | Human-readable label (e.g. "Swords Dance", "Choice Scarf") |
| `ability` | `str` | Ability ID |
| `item` | `str` | Item ID |
| `nature` | `NatureClass` | Nature instance (stat modifiers) |
| `evs` | `EVSpreadClass` | EV spread |
| `moves` | `list[str]` | Up to 4 move IDs |
| `ivs` | `dict[str, int]` | Individual values (defaults to 31 for all) |
| `role` | `str` | Role category (see below) |
| `tera_type` | `str` | Gen 9 Tera type |

### Auto-ID Generation
If no `id` is provided, it is auto-generated:
- Slug from `set_name`: lowercase, spaces → underscores, "+" → "plus".
- Final ID: `f"{pokemon_id}_{slug}"`

### effective_stat() Formula
Standard Pokémon stat formula:

**HP**: `int(((2 * base + iv + ev // 4) * level / 100) + level + 10)`

**Other stats** (atk, def, spa, spd, spe):
`int((((2 * base + iv + ev // 4) * level / 100) + 5) * nature_mod)`

Where `nature_mod` is the nature's multiplier for that stat (e.g. 1.1 for boosted, 0.9 for hindered, 1.0 neutral).

### Role Categories (from `config.py`)
Defined in `pokeredus/config.py` `ROLES` list:
- `sweeper` — Fast offensive Pokémon aiming to clean late-game
- `wall` — Defensive Pokémon focused on taking hits
- `pivot` — Switches in and out to maintain momentum
- `wallbreaker` — Powerful attacker that breaks through walls
- `stallbreaker` — Disrupts stall teams
- `hazard_setter` — Sets Stealth Rock, Spikes, etc.
- `hazard_remover` — Removes hazards via Defog, Rapid Spin
- `cleric` — Heals status conditions for the team
- `revenge_killer` — Weakens or KOs after a teammate falls
- `setup_sweeper` — Uses boosting moves (Swords Dance, etc.) then sweeps
- `offensive_pivot` — Fast pivot with offensive presence
- `defensive_pivot` — Bulky pivot for safe switches
- `tank` — Mixed offensive/defensive role

### Primary / Star Set
- Each Pokémon species can designate one set as its **primary set** (`primary_set_id` on `PokemonClass`).
- The primary set serves as the "base" for damage calculation in `BattleSimulator`.
- In the GUI, the primary set is marked with a gold star (★), others with a dim star (☆).
- Clicking the star toggles which set is primary.

### Set Generation
- Sets are imported from Smogon/Showdown data via `smogon_importer.py` and `showdown_importer.py`.
- The `build_species_profile()` function in `battle_simulator.py` aggregates stats across all sets of a species.
- Each set is stored in the knowledge graph and indexed by its auto-generated ID.
