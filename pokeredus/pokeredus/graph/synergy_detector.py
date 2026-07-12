"""
SynergyDetector — identifies strategic synergies between Pokémon.

A synergy exists when multiple Pokémon on a team enable or benefit from
the same game condition. Examples:

- Weather synergy: Multiple Pokémon benefit from Sun (Chlorophyll users + Sun setter)
- Terrain synergy: Multiple Pokémon benefit from Electric Terrain
- Hazard synergy: Hazard setters + Pokémon that force switches
- Status synergy: Status spreaders + Pokémon that exploit status (Facade users)
- Pivot synergy: Slow U-turn/Volt Switch users bringing in fragile sweepers

The detector analyzes:
- Field condition creators (moves/abilities that set weather/terrain)
- Field condition beneficiaries (abilities/moves that benefit from conditions)
- Complementary roles (hazard setter + wallbreaker, pivot + sweeper)

This enables intelligent team building suggestions and matchup prediction
that considers team-level strategy, not just individual Pokémon.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from pokeredus.classes import SetClass, PokemonClass
from pokeredus.graph.knowledge_graph import KnowledgeGraph
from pokeredus.graph.attribute_factory import AttributeFactory


@dataclass
class SynergyLink:
    """A synergy between two or more Pokémon on a team.

    Represents a strategic connection where:
    - creators: Pokémon that enable the condition
    - beneficiaries: Pokémon that benefit from the condition
    - synergy_type: Category (weather, terrain, hazard, status, pivot, etc.)
    - condition: The specific condition (sun, electric_terrain, stealth_rock, etc.)
    - strength: How strong the synergy is (0.0 to 1.0)
    """

    synergy_type: str  # "weather", "terrain", "hazard", "status", "pivot", "role"
    condition: str  # "sun", "electric_terrain", "stealth_rock", etc.
    creators: list[str] = field(default_factory=list)  # set_ids or pokemon_ids
    beneficiaries: list[str] = field(default_factory=list)
    strength: float = 0.0
    description: str = ""

    # Metrics for learning
    times_used: int = 0
    win_rate: float = 0.0

    def includes(self, pokemon_id: str) -> bool:
        """Check if a Pokémon is part of this synergy."""
        return pokemon_id in self.creators or pokemon_id in self.beneficiaries

    def to_dict(self) -> dict:
        return {
            "synergy_type": self.synergy_type,
            "condition": self.condition,
            "creators": list(self.creators),
            "beneficiaries": list(self.beneficiaries),
            "strength": self.strength,
            "description": self.description,
            "times_used": self.times_used,
            "win_rate": self.win_rate,
        }

    @classmethod
    def from_dict(cls, data: dict) -> SynergyLink:
        return cls(
            synergy_type=data["synergy_type"],
            condition=data["condition"],
            creators=data.get("creators", []),
            beneficiaries=data.get("beneficiaries", []),
            strength=data.get("strength", 0.0),
            description=data.get("description", ""),
            times_used=data.get("times_used", 0),
            win_rate=data.get("win_rate", 0.0),
        )


@dataclass
class TeamSynergyProfile:
    """Complete synergy profile for a team.

    Tracks all synergies between team members and identifies:
    - Core strategies (weather, terrain, hazards)
    - Missing pieces (beneficiaries without creators)
    - Redundancy (multiple creators for same condition)
    - Coverage gaps (no answer to common strategies)
    """

    synergies: list[SynergyLink] = field(default_factory=list)
    strategies: list[str] = field(default_factory=list)  # "sun_team", "hazard_stack", etc.
    score: float = 0.0  # Overall synergy score (0.0 to 1.0)

    def add_synergy(self, link: SynergyLink) -> None:
        self.synergies.append(link)

    def get_synergies_for(self, pokemon_id: str) -> list[SynergyLink]:
        """Get all synergies involving a Pokémon."""
        return [s for s in self.synergies if s.includes(pokemon_id)]

    def get_synergies_by_type(self, synergy_type: str) -> list[SynergyLink]:
        """Get all synergies of a specific type."""
        return [s for s in self.synergies if s.synergy_type == synergy_type]

    def has_strategy(self, strategy: str) -> bool:
        return strategy in self.strategies

    def to_dict(self) -> dict:
        return {
            "synergies": [s.to_dict() for s in self.synergies],
            "strategies": list(self.strategies),
            "score": self.score,
        }

    @classmethod
    def from_dict(cls, data: dict) -> TeamSynergyProfile:
        profile = cls(
            synergies=[SynergyLink.from_dict(s) for s in data.get("synergies", [])],
            strategies=data.get("strategies", []),
            score=data.get("score", 0.0),
        )
        return profile


class SynergyDetector:
    """Detects synergies between Pokémon on a team.

    Usage:
        detector = SynergyDetector(factory)
        profile = detector.analyze_team(team_set_ids, kg)

        # Check for weather synergy
        weather_links = profile.get_synergies_by_type("weather")
        for link in weather_links:
            print(f"{link.condition}: {link.creators} → {link.beneficiaries}")
    """

    def __init__(self, factory: AttributeFactory):
        self.factory = factory
        # Pre-compute field creators for fast lookup
        self._field_moves = factory.get_field_creating_moves()
        self._field_abilities = factory.get_field_creating_abilities()

    def analyze_team(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> TeamSynergyProfile:
        """Analyze synergies for a team of Pokémon.

        Args:
            team_set_ids: List of SetClass IDs (up to 6)
            kg: Knowledge graph for lookups

        Returns:
            TeamSynergyProfile with all detected synergies
        """
        profile = TeamSynergyProfile()

        # Analyze each synergy type
        profile.synergies.extend(self._detect_weather_synergies(team_set_ids, kg))
        profile.synergies.extend(self._detect_terrain_synergies(team_set_ids, kg))
        profile.synergies.extend(self._detect_hazard_synergies(team_set_ids, kg))
        profile.synergies.extend(self._detect_status_synergies(team_set_ids, kg))
        profile.synergies.extend(self._detect_pivot_synergies(team_set_ids, kg))

        # Identify core strategies
        profile.strategies = self._identify_strategies(profile)

        # Compute overall synergy score
        profile.score = self._compute_synergy_score(profile)

        return profile

    # ── Weather Synergies ───────────────────────────────────────────

    def _detect_weather_synergies(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> list[SynergyLink]:
        """Detect weather-based synergies."""
        links = []

        # Find weather creators
        for weather_type in ["sun", "rain", "sand", "hail", "snow"]:
            creators = []
            beneficiaries = []

            for set_id in team_set_ids:
                set_obj = kg.get_set(set_id)
                if not set_obj:
                    continue

                # Check if this set creates the weather
                if self._creates_weather(set_obj, weather_type):
                    creators.append(set_id)

                # Check if this set benefits from the weather
                if self._benefits_from_weather(set_obj, weather_type, kg):
                    beneficiaries.append(set_id)

            if creators or beneficiaries:
                strength = self._compute_weather_strength(
                    weather_type, len(creators), len(beneficiaries)
                )
                link = SynergyLink(
                    synergy_type="weather",
                    condition=weather_type,
                    creators=creators,
                    beneficiaries=beneficiaries,
                    strength=strength,
                    description=f"{weather_type.title()} synergy: "
                    f"{len(creators)} creators, {len(beneficiaries)} beneficiaries",
                )
                links.append(link)

        return links

    def _creates_weather(self, set_obj: SetClass, weather: str) -> bool:
        """Check if a set can create a specific weather."""
        # Check abilities
        if set_obj.ability in self._field_abilities.get(weather, []):
            return True
        # Check moves
        for move_id in set_obj.moves:
            if move_id in self._field_moves.get(weather, []):
                return True
        return False

    def _benefits_from_weather(
        self, set_obj: SetClass, weather: str, kg: KnowledgeGraph
    ) -> bool:
        """Check if a set benefits from a specific weather."""
        pokemon = kg.get_pokemon(set_obj.pokemon_id)
        if not pokemon:
            return False

        # Check abilities that benefit from weather
        weather_abilities = {
            "sun": ["chlorophyll", "solarpower", "flowergift", "leafguard"],
            "rain": ["swiftswim", "hydration", "dryskin", "raindish"],
            "sand": ["sandrush", "sandforce", "sandveil"],
            "hail": ["slushrush", "snowcloak", "icebody"],
            "snow": ["slushrush", "snowcloak", "icebody"],
        }

        if set_obj.ability in weather_abilities.get(weather, []):
            return True

        # Check if Pokémon has weather-boosted moves
        weather_types = {
            "sun": "Fire",
            "rain": "Water",
            "sand": "Rock",  # Sand boosts Rock SpD
            "hail": "Ice",
            "snow": "Ice",
        }
        boosted_type = weather_types.get(weather)
        if boosted_type:
            for move_id in set_obj.moves:
                move = kg.get_move(move_id)
                if move and move.type == boosted_type and not move.is_status:
                    return True

        return False

    def _compute_weather_strength(
        self, weather: str, num_creators: int, num_beneficiaries: int
    ) -> float:
        """Compute synergy strength (0.0 to 1.0)."""
        if num_creators == 0:
            return 0.0
        # Base strength from number of beneficiaries
        base = min(1.0, num_beneficiaries / 3.0)
        # Bonus for multiple creators (redundancy)
        if num_creators > 1:
            base += 0.1
        return min(1.0, base)

    # ── Terrain Synergies ───────────────────────────────────────────

    def _detect_terrain_synergies(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> list[SynergyLink]:
        """Detect terrain-based synergies."""
        links = []

        terrain_types = [
            "electric_terrain",
            "grassy_terrain",
            "misty_terrain",
            "psychic_terrain",
        ]

        for terrain in terrain_types:
            creators = []
            beneficiaries = []

            for set_id in team_set_ids:
                set_obj = kg.get_set(set_id)
                if not set_obj:
                    continue

                if self._creates_terrain(set_obj, terrain):
                    creators.append(set_id)

                if self._benefits_from_terrain(set_obj, terrain, kg):
                    beneficiaries.append(set_id)

            if creators or beneficiaries:
                strength = self._compute_terrain_strength(
                    terrain, len(creators), len(beneficiaries)
                )
                link = SynergyLink(
                    synergy_type="terrain",
                    condition=terrain,
                    creators=creators,
                    beneficiaries=beneficiaries,
                    strength=strength,
                    description=f"{terrain.replace('_', ' ').title()} synergy",
                )
                links.append(link)

        return links

    def _creates_terrain(self, set_obj: SetClass, terrain: str) -> bool:
        """Check if a set can create a specific terrain."""
        if set_obj.ability in self._field_abilities.get(terrain, []):
            return True
        for move_id in set_obj.moves:
            if move_id in self._field_moves.get(terrain, []):
                return True
        return False

    def _benefits_from_terrain(
        self, set_obj: SetClass, terrain: str, kg: KnowledgeGraph
    ) -> bool:
        """Check if a set benefits from a specific terrain."""
        terrain_abilities = {
            "electric_terrain": ["surgesurfer"],
            "grassy_terrain": ["grasspelt"],
            "misty_terrain": [],
            "psychic_terrain": ["psychicsurge"],
        }

        if set_obj.ability in terrain_abilities.get(terrain, []):
            return True

        # Check for terrain-boosted moves
        terrain_types = {
            "electric_terrain": "Electric",
            "grassy_terrain": "Grass",
            "psychic_terrain": "Psychic",
        }
        boosted_type = terrain_types.get(terrain)
        if boosted_type:
            for move_id in set_obj.moves:
                move = kg.get_move(move_id)
                if move and move.type == boosted_type and not move.is_status:
                    # Only if grounded (not Flying type or Levitate)
                    pokemon = kg.get_pokemon(set_obj.pokemon_id)
                    if pokemon and not pokemon.has_type("Flying"):
                        if set_obj.ability != "levitate":
                            return True

        return False

    def _compute_terrain_strength(
        self, terrain: str, num_creators: int, num_beneficiaries: int
    ) -> float:
        """Compute terrain synergy strength."""
        if num_creators == 0:
            return 0.0
        base = min(1.0, num_beneficiaries / 2.0)
        return min(1.0, base)

    # ── Hazard Synergies ────────────────────────────────────────────

    def _detect_hazard_synergies(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> list[SynergyLink]:
        """Detect hazard-based synergies (setter + forced switches)."""
        links = []

        hazard_types = ["stealth_rock", "spikes", "toxic_spikes", "sticky_web"]

        for hazard in hazard_types:
            setters = []
            exploiters = []

            for set_id in team_set_ids:
                set_obj = kg.get_set(set_id)
                if not set_obj:
                    continue

                if self._sets_hazard(set_obj, hazard):
                    setters.append(set_id)

                if self._forces_switches(set_obj, kg):
                    exploiters.append(set_id)

            if setters and exploiters:
                strength = min(1.0, len(setters) * 0.3 + len(exploiters) * 0.2)
                link = SynergyLink(
                    synergy_type="hazard",
                    condition=hazard,
                    creators=setters,
                    beneficiaries=exploiters,
                    strength=strength,
                    description=f"{hazard.replace('_', ' ').title()} stacking synergy",
                )
                links.append(link)

        return links

    def _sets_hazard(self, set_obj: SetClass, hazard: str) -> bool:
        """Check if a set can set a specific hazard."""
        for move_id in set_obj.moves:
            if move_id in self._field_moves.get(hazard, []):
                return True
        return False

    def _forces_switches(self, set_obj: SetClass, kg: KnowledgeGraph) -> bool:
        """Check if a set forces switches (via phazing moves or threats)."""
        phazing_moves = ["whirlwind", "roar", "dragontail", "circlethrow"]
        for move_id in set_obj.moves:
            if move_id in phazing_moves:
                return True
        # Could also check for very threatening Pokémon (high damage output)
        return False

    # ── Status Synergies ────────────────────────────────────────────

    def _detect_status_synergies(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> list[SynergyLink]:
        """Detect status-based synergies (spreaders + exploiters)."""
        links = []

        status_types = ["burn", "paralysis", "poison", "toxic", "sleep"]

        for status in status_types:
            spreaders = []
            exploiters = []

            for set_id in team_set_ids:
                set_obj = kg.get_set(set_id)
                if not set_obj:
                    continue

                if self._spreads_status(set_obj, status):
                    spreaders.append(set_id)

                if self._exploits_status(set_obj, status, kg):
                    exploiters.append(set_id)

            if spreaders and exploiters:
                strength = min(1.0, len(spreaders) * 0.4 + len(exploiters) * 0.3)
                link = SynergyLink(
                    synergy_type="status",
                    condition=status,
                    creators=spreaders,
                    beneficiaries=exploiters,
                    strength=strength,
                    description=f"{status.title()} spread synergy",
                )
                links.append(link)

        return links

    def _spreads_status(self, set_obj: SetClass, status: str) -> bool:
        """Check if a set can spread a specific status."""
        status_moves = {
            "burn": ["willowisp", "scald", "lavaplume", "flamewheel"],
            "paralysis": ["thunderwave", "bodyslam", "thunder", "nuzzle"],
            "poison": ["toxic", "poisonpowder", "sludgebomb"],
            "toxic": ["toxic"],
            "sleep": ["sleeppowder", "spore", "hypnosis", "sing", "lovelykiss"],
        }
        for move_id in set_obj.moves:
            if move_id in status_moves.get(status, []):
                return True
        return False

    def _exploits_status(
        self, set_obj: SetClass, status: str, kg: KnowledgeGraph
    ) -> bool:
        """Check if a set exploits a specific status."""
        # Facade users exploit any status
        if "facade" in set_obj.moves:
            return True
        # Guts ability exploits burn/paralysis/poison
        if set_obj.ability == "guts" and status in ["burn", "paralysis", "poison"]:
            return True
        # Synchronize reflects status
        if set_obj.ability == "synchronize":
            return True
        return False

    # ── Pivot Synergies ─────────────────────────────────────────────

    def _detect_pivot_synergies(
        self, team_set_ids: list[str], kg: KnowledgeGraph
    ) -> list[SynergyLink]:
        """Detect pivot synergies (slow U-turn/Volt Switch + fragile sweeper)."""
        links = []

        pivots = []
        sweepers = []

        for set_id in team_set_ids:
            set_obj = kg.get_set(set_id)
            if not set_obj:
                continue

            if self._is_pivot(set_obj, kg):
                pivots.append(set_id)

            if self._is_sweeper(set_obj, kg):
                sweepers.append(set_id)

        if pivots and sweepers:
            strength = min(1.0, len(pivots) * 0.4 + len(sweepers) * 0.3)
            link = SynergyLink(
                synergy_type="pivot",
                condition="slow_pivot",
                creators=pivots,
                beneficiaries=sweepers,
                strength=strength,
                description=f"Pivot synergy: {len(pivots)} pivots, {len(sweepers)} sweepers",
            )
            links.append(link)

        return links

    def _is_pivot(self, set_obj: SetClass, kg: KnowledgeGraph) -> bool:
        """Check if a set is a pivot (has U-turn/Volt Switch)."""
        pivot_moves = ["uturn", "voltswitch", "flipturn", "partingshot"]
        for move_id in set_obj.moves:
            if move_id in pivot_moves:
                return True
        return False

    def _is_sweeper(self, set_obj: SetClass, kg: KnowledgeGraph) -> bool:
        """Check if a set is a sweeper (setup + high damage)."""
        setup_moves = [
            "swordsdance",
            "dragondance",
            "nastyplot",
            "calmmind",
            "quiverdance",
            "shellsmash",
        ]
        for move_id in set_obj.moves:
            if move_id in setup_moves:
                return True
        # Could also check for high offensive stats
        return False

    # ── Strategy Identification ─────────────────────────────────────

    def _identify_strategies(self, profile: TeamSynergyProfile) -> list[str]:
        """Identify core strategies from synergies."""
        strategies = []

        # Weather strategies
        weather_links = profile.get_synergies_by_type("weather")
        for link in weather_links:
            if link.strength >= 0.5:
                strategies.append(f"{link.condition}_team")

        # Terrain strategies
        terrain_links = profile.get_synergies_by_type("terrain")
        for link in terrain_links:
            if link.strength >= 0.5:
                strategies.append(f"{link.condition}_team")

        # Hazard stacking
        hazard_links = profile.get_synergies_by_type("hazard")
        if len(hazard_links) >= 2:
            strategies.append("hazard_stack")

        # Status spread
        status_links = profile.get_synergies_by_type("status")
        if len(status_links) >= 2:
            strategies.append("status_spread")

        # Pivot core
        pivot_links = profile.get_synergies_by_type("pivot")
        if pivot_links and pivot_links[0].strength >= 0.5:
            strategies.append("pivot_core")

        return strategies

    def _compute_synergy_score(self, profile: TeamSynergyProfile) -> float:
        """Compute overall synergy score (0.0 to 1.0)."""
        if not profile.synergies:
            return 0.0

        # Average strength of all synergies, weighted by type
        weights = {
            "weather": 1.2,
            "terrain": 1.1,
            "hazard": 1.0,
            "status": 0.9,
            "pivot": 1.0,
        }

        total_weight = 0.0
        weighted_sum = 0.0

        for link in profile.synergies:
            weight = weights.get(link.synergy_type, 1.0)
            weighted_sum += link.strength * weight
            total_weight += weight

        if total_weight == 0:
            return 0.0

        return min(1.0, weighted_sum / total_weight)

    def __repr__(self) -> str:
        return f"SynergyDetector({self.factory.summary()})"
