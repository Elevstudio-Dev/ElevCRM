"use client";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import type { DiaDaSerie, GrupoDoRelatorio, Totais } from "@/lib/relatorios/origens";

export interface RelatorioDeOrigens {
  grupos: GrupoDoRelatorio[];
  total: Totais;
  serie: DiaDaSerie[];
}

export function useRelatorioDeOrigens(p: { de: string; ate: string; fuso: string }, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["relatorios", "origens", p],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const qs = new URLSearchParams(p);
      const r = await apiClient.get<{ data: RelatorioDeOrigens }>(`/api/v1/relatorios/origens?${qs.toString()}`);
      return r.data;
    },
    staleTime: 60_000,
  });
}
