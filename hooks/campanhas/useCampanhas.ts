"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { RitmoDaCampanha } from "@/lib/campanhas/horarios";
import type { CriarCampanha } from "@/lib/campanhas/parametros";
import type {
  CampanhaCriada,
  DetalheDaCampanha,
  PreviaDaCampanha,
  ResumoDaCampanha,
} from "@/lib/campanhas/servico";

const CHAVE = ["campanhas"] as const;

export interface OpcoesDaCampanha {
  etiquetas: { etiqueta: string; contatos: number }[];
  canais: { id: string; nome: string; status: string; telefone: string | null }[];
}

export function useCampanhas() {
  return useQuery({
    queryKey: CHAVE,
    queryFn: async () => (await apiClient.get<{ data: ResumoDaCampanha[] }>("/api/v1/campanhas")).data,
    // A fila anda sozinha (um envio a cada poucos minutos): a lista se atualiza.
    refetchInterval: 60_000,
  });
}

export function useCampanha(id: string) {
  return useQuery({
    queryKey: [...CHAVE, id],
    queryFn: async () => (await apiClient.get<{ data: DetalheDaCampanha }>(`/api/v1/campanhas/${id}`)).data,
    refetchInterval: 30_000,
  });
}

export function useOpcoesDaCampanha(enabled: boolean) {
  return useQuery({
    queryKey: [...CHAVE, "opcoes"],
    enabled,
    queryFn: async () => (await apiClient.get<{ data: OpcoesDaCampanha }>("/api/v1/campanhas/opcoes")).data,
    staleTime: 30_000,
  });
}

export function usePreviaDaCampanha(etiquetas: string[], ritmo: RitmoDaCampanha | null, enabled: boolean) {
  return useQuery({
    queryKey: [...CHAVE, "previa", [...etiquetas].sort().join("|"), ritmo],
    enabled: enabled && etiquetas.length > 0,
    queryFn: async () =>
      (
        await apiClient.post<{ data: PreviaDaCampanha }>("/api/v1/campanhas/previa", {
          etiquetas,
          ...(ritmo ? { ritmo } : {}),
        })
      ).data,
    // A prévia é sobre AGORA: quem pediu para sair há um minuto já não conta.
    staleTime: 0,
    gcTime: 0,
  });
}

export function useCriarCampanha() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pedido: CriarCampanha) =>
      (await apiClient.post<{ data: CampanhaCriada }>("/api/v1/campanhas", pedido)).data,
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}

export function useAcaoDaCampanha(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (acao: "pausar" | "retomar" | "cancelar") =>
      (await apiClient.post<{ data: { afetados: number } }>(`/api/v1/campanhas/${id}/${acao}`, {})).data,
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE }),
  });
}
