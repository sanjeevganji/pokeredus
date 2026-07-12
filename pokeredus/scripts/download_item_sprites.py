"""Download item sprites for PokeRedus.

Sources: PokeAPI sprites repo (https://github.com/PokeAPI/sprites/tree/master/sprites/items).
URLs use hyphenated ids, e.g. https://.../items/life-orb.png. The ids
match the smogon/showdown slugs we use internally, so no remapping needed.

Two pools are downloaded:
  1. SET ITEMS — every item id used by any set in the knowledge graph.
  2. COMMON BATTLE ITEMS — competitive staples, berries, type-boosters,
     Z-crystals, mega stones, plates, etc. — pre-cached for future use
     (custom team building, set editor item dropdown, etc.).

PokeAPI's sprite repo is mostly complete for gen 1-7 items and most of
gen 8-9, but a handful of brand-new items (booster-energy, loaded-dice,
covert-cloak, eject-pack, heavy-duty-boots, throat-spray, and the
Ogerpon masks) are NOT in the repo. Those will be reported as misses
and skipped — they remain as the existing text placeholder in the UI.

Run:  .venv/Scripts/python scripts/download_item_sprites.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# Make project root importable when run directly
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pokeredus.config import GRAPHS_DIR
from pokeredus.gui.sprites import (
    ITEM_SPRITE_BASE_URL,
    ITEM_SPRITE_CACHE_DIR,
    SpriteManager,
)


# ── Set items: every distinct item id present in any set ─────────────

def collect_set_item_ids() -> list[str]:
    """Scan the current graph and return all unique set item ids."""
    from pokeredus.graph.knowledge_graph import KnowledgeGraph

    graph_path = GRAPHS_DIR / "ou_matchup_graph.json"
    if not graph_path.exists():
        print(f"  Graph not found at {graph_path} — run build_graph.py first.")
        return []
    kg = KnowledgeGraph.load(graph_path)
    items: set[str] = set()
    for s in kg.get_all_sets():
        if s.item:
            items.add(s.item)
    return sorted(items)


# ── Common battle items for future use ───────────────────────────────

COMMON_BATTLE_ITEMS: list[str] = [
    # ── Choice items
    "choice-band", "choice-scarf", "choice-specs",
    # ── Life Orb / Expert Belt
    "life-orb", "expert-belt",
    # ── Type-boosting items (gen 1-5)
    "charcoal", "mystic-water", "miracle-seed", "twisted-spoon", "magnet",
    "hard-stone", "soft-sand", "sharp-beak", "poison-barb", "silver-powder",
    "spell-tag", "dragon-fang", "black-belt", "pink-bow", "polkadot-bow",
    "sea-incense", "rose-incense", "wave-incense", "odd-incense",
    "rock-incense", "pure-incense", "luck-incense", "full-incense", "lax-incense",
    "silk-scarf",
    # ── Status / pinch berries
    "oran-berry", "figy-berry", "wiki-berry", "mago-berry", "aguav-berry",
    "iapapa-berry", "razz-berry", "bluk-berry", "nanab-berry", "wepear-berry",
    "pinap-berry", "pomeg-berry", "kelpsy-berry", "qualot-berry", "hondew-berry",
    "grepa-berry", "tamato-berry", "liechi-berry", "ganlon-berry", "salac-berry",
    "petaya-berry", "apicot-berry", "lansat-berry", "starf-berry", "enigma-berry",
    "jaboca-berry", "rowap-berry", "kee-berry", "maranga-berry", "custap-berry",
    "lum-berry", "sitrus-berry",
    # ── Type-resist berries
    "charti-berry", "chilan-berry", "occa-berry", "passho-berry", "wacan-berry",
    "rindo-berry", "yache-berry", "chople-berry", "kebia-berry", "shuca-berry",
    "coba-berry", "payapa-berry", "tanga-berry", "kasib-berry", "haban-berry",
    "colbur-berry", "babiri-berry", "roseli-berry",
    # ── Defensive / utility
    "heavy-duty-boots", "leftovers", "rocky-helmet", "air-balloon", "eviolite",
    "assault-vest", "eject-button", "eject-pack", "red-card", "big-root",
    "shed-shell", "binding-band", "grip-claw", "protective-pads", "safety-goggles",
    "utility-umbrella", "ability-shield", "clear-amulet", "covert-cloak",
    "light-clay", "black-sludge",
    # ── Boosters / pinch
    "muscle-band", "wise-glasses", "scope-lens", "wide-lens", "punching-glove",
    "metronome", "throat-spray", "loaded-dice", "booster-energy", "weakness-policy",
    "absorbbulb", "cell-battery", "luminous-moss", "snowball", "adrenaline-orb",
    "blunder-policy", "roomservice", "mirror-herb", "terrain-extender",
    # ── Terrain / weather extenders
    "damp-rock", "smooth-rock", "heat-rock", "icy-rock",
    # ── Seeds
    "electric-seed", "misty-seed", "psychic-seed", "grassy-seed",
    # ── Status orbs
    "flame-orb", "toxic-orb", "burnt-berry", "ice-berry", "mystery-berry",
    "berry-juice",
    # ── Mega stones
    "venusaurite", "charizardite-x", "charizardite-y", "blastoisinite",
    "beedrillite", "pidgeotite", "alakazite", "gengarite", "kangaskhanite",
    "pinsirite", "gyaradosite", "aerodactylite", "ampharosite", "scizorite",
    "heracronite", "houndoominite", "tyranitarite", "blazikenite",
    "gardevoirite", "mawilite", "aggronite", "medichamite", "manectite",
    "sharpedonite", "cameruptite", "altarianite", "banettite", "absolite",
    "glalitite", "salamencite", "metagrossite", "latiasite", "latiosite",
    "rayquazite", "garchompite", "lucarioite", "abomasnowite", "galladite",
    "audinite", "diancite",
    # ── Z-Crystals
    "normalium-z", "firium-z", "waterium-z", "electrium-z", "grassium-z",
    "icium-z", "fightinium-z", "poisonium-z", "groundium-z", "flyinium-z",
    "psychium-z", "buginium-z", "rockium-z", "ghostium-z", "dragonium-z",
    "darkinium-z", "steelium-z", "fairium-z", "pikanium-z", "eevium-z",
    "snorlium-z", "mewnium-z", "decidium-z", "incinium-z", "primarium-z",
    "tapunium-z", "marshadium-z", "raltsium-z", "kommonium-z", "lunalium-z",
    "solgalium-z", "ultranecrozium-z", "mimikium-z", "lycanium-z",
    # ── Plates
    "flame-plate", "splash-plate", "meadow-plate", "zap-plate", "icicle-plate",
    "fist-plate", "toxic-plate", "earth-plate", "sky-plate", "mind-plate",
    "insect-plate", "stone-plate", "spooky-plate", "draco-plate", "dread-plate",
    "iron-plate", "pixie-plate",
    # ── Memories
    "fire-memory", "water-memory", "electric-memory", "grass-memory",
    "ice-memory", "fighting-memory", "poison-memory", "ground-memory",
    "flying-memory", "psychic-memory", "bug-memory", "rock-memory",
    "ghost-memory", "dragon-memory", "dark-memory", "steel-memory", "fairy-memory",
    # ── Drives
    "burn-drive", "chill-drive", "douse-drive", "shock-drive",
    # ── Held items (evos / form change)
    "deep-sea-tooth", "deep-sea-scale", "thick-club", "light-ball",
    "lucky-punch", "stick", "metal-powder", "quick-powder", "soul-dew",
    "dragon-claw", "up-grade", "dubious-disc", "protector", "electirizer",
    "magmarizer", "reaper-cloth", "razor-claw", "razor-fang", "prism-scale",
    "oval-stone", "reaper-cloth", "razor-claw", "sweet-apple", "tart-apple",
    "cracked-pot", "chipped-pot", "galarica-cuff", "galarica-wreath",
    "wishing-piece", "rusted-sword", "rusted-shield", "leaden-ball",
    "lagging-tail", "sticky-barb", "iron-ball",
    # ── Fossils (held items that revive)
    "armor-fossil", "claw-fossil", "cover-fossil", "plume-fossil",
    "skull-fossil", "helix-fossil", "dome-fossil", "old-amber", "root-fossil",
    "jaw-fossil", "sail-fossil", "bird-fossil", "fish-fossil", "drake-fossil",
    # ── Misc useful
    "ring-target", "smoke-ball", "lucky-egg", "amulet-coin", "soothe-bell",
    "cleanse-tag", "exp-share", "spell-tag", "never-melt-ice", "black-glasses",
    "mental-herb", "power-herb", "red-card", "eject-button", "focus-sash",
    "focus-band", "shell-bell", "choice-band",
    # ── Healing (battle items)
    "potion", "super-potion", "hyper-potion", "max-potion", "full-restore",
    "full-heal", "revive", "max-revive", "sacred-ash", "ether", "max-ether",
    "elixir", "max-elixir", "antidote", "burn-heal", "ice-heal", "awakening",
    "paralyze-heal", "repel", "max-repel", "honey",
    # ── Pokeballs
    "poke-ball", "great-ball", "ultra-ball", "master-ball", "safari-ball",
    "net-ball", "dive-ball", "nest-ball", "repeat-ball", "timer-ball",
    "luxury-ball", "premier-ball", "dusk-ball", "heal-ball", "quick-ball",
    "cherish-ball", "dream-ball", "beast-ball", "park-ball", "fast-ball",
    "level-ball", "lure-ball", "heavy-ball", "love-ball", "friend-ball",
    "moon-ball", "sport-ball", "gs-ball",
    # ── Training items
    "rare-candy", "pp-up", "pp-max", "hp-up", "protein", "iron", "calcium",
    "zinc", "carbos", "health-wing", "muscle-wing", "resist-wing",
    "genius-wing", "clever-wing", "swift-wing", "pretty-wing",
    "bottle-cap", "gold-bottle-cap", "ability-capsule", "ability-patch",
    # ── Ogerpon masks (will likely miss in PokeAPI, listed for completeness)
    "cornerstone-mask", "wellspring-mask", "hearthflame-mask",
    # ── Other gen-9 items likely missing in PokeAPI
    "syrupy-apple", "durin-berry", "spelon-berry", "coban-berry",
]


# ── Download logic ───────────────────────────────────────────────────

def download_all(
    item_ids: list[str], label: str, rate_delay: float = 0.05,
) -> tuple[list[str], list[str]]:
    """Download all items in *item_ids* that are not yet cached.

    Returns (downloaded, missing) lists.
    """
    mgr = SpriteManager()
    downloaded: list[str] = []
    missing: list[str] = []
    total = len(item_ids)
    print(f"\n[{label}] {total} items to process")
    print(f"  Source: {ITEM_SPRITE_BASE_URL}/<id>.png")
    print(f"  Cache:  {ITEM_SPRITE_CACHE_DIR}")

    for i, iid in enumerate(item_ids, 1):
        if not iid:
            continue
        if mgr.has_item_sprite(iid):
            downloaded.append(iid)
            continue
        ok = mgr._download_item_sprite(iid)
        if ok:
            downloaded.append(iid)
        else:
            missing.append(iid)
        # Light progress every 25
        if i % 25 == 0 or i == total:
            print(f"  [{i:3d}/{total}] {len(downloaded):3d} ok, {len(missing):3d} miss")
        # Polite delay — PokeAPI raw github isn't aggressively rate-limited
        # but we should be friendly
        if rate_delay > 0 and not ok:
            time.sleep(rate_delay)
    return downloaded, missing


def main() -> int:
    print("=" * 60)
    print("PokeRedus Item Sprite Downloader")
    print("=" * 60)

    # Ensure cache dir exists
    ITEM_SPRITE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Set items (from graph)
    set_ids = collect_set_item_ids()
    if not set_ids:
        print("No set items found.")
    set_ok, set_miss = download_all(set_ids, "SET ITEMS", rate_delay=0)

    # ── 2. Common battle items (for future use)
    common_ids = sorted(set(COMMON_BATTLE_ITEMS))
    common_ok, common_miss = download_all(common_ids, "COMMON BATTLE ITEMS", rate_delay=0)

    # ── Summary
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    mgr = SpriteManager()
    total_cached = mgr.item_cache_count()
    print(f"Total item sprites now cached: {total_cached}")
    print()
    print(f"SET ITEMS:      {len(set_ok):3d} ok, {len(set_miss):3d} miss")
    if set_miss:
        print(f"  Missing (kept as text placeholder in UI):")
        for iid in set_miss:
            print(f"    - {iid}")
    print()
    print(f"COMMON BATTLE:  {len(common_ok):3d} ok, {len(common_miss):3d} miss")
    if common_miss:
        print(f"  Missing (not in PokeAPI sprite repo):")
        # Show first 20
        for iid in common_miss[:20]:
            print(f"    - {iid}")
        if len(common_miss) > 20:
            print(f"    ... and {len(common_miss) - 20} more")

    # Persist a manifest for diagnostics
    manifest = {
        "set_items": {
            "downloaded": set_ok,
            "missing": set_miss,
        },
        "common_battle_items": {
            "downloaded": common_ok,
            "missing": common_miss,
        },
        "total_cached": total_cached,
    }
    manifest_path = Path(__file__).resolve().parent.parent / "data" / "items_sprite_manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    print(f"\nManifest written: {manifest_path}")

    # Exit 0 even with misses — they are expected for newest gen 9 items
    return 0


if __name__ == "__main__":
    sys.exit(main())
