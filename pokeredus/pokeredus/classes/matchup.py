"""
MatchupRelation — a scored, typed relationship between two SetClass instances.

Represents how two competitive sets relate to each other in a matchup context.
Score ranges from -1.0 (set_a loses badly) to +1.0 (set_a wins decisively).

Phase 5: Extended with turns-to-kill (TTK) fields for damage-based scoring.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class MatchupRelation:
    """A matchup edge between two sets in the knowledge graph."""

    set_a_id: str               # source SetClass.id
    set_b_id: str               # target SetClass.id
    score: float = 0.0          # -1.0 to +1.0; positive favors set_a
    confidence: float = 0.3     # 0.0 to 1.0; higher = more reliable data
    sample_count: int = 0       # number of observed/analyzed encounters
    source: str = "type_calc"   # "manual", "type_calc", "learned", "imported", "ttk_calc"
    tags: list[str] = field(default_factory=list)
    # tags: "OHKO", "2HKO", "3HKO", "forced_switch", "setup_fodder", "revenge_kill", etc.

    # ── Phase 5: TTK fields ─────────────────────────────────────────
    turns_to_kill_a: int = 0        # A kills B in N turns (0 = can't kill)
    turns_to_kill_b: int = 0        # B kills A in N turns (0 = can't kill)
    speed_advantage: str = "tie"    # "a", "b", or "tie"
    best_move_a_id: str = ""        # A's best move against B
    best_move_b_id: str = ""        # B's best move against A
    damage_a_to_b: int = 0          # A's best move raw damage per hit
    damage_b_to_a: int = 0          # B's best move raw damage per hit
    effective_hp_a: int = 0         # A's computed HP stat
    effective_hp_b: int = 0         # B's computed HP stat

    # ── Damage range fields (85–100% random roll) ───────────────────
    min_damage_a_to_b: int = 0      # worst-case roll A→B
    max_damage_a_to_b: int = 0      # best-case roll A→B
    min_damage_b_to_a: int = 0      # worst-case roll B→A
    max_damage_b_to_a: int = 0      # best-case roll B→A
    damage_pct_a_to_b_lo: float = 0.0  # min roll as % of B's HP
    damage_pct_a_to_b_hi: float = 0.0  # max roll as % of B's HP
    damage_pct_b_to_a_lo: float = 0.0  # min roll as % of A's HP
    damage_pct_b_to_a_hi: float = 0.0  # max roll as % of A's HP
    min_ttk_a_to_b: int = 0         # best-case TTK A→B (fewest turns)
    max_ttk_a_to_b: int = 0         # worst-case TTK A→B (most turns)
    min_ttk_b_to_a: int = 0         # best-case TTK B→A
    max_ttk_b_to_a: int = 0         # worst-case TTK B→A

    # ── derived properties ──────────────────────────────────────────
    @property
    def is_favorable(self) -> bool:
        """True if set_a has the advantage."""
        return self.score > 0.2

    @property
    def is_unfavorable(self) -> bool:
        """True if set_a is at a disadvantage."""
        return self.score < -0.2

    @property
    def is_close(self) -> bool:
        """True if the matchup is roughly even."""
        return -0.2 <= self.score <= 0.2

    @property
    def category(self) -> str:
        """Human-readable matchup category."""
        if self.score >= 0.6:
            return "counter"
        elif self.score >= 0.3:
            return "check"
        elif self.score > -0.3:
            return "neutral"
        elif self.score > -0.6:
            return "checked_by"
        else:
            return "countered_by"

    @property
    def ttk_label(self) -> str:
        """Human-readable TTK label, e.g. '2HKO' or 'OHKO'."""
        ttk = self.turns_to_kill_a
        if ttk <= 0:
            return "—"
        elif ttk == 1:
            return "OHKO"
        elif ttk == 2:
            return "2HKO"
        elif ttk == 3:
            return "3HKO"
        else:
            return f"{ttk}HKO"

    @property
    def ttk_label_b(self) -> str:
        """TTK label for B against A."""
        ttk = self.turns_to_kill_b
        if ttk <= 0:
            return "—"
        elif ttk == 1:
            return "OHKO"
        elif ttk == 2:
            return "2HKO"
        elif ttk == 3:
            return "3HKO"
        else:
            return f"{ttk}HKO"

    @property
    def speed_label(self) -> str:
        """Human-readable speed advantage."""
        if self.speed_advantage == "a":
            return "A faster"
        elif self.speed_advantage == "b":
            return "B faster"
        return "Speed tie"

    @property
    def damage_range_a_str(self) -> str:
        """A→B damage range like '45.2 – 53.1%'."""
        if self.effective_hp_b <= 0 or self.min_damage_a_to_b <= 0:
            return "—"
        lo = self.damage_pct_a_to_b_lo
        hi = self.damage_pct_a_to_b_hi
        if abs(lo - hi) < 0.5:
            return f"{hi:.1f}%"
        return f"{lo:.1f} – {hi:.1f}%"

    @property
    def damage_range_b_str(self) -> str:
        """B→A damage range like '45.2 – 53.1%'."""
        if self.effective_hp_a <= 0 or self.min_damage_b_to_a <= 0:
            return "—"
        lo = self.damage_pct_b_to_a_lo
        hi = self.damage_pct_b_to_a_hi
        if abs(lo - hi) < 0.5:
            return f"{hi:.1f}%"
        return f"{lo:.1f} – {hi:.1f}%"

    @property
    def ttk_range_a_str(self) -> str:
        """A→B TTK range like '2-3HKO'."""
        if self.min_ttk_a_to_b <= 0:
            return "—"
        if self.min_ttk_a_to_b == self.max_ttk_a_to_b:
            return f"{self.min_ttk_a_to_b}HKO"
        return f"{self.min_ttk_a_to_b}-{self.max_ttk_a_to_b}HKO"

    @property
    def ttk_range_b_str(self) -> str:
        """B→A TTK range like '2-3HKO'."""
        if self.min_ttk_b_to_a <= 0:
            return "—"
        if self.min_ttk_b_to_a == self.max_ttk_b_to_a:
            return f"{self.min_ttk_b_to_a}HKO"
        return f"{self.min_ttk_b_to_a}-{self.max_ttk_b_to_a}HKO"

    # ── serialization ───────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "set_a_id": self.set_a_id,
            "set_b_id": self.set_b_id,
            "score": round(self.score, 4),
            "confidence": round(self.confidence, 4),
            "sample_count": self.sample_count,
            "source": self.source,
            "tags": list(self.tags),
            # Phase 5 fields
            "turns_to_kill_a": self.turns_to_kill_a,
            "turns_to_kill_b": self.turns_to_kill_b,
            "speed_advantage": self.speed_advantage,
            "best_move_a_id": self.best_move_a_id,
            "best_move_b_id": self.best_move_b_id,
            "damage_a_to_b": self.damage_a_to_b,
            "damage_b_to_a": self.damage_b_to_a,
            "effective_hp_a": self.effective_hp_a,
            "effective_hp_b": self.effective_hp_b,
            # Damage range fields
            "min_damage_a_to_b": self.min_damage_a_to_b,
            "max_damage_a_to_b": self.max_damage_a_to_b,
            "min_damage_b_to_a": self.min_damage_b_to_a,
            "max_damage_b_to_a": self.max_damage_b_to_a,
            "damage_pct_a_to_b_lo": round(self.damage_pct_a_to_b_lo, 2),
            "damage_pct_a_to_b_hi": round(self.damage_pct_a_to_b_hi, 2),
            "damage_pct_b_to_a_lo": round(self.damage_pct_b_to_a_lo, 2),
            "damage_pct_b_to_a_hi": round(self.damage_pct_b_to_a_hi, 2),
            "min_ttk_a_to_b": self.min_ttk_a_to_b,
            "max_ttk_a_to_b": self.max_ttk_a_to_b,
            "min_ttk_b_to_a": self.min_ttk_b_to_a,
            "max_ttk_b_to_a": self.max_ttk_b_to_a,
        }

    @classmethod
    def from_dict(cls, data: dict) -> MatchupRelation:
        return cls(
            set_a_id=data["set_a_id"],
            set_b_id=data["set_b_id"],
            score=data.get("score", 0.0),
            confidence=data.get("confidence", 0.3),
            sample_count=data.get("sample_count", 0),
            source=data.get("source", "type_calc"),
            tags=data.get("tags", []),
            # Phase 5 fields (backward compatible with defaults)
            turns_to_kill_a=data.get("turns_to_kill_a", 0),
            turns_to_kill_b=data.get("turns_to_kill_b", 0),
            speed_advantage=data.get("speed_advantage", "tie"),
            best_move_a_id=data.get("best_move_a_id", ""),
            best_move_b_id=data.get("best_move_b_id", ""),
            damage_a_to_b=data.get("damage_a_to_b", 0),
            damage_b_to_a=data.get("damage_b_to_a", 0),
            effective_hp_a=data.get("effective_hp_a", 0),
            effective_hp_b=data.get("effective_hp_b", 0),
            # Damage range fields (backward compatible)
            min_damage_a_to_b=data.get("min_damage_a_to_b", 0),
            max_damage_a_to_b=data.get("max_damage_a_to_b", 0),
            min_damage_b_to_a=data.get("min_damage_b_to_a", 0),
            max_damage_b_to_a=data.get("max_damage_b_to_a", 0),
            damage_pct_a_to_b_lo=data.get("damage_pct_a_to_b_lo", 0.0),
            damage_pct_a_to_b_hi=data.get("damage_pct_a_to_b_hi", 0.0),
            damage_pct_b_to_a_lo=data.get("damage_pct_b_to_a_lo", 0.0),
            damage_pct_b_to_a_hi=data.get("damage_pct_b_to_a_hi", 0.0),
            min_ttk_a_to_b=data.get("min_ttk_a_to_b", 0),
            max_ttk_a_to_b=data.get("max_ttk_a_to_b", 0),
            min_ttk_b_to_a=data.get("min_ttk_b_to_a", 0),
            max_ttk_b_to_a=data.get("max_ttk_b_to_a", 0),
        )

    def __repr__(self) -> str:
        arrow = ">" if self.score > 0 else "<" if self.score < 0 else "="
        ttk_info = ""
        if self.turns_to_kill_a > 0:
            ttk_info = f", TTK:{self.ttk_label}/{self.ttk_label_b}"
        return (
            f"MatchupRelation({self.set_a_id} {arrow} {self.set_b_id}, "
            f"score={self.score:+.2f}, conf={self.confidence:.2f}, "
            f"src={self.source!r}{ttk_info})"
        )
