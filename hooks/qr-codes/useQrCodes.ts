"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type {
  CanalDoQr,
  CriarQrCodeInput,
  EditarQrCodeInput,
  FunilDoQr,
  QrCodeRow,
} from "@/lib/schemas/qr-codes";

const QR_CODES_KEY = ["qr-codes"];

export function useQrCodes() {
  return useQuery({
    queryKey: QR_CODES_KEY,
    queryFn: async () => {
      const r = await apiClient.get<{ data: { qr_codes: QrCodeRow[]; canais: CanalDoQr[] } }>("/api/v1/qr-codes");
      return r.data;
    },
    staleTime: 15_000,
  });
}

/** O funil de TODOS os QRs da organização no período (leituras → conversas → leads → vendas). */
export function useFunilDosQrCodes(p: { de: string; ate: string; fuso: string }, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["relatorios", "qr-codes", p],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const qs = new URLSearchParams(p);
      const r = await apiClient.get<{ data: { funil: FunilDoQr[] } }>(`/api/v1/relatorios/qr-codes?${qs.toString()}`);
      return r.data.funil;
    },
    staleTime: 60_000,
  });
}

export function useCriarQrCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CriarQrCodeInput) => apiClient.post<{ data: QrCodeRow }>("/api/v1/qr-codes", input),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: QR_CODES_KEY }),
  });
}

export function useEditarQrCode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: EditarQrCodeInput & { id: string }) =>
      apiClient.patch<{ data: QrCodeRow }>(`/api/v1/qr-codes/${id}`, input),
    onError: showApiError,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: QR_CODES_KEY });
      void qc.invalidateQueries({ queryKey: ["relatorios"] });
    },
  });
}
