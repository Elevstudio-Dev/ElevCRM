"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** O convite de admin que a plataforma emitiu para o responsável (dono) de um tenant. */
export interface ConviteEmitido {
  email: string;
  invite_id: string;
  expires_at: string;
  /** `false` = o e-mail não saiu; o operador precisa entregar `accept_url` por outro canal. */
  email_dispatched: boolean;
  accept_url: string;
}

export interface OwnerInviteResponse {
  data: { owner_invite: ConviteEmitido };
}

/**
 * POST /api/v1/admin/tenants/[id]/owner-invite — reemite o convite do responsável.
 * O convite vale 24h e não fica guardado em lugar nenhum: este é o jeito de gerar outro.
 */
export function useOwnerInvite(tenantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (email: string) =>
      apiClient.post<OwnerInviteResponse>(`/api/v1/admin/tenants/${tenantId}/owner-invite`, { email }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenant", tenantId] });
    },
  });
}
