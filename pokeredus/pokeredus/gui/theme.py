"""
PokeRedus GUI — styling constants and color palette.

Modern retro neon theme with dark backgrounds and vibrant accents.
"""

import tkinter as tk
from PIL import Image, ImageDraw

# ── Color Palette ───────────────────────────────────────────────────
BG_DARK = "#0d1117"          # main background
BG_PANEL = "#161b22"         # panel background
BG_CARD = "#1c2333"          # card background
BG_INPUT = "#21262d"         # input field background
BG_HOVER = "#292e36"         # hover state
BG_SELECTED = "#1a2744"      # selected state (blue tint)
BG_TEXT_OVERLAY = "#151a24"     # dark overlay for text on gradients

FG_PRIMARY = "#e6edf3"       # main text
FG_SECONDARY = "#8b949e"     # muted text
FG_DIM = "#484f58"           # very muted text

# Neon accents
NEON_CYAN = "#00d4ff"
NEON_PINK = "#ff6ec7"
NEON_GREEN = "#39ff14"
NEON_ORANGE = "#ff6b35"
NEON_PURPLE = "#b24dff"
NEON_YELLOW = "#ffe600"
NEON_RED = "#ff3366"
STAR_ACTIVE = "#ffe600"    # gold — primary set
STAR_INACTIVE = "#484f58"  # dim — not primary

# Type colors (neon-tinted)
TYPE_COLORS = {
    "Normal": "#a8a878", "Fire": "#ff6b35", "Water": "#00d4ff",
    "Electric": "#ffe600", "Grass": "#39ff14", "Ice": "#98d8d8",
    "Fighting": "#c03028", "Poison": "#b24dff", "Ground": "#e0c068",
    "Flying": "#a890f0", "Psychic": "#f85888", "Bug": "#a8b820",
    "Rock": "#b8a038", "Ghost": "#705898", "Dragon": "#7038f8",
    "Dark": "#705848", "Steel": "#b8b8d0", "Fairy": "#ffaec9",
}

# Darker versions of type colors for gradient backgrounds
TYPE_COLORS_DARK = {
    "Normal": "#5a5a3c", "Fire": "#7f3619", "Water": "#006a7f",
    "Electric": "#7f7300", "Grass": "#1c8009", "Ice": "#4c6c6c",
    "Fighting": "#601814", "Poison": "#592680", "Ground": "#706034",
    "Flying": "#544880", "Psychic": "#7c2c44", "Bug": "#545c10",
    "Rock": "#5c501c", "Ghost": "#382c4c", "Dragon": "#381c7c",
    "Dark": "#382c24", "Steel": "#5c5c68", "Fairy": "#805764",
}

# Stat colors
STAT_COLORS = {
    "hp": "#ff3366", "atk": "#ff6b35", "def": "#ffe600",
    "spa": "#00d4ff", "spd": "#39ff14", "spe": "#b24dff",
}

# Role colors
ROLE_COLORS = {
    "sweeper": "#ff3366", "setup_sweeper": "#ff6b35",
    "wallbreaker": "#ffe600", "wall": "#00d4ff",
    "pivot": "#39ff14", "defensive_pivot": "#39ff14",
    "hazard_setter": "#b24dff", "hazard_remover": "#b24dff",
    "revenge_killer": "#ff6ec7", "tank": "#98d8d8",
    "cleric": "#a890f0", "stallbreaker": "#c03028",
    "unclassified": "#8b949e",
}

# Matchup score colors
MATCHUP_WIN = "#39ff14"       # green — favorable
MATCHUP_LOSE = "#ff3366"     # red — unfavorable
MATCHUP_NEUTRAL = "#ffe600"  # yellow — close

# Phase 5: TTK colors
TTK_COLORS = {
    1: "#ff3366",    # OHKO — bright red (critical)
    2: "#ff6b35",    # 2HKO — orange (dangerous)
    3: "#ffe600",    # 3HKO — yellow (moderate)
    4: "#8b949e",    # 4HKO — gray (slow)
    5: "#484f58",    # 5+ HKO — dim (impractical)
}

# Speed advantage colors
SPEED_FASTER = "#39ff14"      # green — we're faster
SPEED_SLOWER = "#ff3366"      # red — we're slower
SPEED_TIE = "#ffe600"         # yellow — speed tie

# Classification badge colors
CLASSIFICATION_COLORS = {
    "mega": "#ff6ec7",
    "paradox": "#b24dff",
    "legendary": "#ffe600",
    "pseudo": "#ff6b35",
}

# ── Fonts ───────────────────────────────────────────────────────────
FONT_TITLE = ("Consolas", 48, "bold")
FONT_SUBTITLE = ("Consolas", 18)
FONT_HEADING = ("Consolas", 14, "bold")
FONT_BODY = ("Consolas", 11)
FONT_BODY_BOLD = ("Consolas", 11, "bold")
FONT_SMALL = ("Consolas", 9)
FONT_BUTTON = ("Consolas", 12, "bold")
FONT_STAT = ("Consolas", 10)
FONT_STAT_HEADING = ("Consolas", 10, "bold")

# ── Dimensions ──────────────────────────────────────────────────────
WINDOW_MIN_W = 1200
WINDOW_MIN_H = 800
SIDEBAR_WIDTH = 320          # wider for sprites
CARD_PAD = 8
ANIMATION_DELAY = 16  # ~60fps

# Phase 5: Sort options (BST is default)
SORT_OPTIONS = [
    "BST", "Name", "HP", "Atk", "Def", "SpA", "SpD", "Spe",
]


def ttk_color(turns: int) -> str:
    """Return the color for a given TTK value."""
    if turns <= 0:
        return FG_DIM
    return TTK_COLORS.get(min(turns, 5), TTK_COLORS[5])


def speed_color(advantage: str) -> str:
    """Return the color for a speed advantage label."""
    if advantage in ("a", "us"):
        return SPEED_FASTER
    elif advantage in ("b", "them"):
        return SPEED_SLOWER
    return SPEED_TIE


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Convert hex color to RGB tuple."""
    h = hex_color.lstrip("#")
    return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))  # type: ignore


def make_type_gradient(
    types: list[str],
    width: int = 320,
    height: int = 56,
    direction: str = "horizontal",
) -> Image.Image:
    """Create a gradient background image from one or two Pokemon types.

    For single-type: solid color with slight darkening at edges.
    For dual-type: horizontal gradient from type1 to type2.
    Uses small-image-upscale trick for speed.
    """
    if len(types) >= 2:
        c1 = hex_to_rgb(TYPE_COLORS.get(types[0], "#484f58"))
        c2 = hex_to_rgb(TYPE_COLORS.get(types[1], "#484f58"))
        dark1 = hex_to_rgb(TYPE_COLORS_DARK.get(types[0], "#222830"))
        dark2 = hex_to_rgb(TYPE_COLORS_DARK.get(types[1], "#222830"))
    else:
        c1 = hex_to_rgb(TYPE_COLORS.get(types[0], "#484f58") if types else "#484f58")
        c2 = c1
        dark1 = hex_to_rgb(TYPE_COLORS_DARK.get(types[0], "#222830") if types else "#222830")
        dark2 = dark1

    # Render at tiny size then upscale — massively faster than per-pixel at full res
    small_w, small_h = 10, 10
    small = Image.new("RGB", (small_w, small_h))
    pixels = []
    for y in range(small_h):
        yr = y / max(small_h - 1, 1)
        for x in range(small_w):
            ratio = x / max(small_w - 1, 1)
            # Blend type colors horizontally
            r = int(c1[0] * (1 - ratio) + c2[0] * ratio)
            g = int(c1[1] * (1 - ratio) + c2[1] * ratio)
            b = int(c1[2] * (1 - ratio) + c2[2] * ratio)
            # Dark color for bottom
            dr = int(dark1[0] * (1 - ratio) + dark2[0] * ratio)
            dg = int(dark1[1] * (1 - ratio) + dark2[1] * ratio)
            db = int(dark1[2] * (1 - ratio) + dark2[2] * ratio)
            # Vertical gradient: top color → dark bottom
            fr = int(r * (1 - yr * 0.6) + dr * yr * 0.6)
            fg = int(g * (1 - yr * 0.6) + dg * yr * 0.6)
            fb = int(b * (1 - yr * 0.6) + db * yr * 0.6)
            # Edge vignette (left/right darken)
            edge_dist = min(x, small_w - 1 - x)
            edge_factor = max(0.75, 1.0 - 0.12 * edge_dist / max(small_w // 4, 1))
            pixels.append((int(fr * edge_factor), int(fg * edge_factor), int(fb * edge_factor)))
    small.putdata(pixels)

    # Upscale with bicubic for smooth result
    return small.resize((width, height), Image.Resampling.BICUBIC)
