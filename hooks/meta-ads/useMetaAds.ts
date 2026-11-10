"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { ConectarMetaAdsInput, EstadoDaConexaoMeta } from "@/lib/schemas/meta-ads";

const CHAVE = ["meta-ads", "conexao"];

/** O estado da conexão (nunca a chave). */
export function useConexaoMetaAds() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: EstadoDaConexaoMeta }>("/api/v1/meta-ads/conexao")).data,
    staleTime: 15_000,
  });
}

export function useConectarMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConectarMetaAdsInput) =>
      (await apiClient.put<{ data: EstadoDaConexaoMeta }>("/api/v1/meta-ads/conexao", input)).data,
    onError: showApiError,
    onSuccess: (estado) => {
      qc.setQueryData(CHAVE, estado);
      void qc.invalidateQueries({ queryKey: ["relatorios"] });
    },
  });
}

export function useDesconectarMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await apiClient.delete<{ data: EstadoDaConexaoMeta }>("/api/v1/meta-ads/conexao")).data,
    onError: showApiError,
    onSuccess: (estado) => {
      qc.setQueryData(CHAVE, estado);
      void qc.invalidateQueries({ queryKey: ["relatorios"] });
    },
  });
}

export interface ResultadoDoAtualizar {
  atualizou: boolean;
  jaAtualizado: boolean;
  linhas?: number;
  mensagem: string | null;
}

export function useAtualizarMetaAds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      (await apiClient.post<{ data: ResultadoDoAtualizar }>("/api/v1/meta-ads/sincronizar", {})).data,
    onError: showApiError,
    // Com sucesso OU com a frase da Meta: a conexão guarda o estado novo, e o relatório relê o gasto.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: CHAVE });
      void qc.invalidateQueries({ queryKey: ["relatorios"] });
    },
  });
}
