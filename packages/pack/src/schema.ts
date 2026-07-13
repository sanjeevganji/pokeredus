// Knowledge Pack Zod schema — single source of truth for the pack's shape.
import { z } from 'zod';

export const TypeChartSchema = z.record(z.string(), z.record(z.string(), z.number()));

export const SpeciesSchema = z.object({
  id: z.string(),
  name: z.string(),
  types: z.array(z.string()),
  base_stats: z.object({
    hp: z.number(), atk: z.number(), def: z.number(),
    spa: z.number(), spd: z.number(), spe: z.number(),
  }),
  abilities: z.array(z.string()),
  weight: z.number(),
  tier: z.string().optional(),
  is_mega: z.boolean().optional(),
  is_paradox: z.boolean().optional(),
  is_legendary: z.boolean().optional(),
  is_pseudo: z.boolean().optional(),
  api_name: z.string().optional(),
  primary_set_id: z.string().optional(),
});

export const MoveSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  category: z.enum(['Physical', 'Special', 'Status']),
  base_power: z.number(),
  accuracy: z.union([z.number(), z.literal(true)]),
  priority: z.number(),
  pp: z.number().optional(),
  target: z.string().optional(),
  flags: z.array(z.string()),
  secondary_effects: z.array(z.record(z.string(), z.unknown())).optional(),
});

export const AbilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  flags: z.array(z.string()),
});

export const ItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  consumed: z.boolean(),
});

export const NatureSchema = z.object({
  name: z.string(),
  increased_stat: z.string().nullable(),
  decreased_stat: z.string().nullable(),
});

export const EVSpreadSchema = z.object({
  hp: z.number(), atk: z.number(), def: z.number(),
  spa: z.number(), spd: z.number(), spe: z.number(),
  label: z.string().optional(),
});

export const SetSchema = z.object({
  id: z.string(),
  pokemon_id: z.string(),
  set_name: z.string(),
  ability: z.string(),
  item: z.string(),
  nature: NatureSchema,
  evs: EVSpreadSchema,
  moves: z.array(z.string()),
  ivs: z.object({
    hp: z.number(), atk: z.number(), def: z.number(),
    spa: z.number(), spd: z.number(), spe: z.number(),
  }),
  role: z.string(),
  tera_type: z.string(),
});

export const EdgeSchema = z.object({
  a_set_id: z.string(),
  b_set_id: z.string(),
  score: z.number(),
  best_move_a_id: z.string(),
  ttk_a: z.number(),
  ttk_b: z.number(),
  dmg_pct_lo: z.number(),
  dmg_pct_hi: z.number(),
});

export const KnowledgePackSchema = z.object({
  version: z.literal(1),
  generated_at: z.string(),
  types: TypeChartSchema,
  species: z.array(SpeciesSchema),
  moves: z.array(MoveSchema),
  abilities: z.array(AbilitySchema),
  items: z.array(ItemSchema),
  sets: z.array(SetSchema),
  edges: z.array(EdgeSchema),
});

export type KnowledgePack = z.infer<typeof KnowledgePackSchema>;
export type Species = z.infer<typeof SpeciesSchema>;
export type Move = z.infer<typeof MoveSchema>;
export type SetEntry = z.infer<typeof SetSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Ability = z.infer<typeof AbilitySchema>;
export type Item = z.infer<typeof ItemSchema>;
export type Nature = z.infer<typeof NatureSchema>;
export type EVSpread = z.infer<typeof EVSpreadSchema>;
