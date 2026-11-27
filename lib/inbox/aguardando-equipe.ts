/**
 * "AGUARDANDO EQUIPE" — a conversa em que a IA passou um pedido para a equipe
 * (um caso em `awaiting_human`, aberto com `open_human_case`) e ninguém da
 * equipe respondeu ainda.
 *
 * ─── Por que não é uma coluna nova ──────────────────────────────────────────
 * O caso JÁ é a fonte da verdade: tem a conversa, a hora em que abriu e o
 * estado. Guardar a mesma coisa numa coluna da conversa seria um segundo
 * lugar para ficar fora de sincronia — o selo dizendo "aguardando" de um caso
 * que alguém fechou pela tela de Casos.
 *
 * ─── Quando o selo some ─────────────────────────────────────────────────────
 * Quando uma PESSOA da equipe manda mensagem naquela conversa: o caso aberto é
 * resolvido ali mesmo (`fecharCasosAoResponder`, chamado pelo envio). Mensagem
 * da IA, de automação ou de campanha não fecha — elas não são a resposta que a
 * equipe deve.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** `conversation_id → abertura do caso mais antigo que espera a equipe`. */
export async function aguardandoEquipePorConversa(
  db: SupabaseClient,
  organizationId: string,
  conversationIds: readonly string[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  if (conversationIds.length === 0) return mapa;
  const { data, error } = await db
    .from("agent_cases")
    .select("conversation_id, opened_at")
    .eq("organization_id", organizationId)
    .eq("status", "awaiting_human")
    .in("conversation_id", [...conversationIds]);
  // O selo é aviso, não condição: sem ele a lista continua servindo. Falha vira
  // log, e a caixa abre igual — só sem a marca roxa desta vez.
  if (error) {
    logger.warn("[inbox] aguardando-equipe: leitura dos casos falhou", { error: error.message });
    return mapa;
  }
  for (const r of (data ?? []) as { conversation_id: string; opened_at: string }[]) {
    const antes = mapa.get(r.conversation_id);
    if (!antes || r.opened_at < antes) mapa.set(r.conversation_id, r.opened_at);
  }
  return mapa;
}

/** Acrescenta `aguardando_equipe_desde` (ou `null`) em cada conversa. */
export async function anexarAguardandoEquipe<T extends { id: string }>(
  db: SupabaseClient,
  organizationId: string,
  conversas: T[],
): Promise<Array<T & { aguardando_equipe_desde: string | null }>> {
  const mapa = await aguardandoEquipePorConversa(
    db,
    organizationId,
    conversas.map((c) => c.id),
  );
  return conversas.map((c) => ({ ...c, aguardando_equipe_desde: mapa.get(c.id) ?? null }));
}

/**
 * Uma pessoa da equipe respondeu: os casos que esperavam por ela nesta conversa
 * são resolvidos, com o registro de quem respondeu. Mesmos dois eventos de
 * `resolveCaseFromHuman` (`human_replied` com `resolved`, e `resolved`), para a
 * tela de Casos contar a história igual.
 *
 * Melhor esforço: a mensagem JÁ saiu quando isto roda, e uma falha aqui não
 * pode virar erro de envio na tela de quem respondeu.
 */
export async function fecharCasosAoResponder(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
  userId: string,
): Promise<number> {
  try {
    const agora = new Date().toISOString();
    const { data, error } = await db
      .from("agent_cases")
      .update({ status: "resolved", closed_at: agora, updated_at: agora })
      .eq("organization_id", organizationId)
      .eq("conversation_id", conversationId)
      .eq("status", "awaiting_human")
      .select("id");
    if (error) throw new Error(error.message);
    const ids = ((data ?? []) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    const eventos = ids.flatMap((caseId) => [
      {
        organization_id: organizationId,
        case_id: caseId,
        kind: "human_replied",
        actor_kind: "human",
        actor_user_id: userId,
        human_action: "resolved",
        body: "A equipe respondeu direto na conversa.",
      },
      {
        organization_id: organizationId,
        case_id: caseId,
        kind: "resolved",
        actor_kind: "human",
        actor_user_id: userId,
      },
    ]);
    const { error: evErr } = await db.from("agent_case_events").insert(eventos);
    if (evErr) logger.warn("[inbox] aguardando-equipe: eventos do caso não gravados", { error: evErr.message });
    return ids.length;
  } catch (err) {
    logger.warn("[inbox] aguardando-equipe: fechar o caso na resposta falhou", {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
