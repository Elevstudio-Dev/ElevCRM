"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";

/**
 * Os retornos que uma PESSOA marca para a IA retomar a conversa com um cliente, e a leitura deles.
 * A regra (janela, um retorno vivo por cliente, timeline) vive no servidor: `lib/followup/retorno.ts`.
 */
export interface RetornoDoContato {
  id: string;
  /** Quando a IA vai retomar. ISO. */
  quando: string;
  situacao: "agendado" | "disparado" | "cancelado";
  /** O que a pessoa pediu que a IA faça (só nos retornos marcados pela equipe). */
  instrucao: string | null;
  motivo: string;
  promessa: string | null;
}

export const retornosDoContatoKey = (contactId: string) => ["followup", "retornos", contactId] as const;

export function useRetornosDoContato(contactId: string | null) {
  return useQuery({
    queryKey: retornosDoContatoKey(contactId ?? "nenhum"),
    enabled: contactId !== null,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await apiClient.get<{ data: { retornos: RetornoDoContato[] } }>(
        `/api/v1/ai/followups/promises?contact_id=${contactId}`,
      );
      return res.data.retornos;
    },
  });
}

/** O retorno que ainda vai acontecer, se houver — no máximo um por cliente. */
export function retornoVivo(retornos: RetornoDoContato[] | undefined): RetornoDoContato | null {
  return (retornos ?? []).find((r) => r.situacao === "agendado") ?? null;
}

export function useAgendarRetorno(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "promises", "create"],
    mutationFn: async (args: { quando: string; instrucao: string }) => {
      const res = await apiClient.post<{ data: { id: string; quando: string } }>("/api/v1/ai/followups/promises", {
        contact_id: contactId,
        quando: args.quando,
        instrucao: args.instrucao,
      });
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: retornosDoContatoKey(contactId) });
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
    },
    onError: showApiError,
  });
}

export function useDesmarcarRetorno(contactId: string) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["followup", "promises", "cancel", "contato"],
    mutationFn: async (retornoId: string) =>
      apiClient.post<{ data: { id: string } }>(`/api/v1/ai/followups/promises/${retornoId}/cancel`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: retornosDoContatoKey(contactId) });
      void qc.invalidateQueries({ queryKey: ["followup", "queue"] });
      toast.success(t("Follow-up desmarcado."));
    },
    onError: showApiError,
  });
}
