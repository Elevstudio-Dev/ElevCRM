/**
 * ALGUM CANAL DESTA ORGANIZAÇÃO SÓ ENTREGA FORA DAS 24 H COM MODELO APROVADO?
 *
 * Pergunta de CAPACIDADE, não de nome (invariante 1 da doutrina de restrição de canal): a
 * tela de tipos de agendamento precisa saber se um lembrete ligado SEM modelo vai ficar
 * esperando, e quem responde é `freeformOutsideWindow` — a tela nunca vê qual provedor é.
 *
 * Mora aqui, e não como `select` na tela, pela mesma razão de `listSelectableChannels`:
 * cada tela que escrevia a própria consulta a `channel_sessions` esqueceu o filtro de canal
 * arquivado (`tests/unit/canais-selecionaveis.test.ts` varre as telas por isso). Canal
 * excluído não conta — o número já foi deslogado e a credencial revogada.
 *
 * Erro de leitura SOBE: devolver `false` com a consulta quebrada esconderia o aviso
 * justamente quando o operador mais precisa dele.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ARCHIVED_AT, queryTolerantToMissingArchived } from "./archived";
import { capabilitiesOf } from "./capabilities";
import type { ChannelProvider } from "./types";

export async function algumCanalExigeModelo(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const base = () => db.from("channel_sessions").select("provider").eq("organization_id", organizationId);

  const { data, error } = await queryTolerantToMissingArchived(
    () => base().is(ARCHIVED_AT, null),
    () => base(),
  );
  if (error) throw new Error(`channel_sessions_list_failed: ${error.message ?? "unknown"}`);

  // `provider` é NOT NULL com default na 0087; um valor fora da matriz levanta em
  // `capabilitiesOf` (fail-closed), que é o que se quer de um dado que não devia existir.
  return ((data ?? []) as Array<{ provider: string }>).some(
    (c) => !capabilitiesOf(c.provider as ChannelProvider).freeformOutsideWindow,
  );
}
