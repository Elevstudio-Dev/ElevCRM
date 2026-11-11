/**
 * /api/v1/ai/followups/promises — o retorno agendado POR UMA PESSOA (agent+).
 *
 *   POST  { contact_id, quando, instrucao }  marca um dia para a IA voltar a falar com o cliente, com o que fazer.
 *   GET   ?contact_id=                        os retornos desse cliente (o vivo e os últimos encerrados).
 *
 * É a mesma regra que a IA usa para marcar o PRÓPRIO retorno (`agendaRetornoNoCrm`, em `lib/followup/retorno.ts`):
 * janela de antecedência, um retorno vivo por cliente e linha na timeline. A diferença é quem decide — aqui uma pessoa
 * da equipe — e o que viaja no `cron_jobs`: a instrução fica em `payload.instruction`, com as palavras da pessoa, e o
 * turno do dia a entrega ao agente como ordem (ver `buildTemporalBlock`), não como "você prometeu".
 *
 * A organização vem do JWT (`requireRole`), nunca do corpo; o cliente é conferido contra ela pela operação
 * compartilhada, que filtra `organization_id` em toda query.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { duracaoLegivel } from "@/lib/followup/retorno";
import { agendaRetornoNoCrm, listaRetornosNoCrm } from "@/lib/followup/retorno-crm";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const Body = z.object({
  contact_id: z.string().uuid(),
  /** Instante ABSOLUTO (ISO 8601): o navegador converte o dia e a hora que a pessoa escolheu. */
  quando: z.string().min(1).max(64),
  instrucao: z.string().trim().min(1).max(1_000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "followup_promises" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", "Informe o cliente, o dia e o que a IA deve fazer.", 400, { requestId });
  }
  const { contact_id: contactId, quando, instrucao } = parsed.data;

  const resultado = await agendaRetornoNoCrm(
    { admin: createAdminClient(), orgId: org.orgId, actor: { type: "user", id: user.id }, requestId },
    { contactId },
    {
      // O motivo aparece na timeline ("Retorno agendado" + motivo): a instrução da pessoa, nas palavras dela.
      motivo: instrucao,
      prometidoPara: quando,
      instrucao,
      source: "human",
    },
  );

  if (!resultado.ok) {
    switch (resultado.codigo) {
      case "instante_invalido":
        return fail("invalid_request", "Dia ou hora inválidos.", 400, { requestId });
      case "instante_no_passado":
        return fail("followup_in_past", "Escolha um dia e uma hora que ainda não passaram.", 422, { requestId });
      case "instante_fora_da_janela": {
        const j = "janela" in resultado ? resultado.janela : null;
        return fail(
          "followup_out_of_window",
          j
            ? `O retorno precisa ficar entre ${duracaoLegivel(j.minAheadMs)} e ${duracaoLegivel(j.maxAheadMs)} a partir de agora.`
            : "Esse dia está fora do prazo permitido para um retorno.",
          422,
          { requestId },
        );
      }
      case "ja_existe_retorno": {
        const ex = "existente" in resultado ? resultado.existente : undefined;
        return fail(
          "followup_already_pending",
          "Este cliente já tem um retorno marcado. Desmarque o atual para marcar outro.",
          409,
          { requestId, ...(ex ? { details: { id: ex.id, quando: ex.quando, instrucao: ex.instrucao ?? ex.motivo } } : {}) },
        );
      }
      case "cliente_nao_encontrado":
      case "negocio_nao_encontrado":
      case "negocio_sem_contato":
        return fail("not_found", "Cliente não encontrado.", 404, { requestId });
    }
  }

  void audit({
    action: "followup.scheduled",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "cron_job",
    resourceId: resultado.retorno.id,
    requestId,
    metadata: {
      actor_type: "user",
      via: "botao",
      contact_id: contactId,
      lead_id: resultado.alvo?.leadId ?? null,
    },
  });

  return ok(
    { id: resultado.retorno.id, quando: resultado.retorno.quando, instrucao, status: "agendado" },
    { requestId, status: 201 },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "followup_promises" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const contactId = new URL(req.url).searchParams.get("contact_id") ?? "";
  if (!z.string().uuid().safeParse(contactId).success) {
    return fail("invalid_request", "contact_id inválido.", 400, { requestId });
  }

  const lista = await listaRetornosNoCrm(
    { admin: createAdminClient(), orgId: org.orgId, actor: { type: "user", id: user.id }, requestId },
    { contactId },
    { limite: 5 },
  );
  if (!lista.ok) return fail("not_found", "Cliente não encontrado.", 404, { requestId });

  return ok(
    {
      retornos: lista.retornos.map((r) => ({
        id: r.id,
        quando: r.quando,
        situacao: r.situacao,
        instrucao: r.instrucao ?? null,
        motivo: r.motivo,
        promessa: r.promessa,
      })),
    },
    { requestId },
  );
}
