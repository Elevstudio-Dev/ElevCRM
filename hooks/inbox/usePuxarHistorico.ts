"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";

/** O que a importação do histórico devolve (ver `app/api/v1/contacts/[id]/historico/route.ts`). */
export interface ResultadoDaImportacao {
  encontradas: number;
  importadas: number;
  ja_existiam: number;
  falharam: number;
  de_anuncio: number;
  contato_marcado_como_anuncio: boolean;
  primeira_em: string | null;
  ultima_em: string | null;
  limite_atingido: boolean;
}

/**
 * Puxar do WhatsApp as mensagens antigas de UM contato. O erro NÃO vai para o toast global: o diálogo mostra a
 * explicação no lugar (a mais comum — "o canal não guarda histórico" — pede uma ação da equipe técnica e precisa
 * ser lida com calma, não numa notificação que some).
 */
export function usePuxarHistorico(contactId: string, conversationId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["contacts", "historico", contactId],
    mutationFn: async () => {
      const res = await apiClient.post<{ data: ResultadoDaImportacao }>(`/api/v1/contacts/${contactId}/historico`, {});
      return res.data;
    },
    onSuccess: () => {
      // A conversa aberta passa a mostrar as mensagens novas; a lista e o painel acompanham.
      if (conversationId) void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["crm-summary"] });
    },
  });
}
