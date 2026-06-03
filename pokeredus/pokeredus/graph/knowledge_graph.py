"""
KnowledgeGraph — NetworkX-backed container for the PokeRedus knowledge graph.

Stores Pokémon species, sets, moves, abilities, items, and matchup relations
as typed nodes and edges in a directed multigraph.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import networkx as nx

from pokeredus.classes import (
    PokemonClass, SetClass, MoveClass, AbilityClass, ItemClass,
    NatureClass, EVSpreadClass, MatchupRelation,
)


class KnowledgeGraph:
    """Central knowledge graph backed by a NetworkX DiGraph.

    Node types are stored as the ``node_type`` attribute:
        "pokemon", "set", "move", "ability", "item", "nature", "type"

    Edge types are stored as the ``edge_type`` attribute:
        "has_type", "has_move", "has_ability", "holds_item",
        "has_nature", "has_ev_spread", "matchup"
    """

    def __init__(self) -> None:
        self.graph = nx.DiGraph()
        # Secondary indexes for fast lookups
        self._pokemon_index: dict[str, PokemonClass] = {}
        self._set_index: dict[str, SetClass] = {}
        self._move_index: dict[str, MoveClass] = {}
        self._ability_index: dict[str, AbilityClass] = {}
        self._item_index: dict[str, ItemClass] = {}
        self._nature_index: dict[str, NatureClass] = {}

    # ────────────────────────────────────────────────────────────────
    # Add nodes
    # ────────────────────────────────────────────────────────────────

    def add_pokemon(self, pokemon: PokemonClass) -> None:
        """Add a Pokémon species node and its has_type edges."""
        self.graph.add_node(pokemon.id, node_type="pokemon", data=pokemon.to_dict())
        self._pokemon_index[pokemon.id] = pokemon

        for type_name in pokemon.types:
            type_id = f"type:{type_name.lower()}"
            if not self.graph.has_node(type_id):
                self.graph.add_node(type_id, node_type="type", data={"name": type_name})
            self.graph.add_edge(pokemon.id, type_id, edge_type="has_type")

    def add_move(self, move: MoveClass) -> None:
        """Add a move node."""
        self.graph.add_node(move.id, node_type="move", data=move.to_dict())
        self._move_index[move.id] = move

    def add_ability(self, ability: AbilityClass) -> None:
        """Add an ability node."""
        self.graph.add_node(ability.id, node_type="ability", data=ability.to_dict())
        self._ability_index[ability.id] = ability

    def add_item(self, item: ItemClass) -> None:
        """Add an item node."""
        self.graph.add_node(item.id, node_type="item", data=item.to_dict())
        self._item_index[item.id] = item

    def add_nature(self, nature: NatureClass) -> None:
        """Add a nature node."""
        nid = nature.id
        self.graph.add_node(nid, node_type="nature", data=nature.to_dict())
        self._nature_index[nid] = nature

    def add_set(self, set_obj: SetClass) -> None:
        """Add a set node and edges to its pokemon, moves, ability, item, nature."""
        self.graph.add_node(set_obj.id, node_type="set", data=set_obj.to_dict())
        self._set_index[set_obj.id] = set_obj

        # Edge to parent Pokémon
        if self.graph.has_node(set_obj.pokemon_id):
            self.graph.add_edge(set_obj.id, set_obj.pokemon_id, edge_type="is_set_of")

        # Edges to moves
        for move_id in set_obj.moves:
            if not self.graph.has_node(move_id):
                self.graph.add_node(move_id, node_type="move", data={"id": move_id})
            self.graph.add_edge(set_obj.id, move_id, edge_type="has_move")

        # Edge to ability
        ability_id = set_obj.ability
        if not self.graph.has_node(ability_id):
            self.graph.add_node(ability_id, node_type="ability", data={"id": ability_id})
        self.graph.add_edge(set_obj.id, ability_id, edge_type="has_ability")

        # Edge to item
        item_id = set_obj.item
        if not self.graph.has_node(item_id):
            self.graph.add_node(item_id, node_type="item", data={"id": item_id})
        self.graph.add_edge(set_obj.id, item_id, edge_type="holds_item")

        # Edge to nature
        nature_id = set_obj.nature.id
        if not self.graph.has_node(nature_id):
            self.add_nature(set_obj.nature)
        self.graph.add_edge(set_obj.id, nature_id, edge_type="has_nature")

    def add_matchup(self, matchup: MatchupRelation) -> None:
        """Add or update a matchup edge between two set nodes."""
        self.graph.add_edge(
            matchup.set_a_id,
            matchup.set_b_id,
            edge_type="matchup",
            data=matchup.to_dict(),
            weight=matchup.score,
        )

    # ────────────────────────────────────────────────────────────────
    # Getters
    # ────────────────────────────────────────────────────────────────

    def get_pokemon(self, pokemon_id: str) -> PokemonClass | None:
        return self._pokemon_index.get(pokemon_id)

    def get_set(self, set_id: str) -> SetClass | None:
        return self._set_index.get(set_id)

    def get_move(self, move_id: str) -> MoveClass | None:
        return self._move_index.get(move_id)

    def get_ability(self, ability_id: str) -> AbilityClass | None:
        return self._ability_index.get(ability_id)

    def get_item(self, item_id: str) -> ItemClass | None:
        return self._item_index.get(item_id)

    def get_nature(self, nature_id: str) -> NatureClass | None:
        return self._nature_index.get(nature_id)

    def get_sets(self, pokemon_id: str) -> list[SetClass]:
        """Return all sets belonging to a Pokémon species."""
        return [s for s in self._set_index.values() if s.pokemon_id == pokemon_id]

    # ────────────────────────────────────────────────────────────────
    # Primary set management
    # ────────────────────────────────────────────────────────────────

    def get_primary_set(self, pokemon_id: str) -> SetClass | None:
        """Return the primary competitive set for a Pokémon, or None.

        Looks up ``primary_set_id`` on the PokemonClass node and resolves it
        to a SetClass instance.  Returns *None* if the pokemon has no
        primary_set_id set or the referenced set does not exist.
        """
        pokemon = self.get_pokemon(pokemon_id)
        if pokemon is None:
            return None
        if not pokemon.primary_set_id:
            return None
        return self.get_set(pokemon.primary_set_id)

    def set_primary_set(self, pokemon_id: str, set_id: str) -> None:
        """Mark *set_id* as the primary competitive set for *pokemon_id*.

        Updates the in-memory PokemonClass object **and** the corresponding
        graph node's ``data`` dict so that persistence round-trips preserve
        the association.

        Raises ``KeyError`` if the pokemon or set does not exist in the graph.
        """
        pokemon = self.get_pokemon(pokemon_id)
        if pokemon is None:
            raise KeyError(f"Pokemon {pokemon_id!r} not found in graph")
        set_obj = self.get_set(set_id)
        if set_obj is None:
            raise KeyError(f"Set {set_id!r} not found in graph")
        if set_obj.pokemon_id != pokemon_id:
            raise ValueError(
                f"Set {set_id!r} belongs to {set_obj.pokemon_id!r}, "
                f"not {pokemon_id!r}"
            )

        pokemon.primary_set_id = set_id

        # Persist to graph node data
        if self.graph.has_node(pokemon_id):
            self.graph.nodes[pokemon_id]["data"] = pokemon.to_dict()

    def get_union_move_pool(self, pokemon_id: str) -> list[str]:
        """Return the deduplicated union of all moves across every set.

        Move order is preserved: moves that appear earlier in the first set
        where they are encountered come first.  At most 4 moves per set are
        considered (the standard Pokémon limit).
        """
        seen: set[str] = set()
        moves: list[str] = []
        for s in self.get_sets(pokemon_id):
            for move in s.moves:
                if move not in seen:
                    seen.add(move)
                    moves.append(move)
        return moves

    def build_composite_set(self, pokemon_id: str) -> SetClass | None:
        """Build a *composite* set that merges moves from every set.

        The composite set inherits **all** non-move fields (ability, item,
        nature, EVs, IVs, role, tera_type) from the Pokémon's **primary set**
        (see :meth:`get_primary_set`).  Its ``moves`` list is the union of
        every set's moves (see :meth:`get_union_move_pool`).

        If no primary set is configured the **first** set returned by
        :meth:`get_sets` is used as the base.  Returns *None* when the
        Pokémon has no sets at all.

        The composite set's ID is ``"{pokemon_id}__composite"``.
        """
        sets = self.get_sets(pokemon_id)
        if not sets:
            return None

        # Choose base set: primary if available, otherwise the first one
        base = self.get_primary_set(pokemon_id) or sets[0]
        union_moves = self.get_union_move_pool(pokemon_id)

        return SetClass(
            id=f"{pokemon_id}__composite",
            pokemon_id=pokemon_id,
            set_name="Composite",
            ability=base.ability,
            item=base.item,
            nature=base.nature,
            evs=base.evs,
            moves=union_moves,
            ivs=dict(base.ivs),
            role=base.role,
            tera_type=base.tera_type,
        )

    def get_ou_pokemon(self) -> list[PokemonClass]:
        """Return all Pokémon in the configured tier (OU)."""
        from pokeredus.config import TIER
        tier_suffix = TIER.replace("gen9", "").lower()  # "gen9ou" → "ou"
        return [
            p for p in self._pokemon_index.values()
            if p.tier.lower() in (tier_suffix, "ou")
        ]

    def get_all_sets(self) -> list[SetClass]:
        return list(self._set_index.values())

    def get_all_pokemon(self) -> list[PokemonClass]:
        return list(self._pokemon_index.values())

    def get_all_moves(self) -> list[MoveClass]:
        return list(self._move_index.values())

    def get_all_items(self) -> list[ItemClass]:
        return list(self._item_index.values())

    # ────────────────────────────────────────────────────────────────
    # Matchup queries
    # ────────────────────────────────────────────────────────────────

    def get_matchups(self, set_id: str, min_confidence: float = 0.0) -> list[MatchupRelation]:
        """Return all matchup relations where set_id is the source (set_a)."""
        results: list[MatchupRelation] = []
        if not self.graph.has_node(set_id):
            return results
        for _, target, data in self.graph.out_edges(set_id, data=True):
            if data.get("edge_type") != "matchup":
                continue
            mr = MatchupRelation.from_dict(data["data"])
            if mr.confidence >= min_confidence:
                results.append(mr)
        return results

    def get_matchups_against(self, set_id: str, min_confidence: float = 0.0) -> list[MatchupRelation]:
        """Return all matchup relations where set_id is the target (set_b)."""
        results: list[MatchupRelation] = []
        if not self.graph.has_node(set_id):
            return results
        for source, _, data in self.graph.in_edges(set_id, data=True):
            if data.get("edge_type") != "matchup":
                continue
            mr = MatchupRelation.from_dict(data["data"])
            if mr.confidence >= min_confidence:
                results.append(mr)
        return results

    def get_matchup_between(self, set_a_id: str, set_b_id: str) -> MatchupRelation | None:
        """Get the specific matchup between two sets, if it exists."""
        if self.graph.has_edge(set_a_id, set_b_id):
            data = self.graph.edges[set_a_id, set_b_id]
            if data.get("edge_type") == "matchup":
                return MatchupRelation.from_dict(data["data"])
        return None

    # ────────────────────────────────────────────────────────────────
    # Removal
    # ────────────────────────────────────────────────────────────────

    def remove_set(self, set_id: str) -> None:
        """Remove a set node and all its edges from the graph."""
        if self.graph.has_node(set_id):
            self.graph.remove_node(set_id)
        self._set_index.pop(set_id, None)

    def remove_pokemon(self, pokemon_id: str) -> None:
        """Remove a Pokémon and all its sets."""
        sets = self.get_sets(pokemon_id)
        for s in sets:
            self.remove_set(s.id)
        if self.graph.has_node(pokemon_id):
            self.graph.remove_node(pokemon_id)
        self._pokemon_index.pop(pokemon_id, None)

    # ────────────────────────────────────────────────────────────────
    # Stats
    # ────────────────────────────────────────────────────────────────

    @property
    def pokemon_count(self) -> int:
        return len(self._pokemon_index)

    @property
    def set_count(self) -> int:
        return len(self._set_index)

    @property
    def matchup_count(self) -> int:
        return sum(
            1 for _, _, d in self.graph.edges(data=True)
            if d.get("edge_type") == "matchup"
        )

    @property
    def move_count(self) -> int:
        return len(self._move_index)

    def summary(self) -> str:
        return (
            f"KnowledgeGraph: {self.pokemon_count} Pokémon, "
            f"{self.set_count} sets, {self.matchup_count} matchups, "
            f"{self.move_count} moves, "
            f"{self.graph.number_of_nodes()} total nodes, "
            f"{self.graph.number_of_edges()} total edges"
        )

    # ────────────────────────────────────────────────────────────────
    # Serialization
    # ────────────────────────────────────────────────────────────────

    def to_json(self) -> dict[str, Any]:
        """Serialize the entire graph to a JSON-compatible dict."""
        nodes: list[dict] = []
        for node_id, attrs in self.graph.nodes(data=True):
            nodes.append({
                "id": node_id,
                "node_type": attrs.get("node_type", "unknown"),
                "data": attrs.get("data", {}),
            })

        edges: list[dict] = []
        for src, tgt, attrs in self.graph.edges(data=True):
            edges.append({
                "source": src,
                "target": tgt,
                "edge_type": attrs.get("edge_type", "unknown"),
                "data": attrs.get("data", {}),
                "weight": attrs.get("weight", 0.0),
            })

        return {"nodes": nodes, "edges": edges}

    @classmethod
    def from_json(cls, payload: dict[str, Any]) -> KnowledgeGraph:
        """Reconstruct a KnowledgeGraph from a JSON dict."""
        kg = cls()

        for node in payload.get("nodes", []):
            nid = node["id"]
            ntype = node["node_type"]
            ndata = node.get("data", {})
            kg.graph.add_node(nid, node_type=ntype, data=ndata)

            # Rebuild indexes
            if ntype == "pokemon":
                try:
                    kg._pokemon_index[nid] = PokemonClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass
            elif ntype == "set":
                try:
                    kg._set_index[nid] = SetClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass
            elif ntype == "move":
                try:
                    kg._move_index[nid] = MoveClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass
            elif ntype == "ability":
                try:
                    kg._ability_index[nid] = AbilityClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass
            elif ntype == "item":
                try:
                    kg._item_index[nid] = ItemClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass
            elif ntype == "nature":
                try:
                    kg._nature_index[nid] = NatureClass.from_dict(ndata)
                except (KeyError, TypeError):
                    pass

        for edge in payload.get("edges", []):
            kg.graph.add_edge(
                edge["source"],
                edge["target"],
                edge_type=edge.get("edge_type", "unknown"),
                data=edge.get("data", {}),
                weight=edge.get("weight", 0.0),
            )

        return kg

    # ────────────────────────────────────────────────────────────────
    # File I/O
    # ────────────────────────────────────────────────────────────────

    def save(self, path: str | Path) -> None:
        """Save graph to a JSON file."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_json(), f, indent=2, ensure_ascii=False)

    @classmethod
    def load(cls, path: str | Path) -> KnowledgeGraph:
        """Load graph from a JSON file."""
        with open(path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return cls.from_json(payload)

    def save_set_yaml(self, set_obj: SetClass, sets_dir: str | Path) -> Path:
        """Save a single set as a YAML file under sets_dir/{pokemon_id}/{set_name}.yaml."""
        import yaml
        sets_dir = Path(sets_dir)
        set_dir = sets_dir / set_obj.pokemon_id
        set_dir.mkdir(parents=True, exist_ok=True)
        slug = set_obj.set_name.lower().replace(" ", "_").replace("+", "plus")
        path = set_dir / f"{slug}.yaml"
        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(set_obj.to_dict(), f, default_flow_style=False, allow_unicode=True)

        # Hook: also (re)write the 8-attribute x 18-type matchup-graph node
        # cache alongside the YAML so the renderer can lazy-load it.  Cache
        # failure must not break the YAML save.
        try:
            from pokeredus.graph.matchup_graph import (
                build_node, save_node_cache,
            )
            pokemon = self.get_pokemon(set_obj.pokemon_id)
            if pokemon is not None:
                mcts = float(
                    getattr(set_obj, "mcts_composite", 0.0) or 0.0
                )
                node = build_node(
                    set_obj, pokemon, kg=self, mcts_composite=mcts,
                )
                save_node_cache(node, sets_dir)
        except Exception:
            pass

        return path

    def __repr__(self) -> str:
        return self.summary()
