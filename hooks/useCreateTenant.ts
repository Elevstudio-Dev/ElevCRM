"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type { ConviteEmitido } from "@/hooks/useOwnerInvite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateTenantPayload {
  display_name: string;
  slug: string;
  legal_name?: string;
  cnpj?: string;
  plan?: "standard" | "pro" | "enterprise";
  owner_email: string;
}

export interface CreateTenantResponse {
  data: {
    id: string;
    slug: string;
    display_name: string;
    /** O convite de admin emitido ao responsável; `null` se a emissão falhou (ver abaixo). */
    owner_invite: ConviteEmitido | null;
    /** Presente só quando o tenant foi criado mas o convite NÃO: reemitir pela ficha do tenant. */
    owner_invite_error?: string;
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCreateTenant() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: CreateTenantPayload) =>
      apiClient.post<CreateTenantResponse>("/api/v1/admin/tenants", payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
    },
  });
}
