## GUI Theme — Colors and Styling

### Source
`pokeredus/gui/theme.py` — Modern retro neon theme with dark backgrounds and vibrant accents.

### Background Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `BG_DARK` | `#0d1117` | Main background |
| `BG_PANEL` | `#161b22` | Panel background |
| `BG_CARD` | `#1c2333` | Card background |
| `BG_INPUT` | `#21262d` | Input field background |
| `BG_HOVER` | `#292e36` | Hover state |
| `BG_SELECTED` | `#1a2744` | Selected state (blue tint) |
| `BG_TEXT_OVERLAY` | `#151a24` | Dark overlay for text on gradients |

### Foreground Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `FG_PRIMARY` | `#e6edf3` | Main text |
| `FG_SECONDARY` | `#8b949e` | Muted text |
| `FG_DIM` | `#484f58` | Very muted text |

### Neon Accents

| Token | Hex |
|-------|-----|
| `NEON_CYAN` | `#00d4ff` |
| `NEON_PINK` | `#ff6ec7` |
| `NEON_GREEN` | `#39ff14` |
| `NEON_ORANGE` | `#ff6b35` |
| `NEON_PURPLE` | `#b24dff` |
| `NEON_YELLOW` | `#ffe600` |
| `NEON_RED` | `#ff3366` |
| `STAR_ACTIVE` | `#ffe600` (gold — primary set) |
| `STAR_INACTIVE` | `#484f58` (dim — not primary) |

### Type Colors (`TYPE_COLORS`)

| Type | Hex |
|------|-----|
| Normal | `#a8a878` |
| Fire | `#ff6b35` |
| Water | `#00d4ff` |
| Electric | `#ffe600` |
| Grass | `#39ff14` |
| Ice | `#98d8d8` |
| Fighting | `#c03028` |
| Poison | `#b24dff` |
| Ground | `#e0c068` |
| Flying | `#a890f0` |
| Psychic | `#f85888` |
| Bug | `#a8b820` |
| Rock | `#b8a038` |
| Ghost | `#705898` |
| Dragon | `#7038f8` |
| Dark | `#705848` |
| Steel | `#b8b8d0` |
| Fairy | `#ffaec9` |

Darker variants (`TYPE_COLORS_DARK`) exist for gradient backgrounds.

### Stat Colors (`STAT_COLORS`)

| Stat | Hex |
|------|-----|
| HP | `#ff3366` |
| Atk | `#ff6b35` |
| Def | `#ffe600` |
| SpA | `#00d4ff` |
| SpD | `#39ff14` |
| Spe | `#b24dff` |

### Role Colors (`ROLE_COLORS`)

| Role | Hex |
|------|-----|
| sweeper | `#ff3366` |
| setup_sweeper | `#ff6b35` |
| wallbreaker | `#ffe600` |
| wall | `#00d4ff` |
| pivot, defensive_pivot | `#39ff14` |
| hazard_setter, hazard_remover | `#b24dff` |
| revenge_killer | `#ff6ec7` |
| tank | `#98d8d8` |
| cleric | `#a890f0` |
| stallbreaker | `#c03028` |
| unclassified | `#8b949e` |

### Matchup Score Colors

| Token | Hex | Meaning |
|-------|-----|---------|
| `MATCHUP_WIN` | `#39ff14` | Green — favorable matchup |
| `MATCHUP_LOSE` | `#ff3366` | Red — unfavorable matchup |
| `MATCHUP_NEUTRAL` | `#ffe600` | Yellow — close matchup |

### TTK Colors

| TTK | Hex | Meaning |
|-----|-----|---------|
| 1 (OHKO) | `#ff3366` | Bright red — critical |
| 2 (2HKO) | `#ff6b35` | Orange — dangerous |
| 3 (3HKO) | `#ffe600` | Yellow — moderate |
| 4 (4HKO) | `#8b949e` | Gray — slow |
| 5+ | `#484f58` | Dim — impractical |

### Speed Advantage Colors

| Condition | Hex |
|-----------|-----|
| Faster | `#39ff14` (green) |
| Slower | `#ff3366` (red) |
| Tie | `#ffe600` (yellow) |

### Font Settings
- All fonts use **Consolas** (monospace) for a terminal aesthetic.
- `FONT_TITLE` = (`"Consolas"`, 48, `"bold"`)
- `FONT_SUBTITLE` = (`"Consolas"`, 18)
- `FONT_HEADING` = (`"Consolas"`, 14, `"bold"`)
- `FONT_BODY` = (`"Consolas"`, 11)
- `FONT_SMALL` = (`"Consolas"`, 9)
- `FONT_BUTTON` = (`"Consolas"`, 12, `"bold"`)
- `FONT_STAT` = (`"Consolas"`, 10)
- `FONT_STAT_HEADING` = (`"Consolas"`, 10, `"bold"`)

### Window Dimensions
- `WINDOW_MIN_W` = 1200 pixels
- `WINDOW_MIN_H` = 800 pixels
- `SIDEBAR_WIDTH` = 320 pixels (wider for sprites)
- `CARD_PAD` = 8 pixels
- `ANIMATION_DELAY` = 16 ms (~60fps)

### Type Gradients
- `make_type_gradient()` creates gradient backgrounds from 1 or 2 Pokémon types.
- Uses a small-image-upscale trick for performance (render at 10×10 then bicubic upscale).
- Horizontal gradient from type1 to type2 for dual-types, single color for single-types.
- Vertical darkening from top to bottom with edge vignette.
