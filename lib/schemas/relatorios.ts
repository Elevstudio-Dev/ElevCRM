import { z } from "zod";

import { meiaNoiteNoFuso, somarDias } from "@/lib/relatorios/periodo";

const DATA = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_MAXIMOS = 366;

/** `2026-02-31` casa o formato e não existe: ida e volta pelo calendário desmascara. */
function dataExiste(ymd: string): boolean {
  const [a, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d)).toISOString().slice(0, 10) === ymd;
}

function diasEntre(de: string, ate: string): number {
  const [a1, m1, d1] = de.split("-").map(Number) as [number, number, number];
  const [a2, m2, d2] = ate.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a1, m1 - 1, d1)) / 86_400_000);
}

/**
 * Query do relatório: `?de=YYYY-MM-DD&ate=YYYY-MM-DD&fuso=America/Sao_Paulo`.
 *
 * Devolve instantes prontos para o banco: `de` é a meia-noite do primeiro dia NO FUSO e `ate` é a meia-noite do dia
 * SEGUINTE ao último (exclusivo) — o dia final entra inteiro, e as funções do banco filtram `< ate`.
 */
export const periodoSchema = z
  .object({
    de: z.string().regex(DATA),
    ate: z.string().regex(DATA),
    fuso: z
      .string()
      .max(64)
      .regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/)
      .default("America/Sao_Paulo"),
  })
  .transform((v, ctx) => {
    if (!dataExiste(v.de) || !dataExiste(v.ate)) {
      ctx.addIssue({ code: "custom", message: "Data inválida." });
      return z.NEVER;
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v.fuso });
    } catch {
      ctx.addIssue({ code: "custom", message: "Fuso horário inválido.", path: ["fuso"] });
      return z.NEVER;
    }
    const dias = diasEntre(v.de, v.ate) + 1;
    if (dias < 1) {
      ctx.addIssue({ code: "custom", message: "A data final vem antes da inicial.", path: ["ate"] });
      return z.NEVER;
    }
    if (dias > DIAS_MAXIMOS) {
      ctx.addIssue({ code: "custom", message: `O período vai até ${DIAS_MAXIMOS} dias.`, path: ["ate"] });
      return z.NEVER;
    }
    return {
      de: meiaNoiteNoFuso(v.de, v.fuso),
      ate: meiaNoiteNoFuso(somarDias(v.ate, 1), v.fuso),
      fuso: v.fuso,
    };
  });
export type PeriodoDoRelatorio = z.output<typeof periodoSchema>;
