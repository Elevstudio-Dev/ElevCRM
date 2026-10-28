"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";

/** Resposta do `POST /api/v1/messages/forward` (o mesmo formato do handler). */
export interface ResultadoDoEncaminhamento {
  destinos: {
    conversation_id: string;
    contato: string | null;
    enviadas: number;
    falhas: { message_id: string; erro: string }[];
  }[];
  total_enviadas: number;
  total_falhas: number;
}

/**
 * Manda as mensagens escolhidas para as conversas escolhidas.
 *
 * Atualiza o fio de CADA destino ao terminar: quem encaminha para uma conversa que está aberta em
 * outra aba precisa ver a mensagem chegar lá sem recarregar.
 */
export function useEncaminhar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { message_ids: string[]; destination_conversation_ids: string[] }) =>
      apiClient
        .post<{ data: ResultadoDoEncaminhamento }>("/api/v1/messages/forward", v)
        .then((r) => r.data),
    onSettled: (_r, _e, v) => {
      for (const id of v?.destination_conversation_ids ?? []) {
        qc.invalidateQueries({ queryKey: ["messages", id] });
      }
      qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/**
 * As conversas para onde se pode encaminhar: as abertas, com a busca por nome/telefone do servidor.
 *
 * Sem busca devolve as mais recentes — é o que a pessoa vê ao abrir o diálogo. Chave própria (e não a
 * da lista do inbox): é outra pergunta, com outro filtro, e misturá-las faria a lista do inbox
 * ser invalidada a cada letra digitada aqui.
 */
export function useConversasParaEncaminhar(busca: string, enabled: boolean) {
  return useQuery({
    queryKey: ["encaminhar-destinos", busca],
    enabled,
    staleTime: 15_000,
    queryFn: () => {
      const qs = new URLSearchParams({ exclude_finished: "true", limit: "20" });
      if (busca.trim()) qs.set("search", busca.trim());
      return apiClient
        .get<{ data: ConversationWithContact[] }>(`/api/v1/conversations?${qs.toString()}`)
        .then((r) => r.data);
    },
  });
}
