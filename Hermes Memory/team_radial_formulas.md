# Team Radial Formulas
# =====================
# This file defines the formula constants used to calculate the team radial
# breakdown view.  Edits here are picked up at runtime by
# `load_team_radial_formulas()` in matchup_graph_view.py; no code restart
# required (the live-update path reads from disk each call).

# --- Coverage ---
# coverage_score = (raw_coverage ** coverage_exponent) * coverage_magnitude + 0.1
# where raw_coverage = favorable_matchups / total_matchups for a given set
"coverage_exponent": 1.5
"coverage_magnitude": 0.8

# --- Score Aggregation ---
# How individual member scores are combined into a team score.
# Options: "sum" (additive), "mean" (average), "max" (best member only)
"score_aggregation": "sum"

# --- Minimum Contribution ---
# A member whose contribution falls below this % of the max contribution
# is still shown at this minimum amplitude (prevents vanishing slivers).
"min_contribution_pct": 5.0

# --- Angular Distribution ---
# How the 360° circle is split when a sector is expanded.
# Options: "coverage" (weighted by coverage_score), "equal" (even split)
"angular_distribution": "coverage"

# --- Expanded Sector Animation ---
# Number of frames for the expand/collapse transition
"animation_frames": 12

# Milliseconds between animation frames (16 ≈ 60fps)
"animation_interval_ms": 16