import { z } from "zod";

/**
 * O que a tela manda para conectar a conta de anúncios da Meta.
 *
 * O número da conta aparece no Gerenciador de Anúncios como "ID da conta" (só dígitos) e nas ferramentas da Meta
 * como `act_<dígitos>`: os dois são aceitos e o `act_` sai aqui, para o resto do código lidar com um formato só.
 * A chave é colada como veio (a Meta gera uma sequência longa, sem espaço); espaço ou quebra de linha dentro dela
 * é erro de colagem e é recusado em vez de "consertado" em silêncio.
 */
export const conectarMetaAdsSchema = z.object({
  ad_account_id: z
    .string()
    .trim()
    .regex(/^(act_)?\d{5,20}$/i, "Use só o número da conta de anúncios (pode vir com act_ na frente).")
    .transform((v) => v.replace(/^act_/i, "")),
  token: z
    .string()
    .trim()
    .min(20, "A chave parece curta demais. Cole a chave inteira.")
    .max(1000, "A chave parece longa demais.")
    .regex(/^[A-Za-z0-9_\-.|]+$/, "A chave tem caracteres que não deveriam estar nela. Cole só a chave, sem espaços."),
});

export type ConectarMetaAdsInput = z.infer<typeof conectarMetaAdsSchema>;

/** O estado da conexão, como a tela o recebe. NUNCA inclui a chave. */
export interface EstadoDaConexaoMeta {
  conectada: boolean;
  ad_account_id: string | null;
  account_name: string | null;
  currency: string | null;
  status: "conectada" | "token_invalido" | "erro" | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export const SEM_CONEXAO: EstadoDaConexaoMeta = {
  conectada: false,
  ad_account_id: null,
  account_name: null,
  currency: null,
  status: null,
  last_synced_at: null,
  last_error: null,
};

/** As colunas que a tela pode ver. `token_encrypted` NÃO está aqui, de propósito. */
export const COLUNAS_PUBLICAS_DA_CONEXAO = "ad_account_id, account_name, currency, status, last_synced_at, last_error";
