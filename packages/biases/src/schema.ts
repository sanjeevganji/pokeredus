import { z } from 'zod';

export const BiasesSchema = z.object({
  version: z.literal(1),
  type_eff_weight: z.number().default(1.0),
  stab_weight: z.number().default(0.5),
  bp_weight: z.number().default(0.2),
  priority_weight: z.number().default(0.2),
  utility_weight: z.number().default(0.3),
  edge_prior_weight: z.number().default(0.4),
  damage_weight: z.number().default(0.3),
  use_damage_rollout: z.boolean().default(true),
  rollout_count: z.number().int().min(0).max(1024).default(64),
  rollout_depth: z.number().int().min(0).max(4).default(2),
  child_weight: z.number().default(0.5),
  switch_threshold: z.number().default(0.3),
  switch_type_weight: z.number().default(0.4),
  switch_speed_weight: z.number().default(0.4),
  switch_edge_weight: z.number().default(0.4),
  switch_distance_weight: z.number().default(0.1),
  pack_min_mb: z.number().default(0.5),
  budget_ms: z.number().default(50),
  dry_run: z.boolean().default(false),
});

export type Biases = z.infer<typeof BiasesSchema>;
