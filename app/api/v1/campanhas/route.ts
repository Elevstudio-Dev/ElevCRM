/**
 * GET  /api/v1/campanhas — campanhas da organização ativa, com a contagem por
 *   situação (qualquer membro).
 * POST /api/v1/campanhas — cria e já agenda os envios (manager+). O corpo nunca
 *   traz organização: ela vem da sessão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { criarCampanhaSchema } from "@/lib/campanhas/parametros";
import { criarCampanha, listarCampanhas } from "@/lib/campanhas/servico";
import { createAdminClient } from "@/lib/supabase/admin";

import { lerJson, respostaDeErro } from "./_comum";

export const dynamic = "force-dynamic";

export async function GET(_req?: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;
  try {
    const lista = await listarCampanhas(createAdminClient(), authz.org.orgId);
    return ok(lista, { requestId });
  } catch (err) {
    return respostaDeErro(err, requestId, "listar");
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = criarCampanhaSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  try {
    const criada = await criarCampanha(createAdminClient(), org.orgId, parsed.data, user.id, new Date());
    void audit({
      action: "campanha.criada",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "followup_flow_pointer",
      resourceId: criada.id,
      requestId,
      // Sem o objetivo por extenso: ele é texto livre e pode carregar dado de paciente.
      metadata: {
        etiquetas: parsed.data.etiquetas,
        canal_id: parsed.data.canal_id,
        inscritos: criada.inscritos,
        com_imagem: parsed.data.imagem !== undefined,
        ritmo: parsed.data.ritmo,
      },
    });
    return ok(criada, { requestId, status: 201 });
  } catch (err) {
    return respostaDeErro(err, requestId, "criar");
  }
}
