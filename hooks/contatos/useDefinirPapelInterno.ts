"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { PapelInterno } from "@/lib/bastidor/papeis";

/** Define (ou tira, com `null`) o papel de um contato da equipe: secretaria ou marketing. */
export function useDefinirPapelInterno() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contactId: string; papel: PapelInterno | null }) => {
      const r = await apiClient.put<{ data: { papel: PapelInterno | null; alterado: boolean; fora_do_funil: boolean } }>(
        `/api/v1/contacts/${input.contactId}/papel-interno`,
        { papel: input.papel },
      );
      return r.data;
    },
    onError: showApiError,
    // O papel também põe o contato fora do funil: muda lista, conversa, quadro e relatório. Recarrega o que está aberto.
    onSuccess: () => qc.invalidateQueries(),
  });
}
