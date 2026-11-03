"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { mencoesDaEquipeParaApi } from "@/lib/mencoes/api";
import type { Mencao } from "@/lib/mencoes/tipos";
import type { Note } from "@/lib/types/messaging";

interface CreateNoteArgs {
  conversation_id: string;
  body: string;
  /** Quem foi marcado com @ — o servidor confere se a pessoa enxerga a conversa. */
  mentions?: Mencao[];
}

export function useCreateNote() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ conversation_id, body, mentions }: CreateNoteArgs) =>
      apiClient.post<{ data: Note }>(`/api/v1/conversations/${conversation_id}/notes`, {
        body,
        ...(mentions && mentions.length > 0 ? { mentions: mencoesDaEquipeParaApi(mentions) } : {}),
      }),
    onSuccess: (_res, args) => {
      qc.invalidateQueries({ queryKey: ["notes", args.conversation_id] });
    },
    onError: showApiError,
  });
}
