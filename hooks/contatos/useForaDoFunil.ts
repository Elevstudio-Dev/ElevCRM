"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { PreviaDoMarcador, TipoForaDoFunil } from "@/lib/schemas/fora-do-funil";

const TIPOS_KEY = ["tipos-fora-do-funil"] as const;

/** Os tipos que o dono cadastra. Só os em uso por padrão; com `arquivados`, também os que saíram da lista de escolha. */
export function useTiposForaDoFunil(opts: { arquivados?: boolean; enabled?: boolean } = {}) {
  const arquivados = opts.arquivados ?? false;
  return useQuery({
    queryKey: [...TIPOS_KEY, { arquivados }],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const r = await apiClient.get<{ data: TipoForaDoFunil[] }>(
        `/api/v1/tipos-fora-do-funil${arquivados ? "?arquivados=1" : ""}`,
      );
      return r.data;
    },
    staleTime: 60_000,
    // Quem não pode ler (visualizador) só perde o NOME do tipo no selo — não é erro para a pessoa.
    retry: false,
  });
}

/** O que mudaria se esta seleção fosse marcada (ou desmarcada). Só consulta; nada é alterado. */
export function usePreviaDoMarcador(contactIds: string[], marcar: boolean, enabled: boolean) {
  const chave = [...contactIds].sort().join(",");
  return useQuery({
    queryKey: ["fora-do-funil", "previa", chave, marcar],
    enabled: enabled && contactIds.length > 0,
    queryFn: async () => {
      const r = await apiClient.post<{ data: PreviaDoMarcador }>("/api/v1/contacts/fora-do-funil/previa", {
        contact_ids: contactIds,
        marcar,
      });
      return r.data;
    },
    // A prévia é sobre o estado de AGORA: reaproveitar uma de minutos atrás diria um número velho no diálogo.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useMarcarForaDoFunil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { contact_ids: string[]; marcar: boolean; tipo_id?: string | null }) => {
      const r = await apiClient.post<{ data: { alterados: number; previa: PreviaDoMarcador } }>(
        "/api/v1/contacts/fora-do-funil",
        input,
      );
      return r.data;
    },
    onError: showApiError,
    // Mexe no que a pessoa vê em muitos lugares (lista, conversa, quadro, relatório): recarrega tudo que está aberto.
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useCriarTipoForaDoFunil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (nome: string) => {
      const r = await apiClient.post<{ data: TipoForaDoFunil }>("/api/v1/tipos-fora-do-funil", { nome });
      return r.data;
    },
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TIPOS_KEY }),
  });
}

export function useEditarTipoForaDoFunil() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...corpo }: { id: string; nome?: string; arquivado?: boolean }) => {
      const r = await apiClient.patch<{ data: TipoForaDoFunil }>(`/api/v1/tipos-fora-do-funil/${id}`, corpo);
      return r.data;
    },
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: TIPOS_KEY }),
  });
}
