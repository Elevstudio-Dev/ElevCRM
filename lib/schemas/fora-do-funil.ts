import { z } from "zod";

/** Quantos contatos cabem num pedido só (a seleção em massa da lista). */
export const MAX_CONTATOS_POR_VEZ = 200;

const idsDosContatos = z
  .array(z.string().uuid())
  .min(1, "Escolha ao menos um contato.")
  .max(MAX_CONTATOS_POR_VEZ, `No máximo ${MAX_CONTATOS_POR_VEZ} contatos por vez.`)
  // Repetido na seleção não é erro de quem pediu: conta uma vez.
  .transform((ids) => [...new Set(ids)]);

/** `POST /api/v1/contacts/fora-do-funil` — marcar ou desmarcar um ou vários contatos. */
export const marcarForaDoFunilSchema = z.object({
  contact_ids: idsDosContatos,
  marcar: z.boolean(),
  /**
   * O tipo (Equipe, Contador…). `undefined` = não mexe no tipo de quem já estava marcado; `null` = sem tipo.
   * Ao DESMARCAR é ignorado: sem marcador não há tipo.
   */
  tipo_id: z.string().uuid().nullable().optional(),
});
export type MarcarForaDoFunilInput = z.output<typeof marcarForaDoFunilSchema>;

/** `POST /api/v1/contacts/fora-do-funil/previa` — o que mudaria, sem mudar nada. */
export const previaForaDoFunilSchema = z.object({
  contact_ids: idsDosContatos,
  marcar: z.boolean(),
});
export type PreviaForaDoFunilInput = z.output<typeof previaForaDoFunilSchema>;

const nomeDoTipo = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Dê um nome ao tipo.").max(40, "O nome vai até 40 letras."));

export const criarTipoForaDoFunilSchema = z.object({ nome: nomeDoTipo });
export type CriarTipoForaDoFunilInput = z.output<typeof criarTipoForaDoFunilSchema>;

export const editarTipoForaDoFunilSchema = z
  .object({ nome: nomeDoTipo.optional(), arquivado: z.boolean().optional() })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nada para mudar." });
export type EditarTipoForaDoFunilInput = z.output<typeof editarTipoForaDoFunilSchema>;

export interface TipoForaDoFunil {
  id: string;
  nome: string;
  arquivado_em: string | null;
  created_at: string;
}
export const COLUNAS_DO_TIPO = "id, nome, arquivado_em, created_at";

/** O que o marcador esconde (ao marcar) ou devolve (ao desmarcar) — é o que o diálogo mostra antes de confirmar. */
export interface PreviaDoMarcador {
  /** Quantos dos contatos pedidos existem na organização e MUDARIAM de estado. */
  contatos: number;
  negocios: {
    abertos: number;
    ganhos: number;
    perdidos: number;
    /** Soma do valor dos ganhos em BRL (ou sem moeda), em centavos. */
    valor_ganho_cents: number;
  };
  /** Mais de 1.000 negócios: a contagem é um piso. */
  aproximado: boolean;
}
