"""
PokeRedus configuration.

Centralizes tier settings, data paths, and application constants.
All paths are relative to the project root (pokeredus/).
"""

from pathlib import Path

# ── Tier ────────────────────────────────────────────────────────────
TIER: str = "gen9ou"
TIER_DISPLAY: str = "Gen 9 OU"

# ── Paths ───────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
RAW_DATA_DIR = DATA_DIR / "raw"
SETS_DIR = DATA_DIR / "sets"
GRAPHS_DIR = DATA_DIR / "graphs"
TEAMS_DIR = DATA_DIR / "teams"
CACHE_DIR = DATA_DIR / "cache"
CONFIG_DIR = DATA_DIR / "config"

# ── Showdown data file names (inside RAW_DATA_DIR) ─────────────────
POKEDEX_FILE = "pokedex.json"
MOVES_FILE = "moves.json"
ABILITIES_FILE = "abilities.json"
ITEMS_FILE = "items.json"
NATURES_FILE = "natures.json"
TYPECHART_FILE = "typechart.json"

# ── Matchup engine defaults ────────────────────────────────────────
DEFAULT_MATCHUP_CONFIDENCE: float = 0.5   # type-calc only, no battle data yet
MIN_MATCHUP_CONFIDENCE: float = 0.1       # floor for inclusion in graph
MAX_MATCHUP_SAMPLE_COUNT: int = 0         # no battle data at startup

# ── GUI defaults ────────────────────────────────────────────────────
GUI_WINDOW_TITLE: str = "PokeRedus — OU Intelligence Builder"
GUI_WINDOW_WIDTH: int = 1200
GUI_WINDOW_HEIGHT: int = 800
GUI_THEME: str = "clam"  # ttk theme

# ── Pokémon constants ───────────────────────────────────────────────
POKEMON_TYPES: list[str] = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice",
    "Fighting", "Poison", "Ground", "Flying", "Psychic", "Bug",
    "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]

STAT_NAMES: list[str] = ["hp", "atk", "def", "spa", "spd", "spe"]
STAT_LABELS: dict[str, str] = {
    "hp": "HP", "atk": "Atk", "def": "Def",
    "spa": "SpA", "spd": "SpD", "spe": "Spe",
}

ROLES: list[str] = [
    "sweeper", "wall", "pivot", "wallbreaker",
    "stallbreaker", "hazard_setter", "hazard_remover",
    "cleric", "revenge_killer", "setup_sweeper",
    "offensive_pivot", "defensive_pivot", "tank",
]

DEFAULT_IV: int = 31
MAX_EV_PER_STAT: int = 252
MAX_EV_TOTAL: int = 508
