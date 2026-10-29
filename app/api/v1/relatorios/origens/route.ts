/**
 * GET /api/v1/relatorios/origens?de&ate&fuso — de onde os leads vêm até a venda (gestor+).
 *
 * O gate é `manager`; as funções do banco são `security invoker`, então a RLS vale ATRAVÉS delas (um gestor
 * pedindo a organização de outro recebe zero linhas). Agregar no banco não é estilo: o PostgREST corta em 1.000
 * linhas, e somar leads em JS mentiria em silêncio na primeira organização com 1.001 leads no período.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { agruparOrigens, serieDiaria, type LinhaDeOrigem } from "@/lib/relatorios/origens";
import { periodoSchema } from "@/lib/schemas/relatorios";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** As colunas de `fn_relatorio_de_origens`; os contadores são `bigint` e chegam como número ou como texto. */
interface LinhaBruta {
  source: string;
  detalhe: string | null;
  leads: number | string;
  abertos: number | string;
  ganhos: number | string;
  perdidos: number | string;
  valor_ganho_cents: number | string;
}
interface LinhaPorDiaBruta {
  dia: string;
  source: string;
  leads: number | string;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "relatorios", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const q = new URL(req.url).searchParams;
  const parsed = periodoSchema.safeParse({
    de: q.get("de"),
    ate: q.get("ate"),
    ...(q.get("fuso") ? { fuso: q.get("fuso") } : {}),
  });
  if (!parsed.success) {
    return fail("validation_failed", "Período inválido.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { de, ate, fuso } = parsed.data;

  const supabase = await createClient();
  const [origens, porDia, qrs, fontes] = await Promise.all([
    supabase.rpc("fn_relatorio_de_origens", { p_org: orgId, p_de: de.toISOString(), p_ate: ate.toISOString() }),
    supabase.rpc("fn_relatorio_de_origens_por_dia", {
      p_org: orgId,
      p_de: de.toISOString(),
      p_ate: ate.toISOString(),
      p_fuso: fuso,
    }),
    supabase.from("qr_codes").select("id, nome").eq("organization_id", orgId),
    supabase.from("webhook_sources").select("id, name").eq("organization_id", orgId),
  ]);
  const erro = origens.error ?? porDia.error ?? qrs.error ?? fontes.error;
  if (erro) return fail("internal_error", erro.message, 500, { requestId });

  // O PostgREST devolve `bigint` como número OU texto conforme o tamanho — `Number()` em tudo.
  const linhas: LinhaDeOrigem[] = ((origens.data ?? []) as LinhaBruta[]).map((l) => ({
    source: l.source,
    detalhe: l.detalhe,
    leads: Number(l.leads),
    abertos: Number(l.abertos),
    ganhos: Number(l.ganhos),
    perdidos: Number(l.perdidos),
    valor_ganho_cents: Number(l.valor_ganho_cents),
  }));
  const { grupos, total } = agruparOrigens(linhas, {
    qr: new Map(((qrs.data ?? []) as Array<{ id: string; nome: string }>).map((r) => [r.id, r.nome])),
    fonte: new Map(((fontes.data ?? []) as Array<{ id: string; name: string }>).map((r) => [r.id, r.name])),
  });
  const serie = serieDiaria(
    ((porDia.data ?? []) as LinhaPorDiaBruta[]).map((l) => ({ dia: l.dia, source: l.source, leads: Number(l.leads) })),
    de,
    ate,
    fuso,
  );

  return ok({ grupos, total, serie }, { requestId });
}
