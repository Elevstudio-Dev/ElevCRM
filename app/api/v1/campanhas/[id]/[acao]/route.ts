/**
 * POST /api/v1/campanhas/:id/pausar | retomar | cancelar (manager+).
 *
 * Pausar e cancelar tiram da fila quem ainda não recebeu; quem já está sendo
 * enviado termina. Retomar confere o público de novo e reagenda a partir de agora.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { cancelarCampanha, pausarCampanha, retomarCampanha } from "@/lib/campanhas/servico";
import { createAdminClient } from "@/lib/supabase/admin";

import { UUID_RX, respostaDeErro } from "../../_comum";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string; acao: string }> };

const ACOES = {
  pausar: { auditoria: "campanha.pausada" },
  retomar: { auditoria: "campanha.retomada" },
  cancelar: { auditoria: "campanha.cancelada" },
} as const;

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id, acao } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });
  if (!(acao in ACOES)) return fail("not_found", "Ação desconhecida.", 404, { requestId });
  const qual = acao as keyof typeof ACOES;

  const authz = await requireRole("manager", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  try {
    const admin = createAdminClient();
    const afetados =
      qual === "pausar"
        ? await pausarCampanha(admin, org.orgId, id)
        : qual === "cancelar"
          ? await cancelarCampanha(admin, org.orgId, id)
          : await retomarCampanha(admin, org.orgId, id, new Date());
    void audit({
      action: ACOES[qual].auditoria,
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "followup_flow_pointer",
      resourceId: id,
      requestId,
      metadata: { destinatarios_afetados: afetados },
    });
    return ok({ afetados }, { requestId });
  } catch (err) {
    return respostaDeErro(err, requestId, qual);
  }
}
