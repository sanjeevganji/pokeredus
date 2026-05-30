"""
Sprite manager — download, cache, and serve Pokémon sprites.

Sprites are sourced from the gen-9-sprites GitHub repo:
https://github.com/remokon/gen-9-sprites/tree/main/gen-9-style

Downloaded PNGs are cached locally under data/sprites/ and converted
to tkinter PhotoImage objects at configurable sizes.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import TYPE_CHECKING

import requests
from PIL import Image, ImageTk

if TYPE_CHECKING:
    import tkinter as tk

# ── Config ───────────────────────────────────────────────────────────

SPRITE_BASE_URL = (
    "https://raw.githubusercontent.com/remokon/gen-9-sprites/main/gen-9-style"
)
SPRITE_CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "sprites"

# Display sizes
SPRITE_LIST_SIZE = (56, 56)      # large icon in sidebar list
SPRITE_DETAIL_SIZE = (96, 96)    # detail panel
SPRITE_MATCHUP_SIZE = (32, 32)   # small icon in matchup rows

# Name mapping overrides: api_name -> sprite filename (without .png)
# Handle naming mismatches between our data and the sprite repo
_NAME_OVERRIDES: dict[str, str] = {
    "arcanine-hisui": "arcanine-hisuian",
    "avalugg-hisui": "avalugg-hisuian",
    "braviary-hisui": "braviary-hisuian",
    "decidueye-hisui": "decidueye-hisuian",
    "enamorus-incarnate": "enamorus",
    "goodra-hisui": "goodra-hisuian",
    "growlithe-hisui": "growlithe-hisuian",
    "kabutops": "kabutops",
    "kleavor": "kleavor",
    "lilligant-hisui": "lilligant-hisuian",
    "qwilfish-hisui": "qwilfish-hisuian",
    "samurott-hisui": "samurott-hisuian",
    "sliggoo-hisui": "sliggoo-hisuian",
    "sneasel-hisui": "sneasel-hisuian",
    "ursaluna": "ursaluna",
    "ursaluna-bloodmoon": "ursaluna-bloodmoon",
    "voltorb-hisui": "voltorb-hisuian",
    "wooper-paldea": "wooper-paldean",
    "zoroark-hisui": "zoroark-hisuian",
    "zorua-hisui": "zorua-hisuian",
    "deoxys-speed": "deoxys-speed",
}


class SpriteManager:
    """Manages Pokémon sprite downloading, caching, and display."""

    def __init__(self, cache_dir: Path | str | None = None):
        self._cache_dir = Path(cache_dir) if cache_dir else SPRITE_CACHE_DIR
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        # PIL Image cache: api_name -> {size: ImageTk.PhotoImage}
        self._photo_cache: dict[str, dict[tuple[int, int], ImageTk.PhotoImage]] = {}

        # Raw PIL images cache
        self._pil_cache: dict[str, Image.Image] = {}

        # Track download state
        self._downloading: set[str] = set()
        self._failed: set[str] = set()

    # ── Public API ──────────────────────────────────────────────────

    def get_sprite(
        self, api_name: str, size: tuple[int, int] = SPRITE_LIST_SIZE
    ) -> ImageTk.PhotoImage | None:
        """Get a sprite PhotoImage for the given pokemon API name.

        Returns None if the sprite is not available (yet).
        Caches the result for subsequent calls at the same size.
        """
        # Check photo cache
        if api_name in self._photo_cache:
            size_cache = self._photo_cache[api_name]
            if size in size_cache:
                return size_cache[size]

        # Load raw PIL image
        pil_img = self._load_pil(api_name)
        if pil_img is None:
            return None

        # Resize and convert
        resized = pil_img.resize(size, Image.Resampling.LANCZOS)
        photo = ImageTk.PhotoImage(resized)

        # Cache
        if api_name not in self._photo_cache:
            self._photo_cache[api_name] = {}
        self._photo_cache[api_name][size] = photo

        return photo

    def get_sprite_or_placeholder(
        self, api_name: str, size: tuple[int, int] = SPRITE_LIST_SIZE
    ) -> ImageTk.PhotoImage:
        """Get a sprite or return a placeholder."""
        sprite = self.get_sprite(api_name, size)
        if sprite is not None:
            return sprite
        return self._make_placeholder(size)

    def download_missing(self, api_names: list[str], callback=None) -> None:
        """Download sprites that aren't cached yet. Runs in background thread."""
        missing = [
            name for name in api_names
            if not self._sprite_path(name).exists()
            and name not in self._downloading
            and name not in self._failed
        ]
        if not missing:
            if callback:
                callback(0)
            return

        def _download():
            downloaded = 0
            for name in missing:
                self._downloading.add(name)
                try:
                    if self._download_sprite(name):
                        downloaded += 1
                except Exception:
                    self._failed.add(name)
                finally:
                    self._downloading.discard(name)
            if callback:
                callback(downloaded)

        thread = threading.Thread(target=_download, daemon=True)
        thread.start()

    def download_all(self, api_names: list[str], callback=None) -> None:
        """Force-download all sprites (even if cached)."""
        def _download():
            count = 0
            for name in api_names:
                try:
                    if self._download_sprite(name, force=True):
                        count += 1
                except Exception:
                    pass
            if callback:
                callback(count)

        thread = threading.Thread(target=_download, daemon=True)
        thread.start()

    def is_cached(self, api_name: str) -> bool:
        return self._sprite_path(api_name).exists()

    def cache_count(self) -> int:
        return len(list(self._cache_dir.glob("*.png")))

    def clear_cache(self) -> None:
        self._photo_cache.clear()
        self._pil_cache.clear()

    # ── Internal ────────────────────────────────────────────────────

    def _sprite_filename(self, api_name: str) -> str:
        """Map api_name to the sprite repo filename."""
        return _NAME_OVERRIDES.get(api_name, api_name) + ".png"

    def _sprite_path(self, api_name: str) -> Path:
        return self._cache_dir / self._sprite_filename(api_name)

    def _download_sprite(self, api_name: str, force: bool = False) -> bool:
        """Download a single sprite. Returns True if successful."""
        path = self._sprite_path(api_name)
        if path.exists() and not force:
            return True

        filename = self._sprite_filename(api_name)
        url = f"{SPRITE_BASE_URL}/{filename}"

        resp = requests.get(url, timeout=10)
        if resp.status_code != 200:
            # Try without the override
            alt_filename = api_name + ".png"
            alt_url = f"{SPRITE_BASE_URL}/{alt_filename}"
            resp = requests.get(alt_url, timeout=10)
            if resp.status_code != 200:
                return False

        path.write_bytes(resp.content)
        return True

    def _load_pil(self, api_name: str) -> Image.Image | None:
        """Load a sprite as a PIL Image from cache."""
        if api_name in self._pil_cache:
            return self._pil_cache[api_name]

        path = self._sprite_path(api_name)
        if not path.exists():
            return None

        try:
            img = Image.open(path).convert("RGBA")
            self._pil_cache[api_name] = img
            return img
        except Exception:
            return None

    def _make_placeholder(self, size: tuple[int, int]) -> ImageTk.PhotoImage:
        """Create a simple placeholder image."""
        img = Image.new("RGBA", size, (28, 35, 51, 255))  # BG_CARD color
        return ImageTk.PhotoImage(img)


# ── Module-level instance ────────────────────────────────────────────

_manager: SpriteManager | None = None


def get_sprite_manager() -> SpriteManager:
    global _manager
    if _manager is None:
        _manager = SpriteManager()
    return _manager
