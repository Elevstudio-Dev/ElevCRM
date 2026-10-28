/**
 * GET /api/v1/relatorios/qr-codes?de&ate&fuso — o funil de cada QR: leituras → conversas → leads → vendas (gestor+).
 *
 * Mesmas garantias da rota de origens: gate `manager`, função `security invoker` (a RLS vale através dela) e
 * agregação no banco por causa do corte de 1.000 linhas do PostgREST. QR sem nada no período volta com zeros.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { FunilDoQr } from "@/lib/schemas/qr-codes";
import { periodoSchema } from "@/lib/schemas/relatorios";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

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
  const { de, ate } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_relatorio_de_qr_codes", {
    p_org: orgId,
    p_de: de.toISOString(),
    p_ate: ate.toISOString(),
  });
  if (error) return fail("internal_error", error.message, 500, { requestId });

  // Os contadores são `bigint` e chegam como número ou como texto — `Number()` em tudo.
  const linhas = (data ?? []) as Array<{ qr_code_id: string } & Record<Exclude<keyof FunilDoQr, "qr_code_id">, number | string>>;
  const funil: FunilDoQr[] = linhas.map((l) => ({
    qr_code_id: l.qr_code_id,
    leituras: Number(l.leituras),
    conversas: Number(l.conversas),
    leads: Number(l.leads),
    ganhos: Number(l.ganhos),
    valor_ganho_cents: Number(l.valor_ganho_cents),
  }));
  return ok({ funil }, { requestId });
}
