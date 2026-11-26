/**
 * CPF: normalização, hash e cifra.
 *
 * `contacts` guarda o CPF em DUAS colunas que andam juntas — o banco recusa uma sem a outra
 * (CHECK `contacts_cpf_consistency`):
 *   - `cpf_hash`: sha256 (hex) dos 11 dígitos — busca exata e deduplicação sem expor o número;
 *   - `cpf_encrypted`: o CPF cifrado com a chave mestra pela RPC `encrypt_cpf` (migration 0234).
 *
 * Por isso quem grava CPF usa `camposDoCpf`, que devolve o PAR pronto ou o motivo de não poder gravar —
 * nunca o hash sozinho. Até 25/11/2026 a cifra era "best effort": o erro da RPC (que nem existia) era engolido,
 * o app gravava só o hash e o banco devolvia o erro cru da constraint em toda linha com CPF.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

export function normalizeCpf(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Stable sha256 hex of normalized CPF for fuzzy/exact search via `cpf_hash`.
 */
export function hashCpf(raw: string): string {
  return createHash("sha256").update(normalizeCpf(raw)).digest("hex");
}

/**
 * O motivo que vai para a pessoa quando a cifra falha. Não cita o CPF nem o erro técnico (que vai ao log):
 * diz o que aconteceu com o dado e o que fazer.
 */
export const MOTIVO_CPF_SEM_CIFRA =
  "CPF não gravado: a cifra de CPF não está disponível nesta instalação. Nada foi salvo para este contato — " +
  "avise o suporte e tente de novo depois.";

export type CamposDoCpf =
  | { ok: true; campos: { cpf_hash: string; cpf_encrypted: string } }
  | { ok: false; motivo: string };

/**
 * O par `cpf_hash` + `cpf_encrypted` para gravar, ou o motivo de não poder.
 *
 * A cifra é feita pelo banco (`encrypt_cpf`, chave mestra fora do app) com o client de quem chama — as rotas de
 * contato usam a sessão do usuário. O bytea volta do PostgREST como texto `\x<hex>`, e é esse mesmo texto que o
 * insert/update devolve à coluna `bytea`.
 */
export async function camposDoCpf(supabase: SupabaseClient, cpf: string): Promise<CamposDoCpf> {
  const digitos = normalizeCpf(cpf);
  const { data, error } = await supabase.rpc("encrypt_cpf", { p_plaintext: digitos });
  if (error || typeof data !== "string" || !data.startsWith("\\x")) {
    // Nunca o CPF no log: só a causa técnica (a função não cita a entrada nas mensagens dela).
    logger.warn("[contacts.cpf] encrypt_cpf falhou — CPF não gravado", {
      error: error?.message ?? `retorno inesperado (${typeof data})`,
      code: error?.code,
    });
    return { ok: false, motivo: MOTIVO_CPF_SEM_CIFRA };
  }
  return { ok: true, campos: { cpf_hash: hashCpf(digitos), cpf_encrypted: data } };
}
