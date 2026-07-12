# Matchup Calculations - Cache Strategy

## MatchupCache (legacy)

### File
`pokeredus/graph/matchup_cache.py`

### Architecture
- In-memory dict keyed by (attacker_id, defender_id) tuples
- SHA256 fingerprint for automatic invalidation
- JSON serialization on disk

### Fingerprint Components
1. Pokémon IDs (sorted)
2. primary_set_id for each Pokémon
3. Move lists of every set (sorted by set ID)

### Cache Build
- Iterates all Pokémon that have at least one set
- Builds composite set for each species (primary stats + union of all moves)
- Computes best_move for every ordered pair (N × N)
- Progress callback: progress_cb(done, total)

### Cache File
- Default: `CACHE_DIR / "matchup_cache.json"`
- Format: JSON with fingerprint + list of CachedMatchup entries
- Size: ~2 MB for OU tier (~13,924 entries)

### Key Methods
| Method | Description |
|--------|-------------|
| get(attacker_id, defender_id) | O(1) lookup |
| put(matchup) | Insert/overwrite entry |
| get_all_against(defender_id) | All matchups attacking a defender |
| get_all_by(attacker_id) | All matchups by an attacker |
| is_valid(kg) | Check fingerprint match |
| build(kg, calc, progress_cb) | Full cache rebuild |
| save(path) | JSON serialization |
| load(path) | JSON deserialization |
| load_or_build(kg, path, force) | Smart load-or-rebuild |

### CachedMatchup Fields
- attacker_id, defender_id
- turns_to_kill, best_move_id
- damage_per_hit, min_damage, max_damage
- min_ttk, max_ttk
- damage_pct_lo, damage_pct_hi
- type_effectiveness, stab
- move_type, move_category
- offensive_stat, defensive_stat

## SpeciesMatchupCache (newer)

### File
`pokeredus/graph/species_matchup_cache.py`

### Architecture
- Batch cache: one entry per Pokémon containing ALL its matchups
- Hash-based invalidation per Pokémon
- Reverse-direction fill (computes both A→B and B→A from one simulate call)
- Uses primary/star set for both sides

### Hashing
- `_compute_pokemon_sets_hash(pokemon_id)`: hashes all sets for a single Pokémon
  - Includes: set ID, sorted moves, item, ability, nature name, EVs
- `_compute_pool_hash()`: hash of every Pokémon's set composition (lazy, cached)

### Invalidation
- `invalidate_pokemon(pokemon_id)`: clears affected Pokémon + any cache entry that references this opponent
- `invalidate_all()`: clears entire cache + pool hash

### Key Methods
| Method | Description |
|--------|-------------|
| get_all_matchups(pokemon_id) | Returns cached or computes full batch |
| get_matchup(our_id, their_id) | Single matchup from batch cache |
| invalidate_pokemon(pokemon_id) | Partial invalidation |
| invalidate_all() | Full invalidation |
| stats() | Cache statistics |

### Performance
- First access: computes ~N matchups (N = total species) — ~2-3 seconds
- Subsequent access: instant cache hit
- Invalidation: only recomputes affected Pokémon

### Partial Cache Entries
- Marked `complete=False` for reverse-direction stubs
- Short-circuit only on `complete=True` entries
- Ensures full computation when Pokémon is first queried directly

## Caching Strategy Comparison

| Feature | MatchupCache | SpeciesMatchupCache |
|---------|-------------|-------------------|
| Scope | All species pairs | Per-species batch |
| Key | (attacker, defender) | pokemon_id |
| Fingerprint | Full graph SHA256 | Per-Pokémon hash + pool hash |
| Invalidation | Full rebuild | Partial (per Pokémon) |
| Reverse direction | Separate compute | Free (from single simulate) |
| Size | ~13,924 entries | ~118 batches |
| Use case | Analytics, bulk queries | GUI panel, interactive use |