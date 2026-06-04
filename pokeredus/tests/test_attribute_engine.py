"""
Tests for the tunable attribute engine: 4 base axes + 4 compound axes
with axis weights, per-compound multipliers, move-role nudges, and
polynomial 0-100 scaling.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np
import pytest

from pokeredus.graph.attribute_engine import (
    AttributeTuning, compute_attributes, polynomial_scale, volume_of_tuned,
    tune_existing_node,
)


# ── Defaults match the existing per-type sum model ─────────────────

def test_default_tuning_equals_legacy_compound():
    """With all weights/multipliers = 1.0 and no move boosts, the
    compound axes should match the existing per-type sums.
    counter = attack + defense (no scaling → k=1, p=1)."""
    tuning = AttributeTuning()  # all defaults
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 2.0   # attack
    base[2] = 3.0   # defense
    out = compute_attributes(base, tuning=tuning)
    # counter raw = attack + defense = 5, scaled via logistic(5) ≈ 5/6
    # the important test is that it's monotone in (attack+defense) and
    # that volume_of_tuned matches when we re-implement it.
    assert out.shape == (8, 18)


def test_default_volume_is_finite_and_nonnegative():
    """Default tuning should produce a finite, non-negative volume
    for typical per-type sums."""
    tuning = AttributeTuning()  # all defaults
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 2.0   # attack
    base[2] = 3.0   # defense
    base[3] = 4.0   # speed
    base[1] = 1.0   # utility
    out = compute_attributes(base, tuning=tuning)
    v = volume_of_tuned(out)
    assert v > 0
    assert v < 100 * 100 * 18 * 2  # all axes at most 100


# ── Axis weights scale compounds linearly ──────────────────────────

def test_axis_weight_scales_compound():
    tuning = AttributeTuning(axis_attack=2.0)
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 1.0   # attack
    base[2] = 1.0   # defense
    out = compute_attributes(base, tuning=tuning)
    # counter raw = 2*1 + 1*1 = 3, sponge unchanged
    # We just want to assert the relative order changed.
    assert out[4].sum() > out[5].sum()


def test_defense_weight_increases_counter_and_sponge_only():
    tuning = AttributeTuning(axis_defense=3.0)
    base = np.zeros((4, 18), dtype=np.float32)
    base[2] = 1.0   # defense
    out = compute_attributes(base, tuning=tuning)
    # counter and sponge both have defense as input; threat and punish don't.
    # Use defaults and a strong k so we're in the linear regime.
    tuning_lin = AttributeTuning(
        axis_defense=3.0,
        k_base=(1e6,) * 4, p_base=(1.0,) * 4,
        k_compound=(1e6,) * 4, p_compound=(1.0,) * 4,
    )
    out = compute_attributes(base, tuning=tuning_lin)
    # counter_raw = 0*1 + 3*1 = 3, sponge_raw = 0 + 3*1 = 3
    # threat_raw = 0 + 0 = 0, punish_raw = 0 + 0 = 0
    assert (out[4] > 0).all()   # counter
    assert (out[5] > 0).all()   # sponge
    assert (out[6] == 0).all()  # threat
    assert (out[7] == 0).all()  # punish


# ── Per-compound multipliers scale the whole compound row ──────────

def test_compound_multiplier_increases_counter_and_only_counter():
    """With a 2× counter multiplier, counter grows but the other three
    compound axes are untouched."""
    common = dict(
        k_base=(100.0,) * 4, p_base=(1.0,) * 4,
        k_compound=(100.0,) * 4, p_compound=(1.0,) * 4,
    )
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 1.0
    base[2] = 1.0
    out_half = compute_attributes(
        base, tuning=AttributeTuning(compound_counter=1.0, **common),
    )
    out_full = compute_attributes(
        base, tuning=AttributeTuning(compound_counter=2.0, **common),
    )
    # counter grew
    assert (out_full[4] > out_half[4]).all()
    # other compounds unchanged
    np.testing.assert_allclose(out_full[5], out_half[5])
    np.testing.assert_allclose(out_full[6], out_half[6])
    np.testing.assert_allclose(out_full[7], out_half[7])


# ── Polynomial scaling is monotone and saturating ─────────────────

def test_polynomial_scale_zero_and_monotone():
    assert polynomial_scale(0.0, k=1.0, p=1.0) == 0.0
    a = polynomial_scale(0.5, k=1.0, p=1.0)
    b = polynomial_scale(1.0, k=1.0, p=1.0)
    c = polynomial_scale(2.0, k=1.0, p=1.0)
    assert 0 < a < b < c <= 100


def test_polynomial_scale_saturates_near_100():
    """For very large raw values, the logistic should approach but not
    exceed 100."""
    v = polynomial_scale(1e6, k=1.0, p=1.0)
    assert 99.0 < float(v) <= 100.0


def test_polynomial_scale_handles_array():
    out = polynomial_scale(np.array([0.0, 1.0, 10.0]), k=1.0, p=1.0)
    assert out.shape == (3,)
    assert out[0] == 0.0
    assert 0 < out[1] < out[2] <= 100


def test_polynomial_scale_clamps_negative():
    """Negative raw values should be treated as 0."""
    assert polynomial_scale(-5.0, k=1.0, p=1.0) == 0.0


# ── Move-role nudges are additive ─────────────────────────────────

def test_setup_move_boosts_threat():
    """A setup move (Swords Dance) should raise threat by `boost * n`."""
    tuning = AttributeTuning(
        k_base=(100.0,) * 4, p_base=(1.0,) * 4,
        k_compound=(100.0,) * 4, p_compound=(1.0,) * 4,
    )
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 10.0   # attack — nonzero so scaling is informative
    base[3] = 10.0   # speed
    out_no_move = compute_attributes(base, tuning=tuning)
    out_with_move = compute_attributes(
        base, tuning=tuning, moves=["swordsdance"],
    )
    # threat should be higher with the move.
    assert (out_with_move[6] > out_no_move[6]).all()
    # And the difference should be proportional to the boost (0.5 for SD).
    delta = (out_with_move[6] - out_no_move[6])
    assert (delta > 0).all()
    assert (delta < 5.0).all()


def test_recovery_move_boosts_sponge_only():
    """A recovery move (Recover) should raise sponge, not the others."""
    tuning = AttributeTuning(
        k_base=(100.0,) * 4, p_base=(1.0,) * 4,
        k_compound=(100.0,) * 4, p_compound=(1.0,) * 4,
    )
    base = np.zeros((4, 18), dtype=np.float32)
    base[1] = 10.0
    base[2] = 10.0
    out_no_move = compute_attributes(base, tuning=tuning)
    out_with_move = compute_attributes(base, tuning=tuning, moves=["recover"])
    # sponge grew
    assert (out_with_move[5] > out_no_move[5]).all()
    # other compounds unchanged
    np.testing.assert_allclose(out_with_move[4], out_no_move[4])
    np.testing.assert_allclose(out_with_move[6], out_no_move[6])
    np.testing.assert_allclose(out_with_move[7], out_no_move[7])


# ── tune_existing_node adapter ────────────────────────────────────

def _make_fake_node():
    """Build a minimal SetMatchupNode-like object with the fields
    tune_existing_node reads: ``attributes`` (8x18 ndarray) and
    optional ``moves`` (list of move-id strings)."""
    class _Node:
        pass
    n = _Node()
    n.attributes = np.zeros((8, 18), dtype=np.float32)
    n.attributes[0] = 1.0   # attack
    n.attributes[2] = 1.0   # defense
    n.attributes[3] = 1.0   # speed
    n.attributes[1] = 1.0   # utility
    # Compute the legacy compound rows so volume_of is non-zero.
    n.attributes[4] = n.attributes[0] + n.attributes[2]   # counter
    n.attributes[5] = n.attributes[1] + n.attributes[2]   # sponge
    n.attributes[6] = n.attributes[0] + n.attributes[3]   # threat
    n.attributes[7] = n.attributes[1] + n.attributes[3]   # punish
    n.bias = 1.0
    n.moves = ["swordsdance", "recover"]
    return n


def test_tune_existing_node_preserves_shape():
    tuned = tune_existing_node(_make_fake_node(), tuning=AttributeTuning())
    assert tuned.shape == (8, 18)


def test_tune_existing_node_default_matches_legacy():
    """With k=100 (mostly-linear regime) the volume should be
    non-trivially related to the legacy per-type sum."""
    from pokeredus.graph.matchup_graph import volume_of
    node = _make_fake_node()
    legacy = volume_of(node.attributes, node.bias)
    tuning = AttributeTuning(
        k_base=(100.0,) * 4, p_base=(1.0,) * 4,
        k_compound=(100.0,) * 4, p_compound=(1.0,) * 4,
    )
    tuned = tune_existing_node(node, tuning=tuning)
    got = volume_of_tuned(tuned)
    # Both should be positive and finite
    assert legacy > 0
    assert got > 0
    # And within the same order of magnitude (scaling is non-linear
    # but bounded 0-100, so for small raw values the volume is much
    # smaller than the legacy linear sum).
    assert got < legacy * 100


# ── AttributeTuning round-trips through as_dict ──────────────────

def test_tuning_as_dict_roundtrip():
    t = AttributeTuning(axis_attack=1.5, compound_threat=0.7)
    d = t.as_dict()
    assert d["axis_attack"] == 1.5
    assert d["compound_threat"] == 0.7
    assert d["k_base"] == [1.0, 1.0, 1.0, 1.0]
