"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ParticipanteDoGrupo } from "@/lib/mencoes/grupo";

/**
 * Quem está neste grupo de WhatsApp — a lista do `@` ao escrever para o grupo.
 *
 * `enabled` só em conversa de GRUPO e com a aba "Responder" aberta: o servidor pergunta ao WhatsApp, e
 * perguntar toda vez que alguém abre uma conversa 1:1 seria uma ida ao transporte por nada. Cinco minutos
 * de cache — quem entra e sai do grupo muda pouco, e a lista é só a de escolha.
 */
export function useParticipantesDoGrupo(conversationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["mencoes", "grupo", conversationId],
    enabled: enabled && !!conversationId,
    queryFn: async () =>
      apiClient.get<{ data: ParticipanteDoGrupo[] }>(`/api/v1/conversations/${conversationId}/group-participants`),
    select: (r) => r.data,
    staleTime: 5 * 60_000,
  });
}
