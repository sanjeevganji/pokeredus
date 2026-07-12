// BiasesSchema — versioned JSON of human-tunable scoring weights.
// The future self-evolving learner will update this same file shape;
// the runtime engine only reads it. Missing keys fall back to defaults.
import { z } from 'zod';

export const BiasesSchema = z.object({
  version: z.literal(1),

  // ── Per-signal weights (mirror pick_best_move additive heuristic) ──
  /** Weight on raw type-effectiveness multiplier contribution. */
  type_eff_weight: z.number().default(1.0),
  /** Weight on STAB bonus. */
  stab_weight: z.number().default(0.5),
  /** Weight on high-base-power "nuke" bonus. */
  bp_weight: z.number().default(0.2),
  /** Weight on priority-move bonus. */
  priority_weight: z.number().default(0.2),
  /** Weight on status/utility-move bonus. */
  utility_weight: z.number().default(0.3),

  // ── Downloaded-intelligence weight ──────────────────────────────────
  /** Weight on the prior from precomputed Knowledge-Pack edges. */
  edge_prior_weight: z.number().default(0.4),
  /** Weight on cached damage-percentage rollout (best-move match). */
  damage_weight: z.number().default(0.3),
  /** Gate: fold cached dmg_pct_hi into the move leaf score. */
  use_damage_rollout: z.boolean().default(true),

  // ── Search depth / breadth ──────────────────────────────────────────
  /** Number of random-opponent rollouts per action (0 = greedy counter only). */
  rollout_count: z.number().int().min(0).max(1024).default(64),
  /** Tree search depth (0 = flat leaf eval; 2 = one counter-ply). */
  rollout_depth: z.number().int().min(0).max(4).default(2),
  /** Weight on best child's leaf score when combining. */
  child_weight: z.number().default(0.5),

  // ── Switch decision threshold (mirrors analyze_game_state) ───────────
  /** Minimum advantage for the best switch over staying in. */
  switch_threshold: z.number().default(0.3),

  // ── Switch-scoring weights ──────────────────────────────────────────
  /** Weight on type-resist vs opponent's STAB attack types. */
  switch_type_weight: z.number().default(0.4),
  /** Speed advantage magnitude (+/-). */
  switch_speed_weight: z.number().default(0.4),
  /** Weight on precomputed matchup edge for switch candidates. */
  switch_edge_weight: z.number().default(0.4),
  /** Weight on 3D-distance complementary-role tiebreak. */
  switch_distance_weight: z.number().default(0.1),

  // ── Operational ─────────────────────────────────────────────────────
  /** Refuse to run if pack byte size is below this (MB) unless allowThin. */
  pack_min_mb: z.number().default(0.5),
  /** Soft performance budget per turn (ms). */
  budget_ms: z.number().default(50),
  /** Log but do not send chosen action (offline tuning). */
  dry_run: z.boolean().default(false),
});

export type Biases = z.infer<typeof BiasesSchema>;
