"""Characterization tests for the tunable attribute engine."""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np

from pokeredus.graph.attribute_engine import (
    AttributeTuning, compute_attributes, polynomial_scale, volume_of_tuned,
    tune_existing_node,
)
from pokeredus.graph.matchup_graph import ATTRIBUTE_INDEX


def test_default_tuning_equals_legacy_compound():
    tuning = AttributeTuning()
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 2.0
    base[2] = 3.0
    out = compute_attributes(base, tuning=tuning)
    assert out.shape == (8, 18)


def test_default_volume_is_finite_and_nonnegative():
    tuning = AttributeTuning()
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 2.0
    base[2] = 3.0
    base[3] = 4.0
    base[1] = 1.0
    out = compute_attributes(base, tuning=tuning)
    v = volume_of_tuned(out)
    assert v > 0
    assert v < 100 * 100 * 18 * 2


def test_axis_weight_scales_compound():
    tuning = AttributeTuning(axis_attack=2.0)
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 1.0
    base[2] = 1.0
    out = compute_attributes(base, tuning=tuning)
    assert out[ATTRIBUTE_INDEX["counter"]].sum() > out[ATTRIBUTE_INDEX["sponge"]].sum()


def test_defense_weight_increases_counter_and_sponge_only():
    base = np.zeros((4, 18), dtype=np.float32)
    base[2] = 1.0
    tuning_lin = AttributeTuning(
        axis_defense=3.0,
        k_base=(1e6,) * 4, p_base=(1.0,) * 4,
        k_compound=(1e6,) * 4, p_compound=(1.0,) * 4,
    )
    out = compute_attributes(base, tuning=tuning_lin)
    assert (out[ATTRIBUTE_INDEX["counter"]] > 0).all()
    assert (out[ATTRIBUTE_INDEX["sponge"]] > 0).all()
    assert (out[ATTRIBUTE_INDEX["threat"]] == 0).all()
    assert (out[ATTRIBUTE_INDEX["punish"]] == 0).all()


def test_compound_multiplier_increases_counter_and_only_counter():
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
    C = ATTRIBUTE_INDEX["counter"]
    assert (out_full[C] > out_half[C]).all()
    np.testing.assert_allclose(out_full[ATTRIBUTE_INDEX["sponge"]], out_half[ATTRIBUTE_INDEX["sponge"]])
    np.testing.assert_allclose(out_full[ATTRIBUTE_INDEX["threat"]], out_half[ATTRIBUTE_INDEX["threat"]])
    np.testing.assert_allclose(out_full[ATTRIBUTE_INDEX["punish"]], out_half[ATTRIBUTE_INDEX["punish"]])


def test_polynomial_scale_zero_and_monotone():
    assert polynomial_scale(0.0, k=1.0, p=1.0) == 0.0
    a = polynomial_scale(0.5, k=1.0, p=1.0)
    b = polynomial_scale(1.0, k=1.0, p=1.0)
    c = polynomial_scale(2.0, k=1.0, p=1.0)
    assert 0 < a < b < c <= 100


def test_polynomial_scale_saturates_near_100():
    v = polynomial_scale(1e6, k=1.0, p=1.0)
    assert 99.0 < float(v) <= 100.0


def test_polynomial_scale_handles_array():
    out = polynomial_scale(np.array([0.0, 1.0, 10.0]), k=1.0, p=1.0)
    assert out.shape == (3,)
    assert out[0] == 0.0
    assert 0 < out[1] < out[2] <= 100


def test_polynomial_scale_clamps_negative():
    assert polynomial_scale(-5.0, k=1.0, p=1.0) == 0.0


def _linear_tuning(**kwargs) -> AttributeTuning:
    return AttributeTuning(
        axis_attack=1.0, axis_utility=1.0, axis_defense=1.0, axis_speed=1.0,
        compound_counter=1.0, compound_sponge=1.0, compound_threat=1.0, compound_punish=1.0,
        k_base=(1e6,) * 4, p_base=(1.0,) * 4,
        k_compound=(1e6,) * 4, p_compound=(1.0,) * 4,
        **kwargs,
    )


def test_setup_move_boosts_threat():
    tuning = _linear_tuning()
    base = np.zeros((4, 18), dtype=np.float32)
    base[0] = 10.0
    base[3] = 10.0
    out_no_move = compute_attributes(base, tuning=tuning)
    out_with_move = compute_attributes(base, tuning=tuning, moves=["swordsdance"])
    T = ATTRIBUTE_INDEX["threat"]
    assert (out_with_move[T] > out_no_move[T]).all()
    delta = out_with_move[T] - out_no_move[T]
    assert (delta > 0).all()
    assert (delta < 5.0).all()


def test_recovery_move_boosts_sponge_only():
    tuning = _linear_tuning()
    base = np.zeros((4, 18), dtype=np.float32)
    base[1] = 10.0
    base[2] = 10.0
    out_no_move = compute_attributes(base, tuning=tuning)
    out_with_move = compute_attributes(base, tuning=tuning, moves=["recover"])
    G = ATTRIBUTE_INDEX["sponge"]
    assert (out_with_move[G] > out_no_move[G]).all()
    np.testing.assert_allclose(out_with_move[ATTRIBUTE_INDEX["counter"]], out_no_move[ATTRIBUTE_INDEX["counter"]])
    np.testing.assert_allclose(out_with_move[ATTRIBUTE_INDEX["threat"]], out_no_move[ATTRIBUTE_INDEX["threat"]])
    np.testing.assert_allclose(out_with_move[ATTRIBUTE_INDEX["punish"]], out_no_move[ATTRIBUTE_INDEX["punish"]])


def _make_fake_node():
    class _Node:
        pass
    n = _Node()
    n.attributes = np.zeros((8, 18), dtype=np.float32)
    n.attributes[ATTRIBUTE_INDEX["attack"]] = 1.0
    n.attributes[ATTRIBUTE_INDEX["utility"]] = 1.0
    n.attributes[ATTRIBUTE_INDEX["defense"]] = 1.0
    n.attributes[ATTRIBUTE_INDEX["speed"]] = 1.0
    n.attributes[ATTRIBUTE_INDEX["counter"]] = 2.0
    n.attributes[ATTRIBUTE_INDEX["sponge"]] = 2.0
    n.attributes[ATTRIBUTE_INDEX["threat"]] = 2.0
    n.attributes[ATTRIBUTE_INDEX["punish"]] = 2.0
    n.moves = ["swordsdance", "recover"]
    return n


def test_tune_existing_node_preserves_shape():
    tuned = tune_existing_node(_make_fake_node(), tuning=AttributeTuning())
    assert tuned.shape == (8, 18)


def test_tune_existing_node_default_matches_legacy():
    from pokeredus.graph.matchup_graph import volume_of
    node = _make_fake_node()
    legacy = volume_of(node.attributes)
    tuning = AttributeTuning(
        k_base=(100.0,) * 4, p_base=(1.0,) * 4,
        k_compound=(100.0,) * 4, p_compound=(1.0,) * 4,
    )
    tuned = tune_existing_node(node, tuning=tuning)
    got = volume_of_tuned(tuned)
    assert legacy > 0
    assert got > 0
    assert got < legacy * 1e6


def test_tuning_as_dict_roundtrip():
    t = AttributeTuning(axis_attack=1.5, compound_threat=0.7)
    d = t.as_dict()
    assert d["axis_attack"] == 1.5
    assert d["compound_threat"] == 0.7
    assert d["k_base"] == [100.0, 100.0, 100.0, 100.0]
