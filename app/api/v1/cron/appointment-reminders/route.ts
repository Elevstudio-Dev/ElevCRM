/**
 * GET/POST /api/v1/cron/appointment-reminders — o lembrete de consulta por WhatsApp.
 *
 * A cada 5 min pergunta ao banco quais compromissos já chegaram ao momento de avisar
 * (`fn_lembretes_devidos`) e trata cada um por `processarLembrete`: envia, descarta
 * (`skipped`), espera (janela de cortesia, canal fora do ar, falta de modelo) ou
 * desiste depois de três falhas — sempre deixando o motivo escrito no compromisso.
 *
 * O desenho e as regras estão em
 * `docs/superpowers/specs/2026-10-23-lembrete-de-consulta-design.md`.
 *
 * Auth: mesmo contrato dos demais crons (Bearer INTERNAL_CRON_SECRET|INTERNAL_SECRET,
 * fail-closed).
 *
 * Um compromisso que quebra NÃO derruba os outros do mesmo tick: o erro vai para o
 * log e a contagem, e o próximo tick tenta de novo (a trava otimista e a chave de
 * idempotência impedem o envio em dobro).
 *
 * NOTA DE DEPLOY: a rota precisa estar no crontab do contêiner `scheduler`
 * (`docker/scheduler/entrypoint.sh`) — sem isso ela existe e nunca roda sozinha.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { portasDoSupabase } from "@/lib/agenda/lembrete/portas-supabase";
import { processarLembrete, type DesfechoDoTick } from "@/lib/agenda/lembrete/executar";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Compromissos tratados por invocação. Cada envio leva cerca de um segundo e o
 * scheduler corta a chamada em 60 s: 30 deixa folga, e o que sobrar entra no tick
 * seguinte (a fila é ordenada pelo horário da consulta, então o mais urgente vai primeiro).
 */
const LIMITE_POR_TICK = 30;

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const portas = portasDoSupabase(admin);
  const agora = portas.agora();

  const { data, error } = await admin.rpc("fn_lembretes_devidos", {
    p_now: agora.toISOString(),
    p_limit: LIMITE_POR_TICK,
  });
  if (error) {
    logger.error("[appointment-reminders] fn_lembretes_devidos falhou", {
      error: error.message,
      requestId,
    });
    return fail("internal_error", "Failed to query due reminders.", 500, { requestId });
  }

  const devidos = (data ?? []) as Array<{ appointment_id: string; organization_id: string }>;
  const contagem: Record<DesfechoDoTick | "erro", number> = {
    enviado: 0,
    pulado: 0,
    esperando: 0,
    falhou: 0,
    ignorado: 0,
    erro: 0,
  };

  for (const d of devidos) {
    try {
      const desfecho = await processarLembrete(portas, {
        id: d.appointment_id,
        organizationId: d.organization_id,
      });
      contagem[desfecho] += 1;
    } catch (err) {
      contagem.erro += 1;
      logger.error("[appointment-reminders] compromisso falhou", {
        appointmentId: d.appointment_id,
        error: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  // Varredura que só esperou ou não achou nada não é mutação — e não tem por que
  // ocupar linha na auditoria (mesma regra do `followup-flow-worker`).
  if (contagem.enviado + contagem.pulado + contagem.falhou > 0) {
    void audit({
      action: "agenda.lembretes_executados",
      organizationId: null,
      bypassedRls: true,
      metadata: { varridos: devidos.length, ...contagem },
      requestId,
    });
  }

  return ok({ varridos: devidos.length, ...contagem }, { requestId });
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
