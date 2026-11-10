/**
 * meta-ads-sync — de hora em hora, traz da Meta o gasto por anúncio de cada organização conectada.
 *
 * POR QUE UM CRON E NÃO "AO ABRIR O RELATÓRIO": o relatório precisa abrir rápido e funcionar mesmo com a Meta fora
 * do ar; o gasto já está no banco quando alguém olha. O botão "Atualizar agora" cobre a pressa.
 *
 * SÓ AS QUE VALE TENTAR: organização com a chave recusada pela Meta (`token_invalido`) fica de fora até alguém
 * reconectar — tentar de hora em hora uma chave revogada é martelar a Meta à toa. As com `erro` (queda da Meta,
 * limite) voltam sozinhas na próxima hora.
 *
 * Uma organização por vez e cada uma isolada em `try/catch`: a conta travada de uma não pode impedir a das outras.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { sincronizarOrganizacao } from "@/lib/meta-ads/sincronizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Organizações por invocação. Cada uma pode custar várias páginas da Meta; o resto fica para a próxima hora. */
const POR_RODADA = 20;

export async function GET(req: NextRequest): Promise<Response> {
  return rodar(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return rodar(req);
}

async function rodar(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_ads_conexoes")
    .select("organization_id")
    .in("status", ["conectada", "erro"])
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(POR_RODADA);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  let sincronizadas = 0;
  let falharam = 0;
  for (const { organization_id: orgId } of (data ?? []) as Array<{ organization_id: string }>) {
    try {
      const r = await sincronizarOrganizacao(admin, orgId);
      if (r.ok) sincronizadas += 1;
      else falharam += 1;
    } catch (err) {
      falharam += 1;
      logger.warn("[meta-ads-sync] organização falhou", {
        organization_id: orgId,
        erro: err instanceof Error ? err.name : "desconhecido",
      });
    }
  }

  return ok({ organizacoes: (data ?? []).length, sincronizadas, falharam }, { requestId });
}
