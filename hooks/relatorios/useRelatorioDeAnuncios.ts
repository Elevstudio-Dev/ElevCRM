"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { AnuncioDoRelatorio, Desempenho } from "@/lib/relatorios/anuncios";
import type { EstadoDaConexaoMeta } from "@/lib/schemas/meta-ads";

export interface RelatorioDeAnuncios {
  anuncios: AnuncioDoRelatorio[];
  total: Desempenho;
  conexao: EstadoDaConexaoMeta;
}

export function useRelatorioDeAnuncios(p: { de: string; ate: string; fuso: string }, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["relatorios", "anuncios", p],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const qs = new URLSearchParams(p);
      const r = await apiClient.get<{ data: RelatorioDeAnuncios }>(`/api/v1/relatorios/anuncios?${qs.toString()}`);
      return r.data;
    },
    staleTime: 60_000,
  });
}
