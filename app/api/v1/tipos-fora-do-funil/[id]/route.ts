/**
 * PATCH /api/v1/tipos-fora-do-funil/[id] — renomear, arquivar ou reativar um tipo (gestor+).
 *
 * Arquivar tira o tipo da lista de escolha, mas NÃO mexe nos contatos que já o têm (o nome continua aparecendo
 * neles): apagar o tipo de quem já está classificado seria perder a informação em silêncio.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_TIPO,
  editarTipoForaDoFunilSchema,
  type TipoForaDoFunil,
} from "@/lib/schemas/fora-do-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "tipos_fora_do_funil", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;

  const parsed = editarTipoForaDoFunilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  const mudanca: Record<string, unknown> = {};
  if (input.nome !== undefined) mudanca.nome = input.nome;
  if (input.arquivado !== undefined) mudanca.arquivado_em = input.arquivado ? new Date().toISOString() : null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tipos_fora_do_funil")
    .update(mudanca)
    .eq("organization_id", orgId)
    .eq("id", id)
    .select(COLUNAS_DO_TIPO)
    .maybeSingle();
  if (error?.code === "23505") {
    return fail("validation_failed", "Já existe um tipo com esse nome.", 422, { requestId });
  }
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "Tipo não encontrado.", 404, { requestId });

  const tipo = data as TipoForaDoFunil;
  const acao =
    input.arquivado === true
      ? "tipo_fora_do_funil.arquivado"
      : input.arquivado === false
        ? "tipo_fora_do_funil.reativado"
        : "tipo_fora_do_funil.renomeado";
  await audit({
    action: acao,
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "tipo_fora_do_funil",
    resourceId: tipo.id,
    requestId,
    metadata: { campos: Object.keys(mudanca), nome: tipo.nome },
  });
  return ok(tipo, { requestId });
}
