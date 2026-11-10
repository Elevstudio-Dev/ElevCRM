/**
 * SINCRONIZAR O GASTO DE UMA ORGANIZAÇÃO — Meta → `meta_ads_gasto_diario`.
 *
 * Quem chama (o cron de hora em hora e o botão "Atualizar agora") só passa a organização: a chave é lida e
 * decifrada AQUI, no servidor, e nunca sai desta função. O resultado devolvido à tela é um código e contagens.
 *
 * A janela: a primeira vez, 90 dias; depois, 35 dias — a Meta corrige números de dias passados (cliques inválidos
 * são descontados, o faturamento fecha), então reler o último mês mantém o gasto igual ao do Gerenciador. A
 * gravação é `upsert` pela chave (organização, dia, anúncio): rodar duas vezes não duplica nada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

import { lerGastoPorAnuncio, MetaAdsError, type ErroDaMeta } from "@/lib/channels/meta/ads-graph";

export const DIAS_NA_PRIMEIRA_VEZ = 90;
export const DIAS_NAS_SEGUINTES = 35;
const LOTE = 500;

const MENSAGEM_DO_ERRO: Record<ErroDaMeta | "chave_ilegivel" | "gravacao", string> = {
  token_invalido: "A Meta recusou a chave (expirada ou revogada). Gere uma nova e conecte de novo.",
  sem_permissao: "A chave não tem permissão para ler esta conta de anúncios.",
  limite: "A Meta pediu para esperar um pouco. Tentaremos de novo na próxima hora.",
  conta_invalida: "A Meta não encontrou esta conta de anúncios. Confira o número.",
  indisponivel: "Não foi possível falar com a Meta agora. Tentaremos de novo.",
  chave_ilegivel: "A chave guardada não pôde ser lida. Conecte de novo.",
  gravacao: "Os números chegaram, mas não foi possível gravá-los. Tentaremos de novo.",
};

export function mensagemDoErro(codigo: keyof typeof MENSAGEM_DO_ERRO): string {
  return MENSAGEM_DO_ERRO[codigo];
}

export type ResultadoDaSincronizacao =
  | { ok: true; linhas: number; descartadas: number }
  | { ok: false; erro: keyof typeof MENSAGEM_DO_ERRO | "sem_conexao" };

const dia = (d: Date): string => d.toISOString().slice(0, 10);

export async function sincronizarOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
  opts: { fetcher?: typeof fetch; agora?: Date } = {},
): Promise<ResultadoDaSincronizacao> {
  const agora = opts.agora ?? new Date();

  const { data: con, error: leitura } = await admin
    .from("meta_ads_conexoes")
    .select("ad_account_id, currency, token_encrypted, last_synced_at")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (leitura || !con) return { ok: false, erro: "sem_conexao" };

  const marcar = async (status: "conectada" | "token_invalido" | "erro", erro: string | null, sincronizou: boolean) => {
    await admin
      .from("meta_ads_conexoes")
      .update({
        status,
        last_error: erro,
        updated_at: agora.toISOString(),
        ...(sincronizou ? { last_synced_at: agora.toISOString() } : {}),
      })
      .eq("organization_id", organizationId);
  };

  const token = await decryptWebhookSecret(admin, String(con.token_encrypted));
  if (!token) {
    await marcar("erro", MENSAGEM_DO_ERRO.chave_ilegivel, false);
    return { ok: false, erro: "chave_ilegivel" };
  }

  const dias = con.last_synced_at ? DIAS_NAS_SEGUINTES : DIAS_NA_PRIMEIRA_VEZ;
  const de = dia(new Date(agora.getTime() - dias * 86_400_000));
  const ate = dia(agora);

  let resultado;
  try {
    resultado = await lerGastoPorAnuncio(
      String(con.ad_account_id),
      token,
      de,
      ate,
      (con.currency as string | null) ?? null,
      opts.fetcher,
    );
  } catch (err) {
    const codigo: ErroDaMeta = err instanceof MetaAdsError ? err.codigo : "indisponivel";
    // Só o CÓDIGO vai ao log: a resposta de um terceiro não entra em log nosso.
    logger.warn("[meta-ads] sincronização falhou", { organization_id: organizationId, codigo });
    await marcar(codigo === "token_invalido" ? "token_invalido" : "erro", MENSAGEM_DO_ERRO[codigo], false);
    return { ok: false, erro: codigo };
  }

  const linhas = resultado.linhas.map((l) => ({
    ...l,
    organization_id: organizationId,
    updated_at: agora.toISOString(),
  }));
  for (let i = 0; i < linhas.length; i += LOTE) {
    const { error } = await admin
      .from("meta_ads_gasto_diario")
      .upsert(linhas.slice(i, i + LOTE), { onConflict: "organization_id,dia,ad_id" });
    if (error) {
      logger.warn("[meta-ads] gravação falhou", { organization_id: organizationId });
      await marcar("erro", MENSAGEM_DO_ERRO.gravacao, false);
      return { ok: false, erro: "gravacao" };
    }
  }

  await marcar("conectada", null, true);
  return { ok: true, linhas: linhas.length, descartadas: resultado.descartadas };
}
