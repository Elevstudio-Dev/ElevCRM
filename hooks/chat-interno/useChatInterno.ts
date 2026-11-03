"use client";
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { apiClient } from "@/lib/api/client";
import type { CanalDaEquipe, MensagemDaEquipe } from "@/lib/chat-interno/canais";
import { mencoesDaEquipeParaApi } from "@/lib/mencoes/api";
import type { Mencao } from "@/lib/mencoes/tipos";

export const CANAIS_KEY = ["chat-interno", "canais"] as const;
export const mensagensKey = (channelId: string) => ["chat-interno", "mensagens", channelId] as const;

/** Os canais que eu vejo, com não lidas e última mensagem. */
export function useCanaisDaEquipe(opts?: { enabled?: boolean }) {
  return useQuery({
    queryKey: CANAIS_KEY,
    queryFn: async () => apiClient.get<{ data: CanalDaEquipe[] }>("/api/v1/team-chat/channels"),
    select: (r) => r.data,
    staleTime: 15_000,
    enabled: opts?.enabled ?? true,
  });
}

export function useMensagensDoCanal(channelId: string | null) {
  return useQuery({
    queryKey: mensagensKey(channelId ?? "nenhum"),
    enabled: !!channelId,
    queryFn: async () =>
      apiClient.get<{ data: MensagemDaEquipe[] }>(`/api/v1/team-chat/channels/${channelId}/messages?limit=80`),
    select: (r) => r.data,
    staleTime: 10_000,
  });
}

export function useEnviarMensagemDaEquipe(channelId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ body, mentions }: { body: string; mentions: Mencao[] }) =>
      apiClient.post<{ data: MensagemDaEquipe }>(`/api/v1/team-chat/channels/${channelId}/messages`, {
        body,
        // Só o id e o tipo: o servidor confere quem pode ser marcado e põe o nome.
        mentions: mencoesDaEquipeParaApi(mentions),
      }),
    onSuccess: (res) => {
      if (!channelId) return;
      // A própria mensagem entra na hora — não se espera o realtime devolver o
      // que a gente mesma acabou de escrever.
      qc.setQueryData<{ data: MensagemDaEquipe[] }>(mensagensKey(channelId), (atual) => {
        if (!atual) return atual;
        if (atual.data.some((m) => m.id === res.data.id)) return atual;
        return { ...atual, data: [...atual.data, res.data] };
      });
      qc.invalidateQueries({ queryKey: CANAIS_KEY });
    },
    onError: showApiError,
  });
}

export function useMarcarCanalLido() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => apiClient.post(`/api/v1/team-chat/channels/${channelId}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: CANAIS_KEY }),
  });
}

export function useAbrirConversaDireta() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) =>
      apiClient.post<{ data: { id: string; created: boolean } }>("/api/v1/team-chat/channels/direct", { user_id: userId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: CANAIS_KEY }),
    onError: showApiError,
  });
}

export interface MensagemRecebida {
  id: string;
  channel_id: string;
  sender_user_id: string | null;
  sender_name: string | null;
  body: string;
  /** Quem foi marcado com @ — vem na linha do tempo real (migration 0222). */
  mentions?: Mencao[];
  created_at: string;
}

/**
 * O tempo real do chat: uma assinatura por organização em `team_messages`
 * (INSERT). Cada mensagem nova invalida a lista de canais (contador, última
 * mensagem) e o fio do canal dela — e avisa quem quiser avisar (o sino da
 * barra, quando o painel está fechado).
 *
 * O filtro é por organização, não por canal: uma assinatura só, aberta o
 * tempo inteiro pela barra superior. A RLS decide o que chega — mensagem de
 * canal que eu não vejo não é entregue (o walrus avalia a policy de SELECT
 * por assinante), então o filtro fino já é do banco.
 */
export function useChatInternoRealtime(orgId: string | null, aoReceber?: (m: MensagemRecebida) => void) {
  const qc = useQueryClient();
  const onChange = useCallback(
    (payload: unknown) => {
      const nova = (payload as { new?: MensagemRecebida } | null)?.new;
      if (!nova?.channel_id) return;
      qc.setQueryData<{ data: MensagemDaEquipe[] }>(mensagensKey(nova.channel_id), (atual) => {
        if (!atual) return atual;
        if (atual.data.some((m) => m.id === nova.id)) return atual;
        return { ...atual, data: [...atual.data, nova] };
      });
      qc.invalidateQueries({ queryKey: CANAIS_KEY });
      aoReceber?.(nova);
    },
    [qc, aoReceber],
  );
  return useRealtimeChannel({
    name: orgId ? `chat-interno-${orgId}` : "chat-interno-disabled",
    postgresChanges: orgId
      ? { event: "INSERT", schema: "public", table: "team_messages", filter: `organization_id=eq.${orgId}` }
      : undefined,
    onChange,
    enabled: !!orgId,
  });
}
