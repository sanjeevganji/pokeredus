import type { Biases } from './schema.js';

export const DEFAULT_BIASES: Biases = {
  version: 1,
  type_eff_weight: 1.0,
  stab_weight: 0.5,
  bp_weight: 0.2,
  priority_weight: 0.2,
  utility_weight: 0.3,
  edge_prior_weight: 0.4,
  damage_weight: 0.3,
  use_damage_rollout: true,
  rollout_count: 64,
  rollout_depth: 2,
  child_weight: 0.5,
  switch_threshold: 0.3,
  switch_type_weight: 0.4,
  switch_speed_weight: 0.4,
  switch_edge_weight: 0.4,
  switch_distance_weight: 0.1,
  pack_min_mb: 0.5,
  budget_ms: 50,
  dry_run: false,
};
