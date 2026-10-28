import { z } from "zod";

const texto = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(max));

export const criarQrCodeSchema = z.object({
  nome: texto(80),
  mensagem: texto(300),
  channel_session_id: z.string().uuid(),
});
export type CriarQrCodeInput = z.infer<typeof criarQrCodeSchema>;

export const editarQrCodeSchema = z
  .object({
    nome: texto(80).optional(),
    mensagem: texto(300).optional(),
    channel_session_id: z.string().uuid().optional(),
    arquivado: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nada para mudar." });
export type EditarQrCodeInput = z.infer<typeof editarQrCodeSchema>;

export interface QrCodeRow {
  id: string;
  codigo: string;
  nome: string;
  mensagem: string;
  channel_session_id: string | null;
  arquivado_em: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanalDoQr {
  id: string;
  nome: string | null;
  telefone: string | null;
  conectado: boolean;
}

/** O funil de um QR no período (`GET /api/v1/relatorios/qr-codes`), números já convertidos de bigint. */
export interface FunilDoQr {
  qr_code_id: string;
  leituras: number;
  conversas: number;
  leads: number;
  ganhos: number;
  valor_ganho_cents: number;
}

export const COLUNAS_DO_QR =
  "id, codigo, nome, mensagem, channel_session_id, arquivado_em, created_at, updated_at";
