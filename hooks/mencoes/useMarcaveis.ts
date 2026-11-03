"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { MarcavelDaEquipe } from "@/lib/mencoes/candidatos";

/**
 * Quem pode ser marcado com @ numa nota interna desta conversa — os colegas que
 * a enxergam. A lista vem do servidor (que pergunta ao banco), e não de "todos os
 * membros": marcar quem não abre a conversa seria avisá-lo de algo que ele não vê.
 */
export function useMarcaveisDaConversa(conversationId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["mencoes", "conversa", conversationId],
    enabled: enabled && !!conversationId,
    queryFn: async () =>
      apiClient.get<{ data: MarcavelDaEquipe[] }>(`/api/v1/conversations/${conversationId}/mentionable`),
    select: (r) => r.data,
    staleTime: 60_000,
  });
}

/** Quem pode ser marcado neste canal do chat da equipe (vazio no canal direto). */
export function useMarcaveisDoCanal(channelId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["mencoes", "canal", channelId],
    enabled: enabled && !!channelId,
    queryFn: async () =>
      apiClient.get<{ data: MarcavelDaEquipe[] }>(`/api/v1/team-chat/channels/${channelId}/mentionable`),
    select: (r) => r.data,
    staleTime: 60_000,
  });
}
