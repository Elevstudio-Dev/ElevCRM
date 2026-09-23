"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { ClienteDoDespacho } from "@/lib/integrations/despachocerto/contrato";

/**
 * O INTERRUPTOR DA INTEGRAÇÃO, do lado da tela.
 *
 * `staleTime` alto de propósito: a resposta é "esta organização tem a
 * integração ligada?", que muda quando um admin salva a configuração — não a
 * cada conversa aberta. Sem isso, cada troca de conversa no inbox faria uma
 * requisição para perguntar de novo a mesma coisa.
 */
export interface EstadoDaIntegracao {
  conectado: boolean;
  status?: string;
  status_reason?: string | null;
  base_url?: string;
  webhook_url?: string;
  tem_segredo?: boolean;
}

export const CHAVE_DA_INTEGRACAO = ["integrations", "despachocerto"] as const;

export function useDespachoCerto() {
  return useQuery<EstadoDaIntegracao>({
    queryKey: CHAVE_DA_INTEGRACAO,
    queryFn: () => apiClient.get<EstadoDaIntegracao>("/api/v1/integrations/despachocerto"),
    staleTime: 5 * 60_000,
    // Integração desligada é o caso NORMAL (o CRM não é só para despachante):
    // não vale repetir a pergunta quando ela falha.
    retry: false,
  });
}

export interface VinculoDoContato {
  vinculado: boolean;
  external_id?: string;
  name?: string | null;
  url?: string | null;
}

/** Este contato já é cliente lá? Pergunta só quando a integração está ligada. */
export function useVinculoDoContato(contactId: string | null, ligada: boolean) {
  return useQuery<VinculoDoContato>({
    queryKey: ["integrations", "despachocerto", "vinculo", contactId],
    queryFn: () =>
      apiClient.get<VinculoDoContato>(
        `/api/v1/integrations/despachocerto/clients/${contactId}`,
      ),
    enabled: Boolean(contactId) && ligada,
    staleTime: 60_000,
    retry: false,
  });
}

export interface CadastroPedido {
  contact_id: string;
  name: string;
  phone: string;
  document?: string;
  email?: string;
  notes?: string;
  plate?: string;
  type: "pessoa_fisica" | "pessoa_juridica";
}

export function useCadastrarNoDespachoCerto() {
  const qc = useQueryClient();
  return useMutation<{ cliente: ClienteDoDespacho; existente: boolean }, Error, CadastroPedido>({
    mutationFn: (dados) =>
      apiClient.post<{ cliente: ClienteDoDespacho; existente: boolean }>(
        "/api/v1/integrations/despachocerto/clients",
        dados,
      ),
    onSuccess: (_r, enviado) => {
      void qc.invalidateQueries({
        queryKey: ["integrations", "despachocerto", "vinculo", enviado.contact_id],
      });
    },
  });
}
