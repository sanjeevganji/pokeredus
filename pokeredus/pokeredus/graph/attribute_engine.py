"""Tunable attribute engine: 4 base axes (attack/utility/defense/speed) →
4 compound axes (counter/sponge/threat/punish) with weights, per-compound
multipliers, move-role nudges, and polynomial 0-100 scaling.

This wraps the existing ``pokeredus.graph.matchup_graph`` data layer so
the rest of the GUI can stay unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np

# Lazy import to avoid circular dependency at module level.
# Used inside functions that need the canonical attribute index.
_ATTRIBUTE_INDEX: dict[str, int] | None = None


def _attr_idx(name: str) -> int:
    global _ATTRIBUTE_INDEX
    if _ATTRIBUTE_INDEX is None:
        from pokeredus.graph.matchup_graph import ATTRIBUTE_INDEX
        _ATTRIBUTE_INDEX = ATTRIBUTE_INDEX
    return _ATTRIBUTE_INDEX[name]


# Compound ordering matches the existing polygonal-solid model:
#   counter, sponge, threat, punish
COMPOUND_NAMES = ("counter", "sponge", "threat", "punish")
BASE_NAMES = ("attack", "utility", "defense", "speed")

# Move-role tag boosts (additive nudge per matching move).
# Keys are compound names; values are (move-id-set, boost-per-match).
MOVE_ROLE_BOOSTS: dict[str, tuple[set[str], float]] = {
    "threat":  (
        {"swordsdance", "nastyplot", "calmindmind", "dragondance",
         "bulkup", "coil", "quiverdance", "shellsmash", "workup"},
        0.5,
    ),
    "punish": (
        {"uturn", "voltswitch", "partingshot", "whirlwind", "roar",
         "dragontail", "circlethrow", "teleport", "batonpass"},
        0.4,
    ),
    "sponge": (
        {"recover", "softboiled", "roost", "wish", "milkdrink",
         "morningsun", "moonlight", "synthesis", "healorder",
         "slackoff", "protect"},
        0.3,
    ),
    "counter": (
        {"extremespeed", "suckerpunch", "aquajet", "bulletpunch",
         "machpunch", "shadowsneak", "quickattack", "icepunch",
         "thunderpunch", "vacuumwave"},
        0.4,
    ),
}


@dataclass
class AttributeTuning:
    """All tunables for the attribute engine. Defaults are set to 100.0
    for a balanced baseline across all 8 sectors."""

    # 4 base-axis amplitudes
    axis_attack: float = 100.0
    axis_utility: float = 100.0
    axis_defense: float = 100.0
    axis_speed: float = 100.0

    # 4 per-compound amplitudes
    compound_counter: float = 100.0
    compound_sponge: float = 100.0
    compound_threat: float = 100.0
    compound_punish: float = 100.0

    # Polynomial-scaling parameters (logistic midpoint k + steepness p)
    # per axis (4 base + 4 compound = 8 axes total).
    k_base: tuple = (100.0, 100.0, 100.0, 100.0)
    p_base: tuple = (1.0, 1.0, 1.0, 1.0)
    k_compound: tuple = (100.0, 100.0, 100.0, 100.0)
    p_compound: tuple = (1.0, 1.0, 1.0, 1.0)

    def as_dict(self) -> dict:
        return {
            "axis_attack": self.axis_attack,
            "axis_utility": self.axis_utility,
            "axis_defense": self.axis_defense,
            "axis_speed": self.axis_speed,
            "compound_counter": self.compound_counter,
            "compound_sponge": self.compound_sponge,
            "compound_threat": self.compound_threat,
            "compound_punish": self.compound_punish,
            "k_base": list(self.k_base),
            "p_base": list(self.p_base),
            "k_compound": list(self.k_compound),
            "p_compound": list(self.p_compound),
        }


def polynomial_scale(raw, k: float = 1.0, p: float = 1.0):
    """Logistic polynomial scaling to 0-100.

    ``scaled = 100 * ((raw/k)^p) / (1 + (raw/k)^p)``

    Works on scalars and ndarrays.  Negative raw values are clamped to 0.
    """
    r = np.asarray(raw, dtype=np.float32)
    safe_k = max(float(k), 1e-9)
    z = np.power(np.maximum(r, 0.0) / safe_k, float(p))
    return 100.0 * z / (1.0 + z)


def compute_attributes(base_per_type: np.ndarray,
                       tuning: AttributeTuning | None = None,
                       moves: list[str] | None = None) -> np.ndarray:
    """Compute the full 8x18 attribute matrix from the 4 base axes.

    ``base_per_type`` is shape (4, 18): rows 0..3 = attack/utility/defense/speed.
    Returns shape (8, 18): rows 0..3 = scaled base, rows 4..7 = scaled compound.

    The returned matrix is *already polynomially scaled to 0-100* using
    the per-axis (k, p) pairs in ``tuning``.
    """
    tuning = tuning or AttributeTuning()
    base = np.asarray(base_per_type, dtype=np.float32)  # (4, 18)
    assert base.shape == (4, 18), f"expected (4,18), got {base.shape}"

    # ── Compound raw values (no scaling yet) ─────────────────────
    A, U, D, S = base[0], base[1], base[2], base[3]
    counter = (tuning.axis_attack * A + tuning.axis_defense * D) * tuning.compound_counter
    sponge  = (tuning.axis_utility * U + tuning.axis_defense * D) * tuning.compound_sponge
    threat  = (tuning.axis_attack * A + tuning.axis_speed * S) * tuning.compound_threat
    punish  = (tuning.axis_utility * U + tuning.axis_speed * S) * tuning.compound_punish

    # ── Move-role nudges (additive, in-place on the rows) ────────
    if moves:
        low = {m.lower() for m in moves}
        for cname, (tag_set, boost) in MOVE_ROLE_BOOSTS.items():
            hits = low & tag_set
            if not hits:
                continue
            n = len(hits)
            if cname == "counter":
                counter += boost * n
            elif cname == "sponge":
                sponge += boost * n
            elif cname == "threat":
                threat += boost * n
            elif cname == "punish":
                punish += boost * n

    raw = np.stack([base[0],  threat, base[3], punish,
                    base[1], sponge, base[2], counter], axis=0)  # (8, 18)
    # Row order: attack(0) threat(1) speed(2) punish(3)
    #            utility(4) sponge(5) defense(6) counter(7)

    # ── Polynomial 0-100 scaling, per axis ───────────────────────
    out = np.zeros_like(raw)
    for i in range(4):
        out[i] = polynomial_scale(raw[i], tuning.k_base[i], tuning.p_base[i])
    for i in range(4):
        out[4 + i] = polynomial_scale(
            raw[4 + i], tuning.k_compound[i], tuning.p_compound[i],
        )
    return out


def volume_of_tuned(attributes_8x18: np.ndarray, bias: float = 1.0) -> float:
    """Volume of the 3D polygonal solid given an *already-scaled* 8x18
    attribute matrix.  Same shape as the existing ``volume_of``."""
    C = _attr_idx("counter"); G = _attr_idx("sponge")
    T = _attr_idx("threat");  P = _attr_idx("punish")
    per_type = (attributes_8x18[C] * attributes_8x18[G]
                + attributes_8x18[T] * attributes_8x18[P])
    return float(per_type.sum() * bias)


def tune_existing_node(node, tuning: AttributeTuning | None = None) -> np.ndarray:
    """Re-derive a SetMatchupNode's 8x18 attribute matrix using
    ``AttributeTuning``.  The base attributes are extracted by name
    (attack, utility, defense, speed) since the row order changed to
    the interleaved compass-rose layout.
    """
    tuning = tuning or AttributeTuning()
    A = _attr_idx("attack"); U = _attr_idx("utility")
    D = _attr_idx("defense"); S = _attr_idx("speed")
    base = np.stack([
        node.attributes[A], node.attributes[U],
        node.attributes[D], node.attributes[S],
    ], axis=0)  # (4, 18) in canonical base order: attack, utility, defense, speed
    # SetMatchupNode may or may not carry `moves`; if not, no nudges fire.
    moves = getattr(node, "moves", None)
    return compute_attributes(base, tuning=tuning, moves=moves)
