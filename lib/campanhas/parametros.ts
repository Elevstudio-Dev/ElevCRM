/**
 * O que uma campanha guarda (em `followup_flow_pointers.trigger_config.params`)
 * e o corpo do pedido de criação.
 */
import { z } from "zod";

import { ritmoDaCampanhaSchema } from "./horarios";

export const ESTADOS_DA_CAMPANHA = ["enviando", "pausada", "cancelada"] as const;
export type EstadoDaCampanha = (typeof ESTADOS_DA_CAMPANHA)[number];

const etiquetasSchema = z.array(z.string().trim().min(1).max(60)).min(1).max(10);

export const campanhaParamsSchema = z.strictObject({
  etiquetas: etiquetasSchema,
  canal_id: z.string().uuid(),
  objetivo: z.string().trim().min(10).max(800),
  ritmo: ritmoDaCampanhaSchema,
  estado: z.enum(ESTADOS_DA_CAMPANHA),
});
export type CampanhaParams = z.infer<typeof campanhaParamsSchema>;

export const previaDaCampanhaSchema = z.strictObject({
  etiquetas: etiquetasSchema,
  ritmo: ritmoDaCampanhaSchema.optional(),
});

export const criarCampanhaSchema = z.strictObject({
  nome: z.string().trim().min(1).max(60),
  etiquetas: etiquetasSchema,
  canal_id: z.string().uuid(),
  objetivo: z.string().trim().min(10).max(800),
  ritmo: ritmoDaCampanhaSchema,
});
export type CriarCampanha = z.infer<typeof criarCampanhaSchema>;
