/**
 * GET/POST /api/v1/cron/secretaria-agenda — as perguntas diárias da IA à secretaria sobre a agenda.
 *
 * A cada 5 min vê, para cada organização que ligou a agenda da secretaria (`settings.secretaria.ativa`), se chegou a
 * hora de perguntar (padrão 08:30, 14:00 e 18:15, de segunda a sexta, no fuso da agenda), de lembrar (30 min sem
 * resposta, uma vez) ou de avisar o administrador na Central de avisos (mais 30 min sem resposta). O tick está em
 * `lib/bastidor/secretaria/perguntas-tick.ts`; a regra de horário, em `perguntas.ts`.
 *
 * NÃO envia mensagem: enfileira um job `bastidor_turn` e o worker manda pela cadeia de proteções de sempre.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET, fail-closed).
 *
 * NOTA DE DEPLOY: a rota precisa estar no crontab do contêiner `scheduler` (`docker/scheduler/entrypoint.sh`) —
 * sem isso ela existe e nunca roda sozinha. Cerca: `tests/unit/cron-routes-scheduled.test.ts`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { portasDoTickNoSupabase } from "@/lib/bastidor/secretaria/perguntas-supabase";
import { executarTickDasPerguntas } from "@/lib/bastidor/secretaria/perguntas-tick";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const portas = portasDoTickNoSupabase(createAdminClient(), (contexto, e) =>
    logger.error("[secretaria-agenda] falhou", {
      contexto,
      error: e instanceof Error ? e.message : String(e),
      requestId,
    }),
  );

  let resultado;
  try {
    resultado = await executarTickDasPerguntas(portas);
  } catch (e) {
    logger.error("[secretaria-agenda] o tick não rodou", {
      error: e instanceof Error ? e.message : String(e),
      requestId,
    });
    return fail("internal_error", "Failed to run the secretary agenda tick.", 500, { requestId });
  }

  // Tick que não fez nada não é mutação — e não tem por que ocupar linha na auditoria (mesma regra dos demais crons).
  if (resultado.perguntadas + resultado.lembradas + resultado.avisos + resultado.dispensadas > 0) {
    void audit({
      action: "agenda.secretaria_perguntas_executadas",
      organizationId: null,
      bypassedRls: true,
      metadata: { ...resultado },
      requestId,
    });
  }

  return ok(resultado, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
