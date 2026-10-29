/**
 * POST /api/v1/contacts/fora-do-funil — marcar ou desmarcar contatos como "fora do funil" (atendente+).
 *
 * Equipe, prestador, parceiro: a IA se cala, nenhum negócio nasce e os que já existiam saem do funil e do
 * relatório (a regra e a prova estão em `lib/contatos/fora-do-funil.ts` e na migration 0221). Qualquer atendente
 * marca e desmarca — é ele quem sabe quem é quem —, e TODA mudança deixa autor na auditoria.
 *
 * O tipo (Equipe, Contador…) é opcional e tem de ser da MESMA organização e estar em uso (não arquivado): um tipo
 * de outra organização nunca pode ser anexado, nem que o id seja adivinhado.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { aplicarMarcador } from "@/lib/contatos/fora-do-funil";
import { marcarForaDoFunilSchema } from "@/lib/schemas/fora-do-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const parsed = marcarForaDoFunilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const { contact_ids, marcar, tipo_id } = parsed.data;
  const supabase = await createClient();

  if (marcar && tipo_id) {
    const { data: tipo } = await supabase
      .from("tipos_fora_do_funil")
      .select("id")
      .eq("organization_id", orgId)
      .eq("id", tipo_id)
      .is("arquivado_em", null)
      .maybeSingle();
    if (!tipo) return fail("validation_failed", "Esse tipo não existe mais. Escolha outro.", 422, { requestId });
  }

  try {
    const r = await aplicarMarcador(supabase, {
      organizationId: orgId,
      userId: authz.user.id,
      contactIds: contact_ids,
      marcar,
      ...(marcar ? { tipoId: tipo_id } : {}),
    });

    if (r.alterados.length > 0) {
      // Um contato só: o recurso é ele. Em lote, a coluna (uuid) fica nula e os ids vão no metadata.
      const contatoUnicoId = r.alterados.length === 1 ? (r.alterados[0] ?? null) : null;
      await audit({
        action: marcar ? "contact.fora_do_funil_marcado" : "contact.fora_do_funil_desmarcado",
        organizationId: orgId,
        actorUserId: authz.user.id,
        resourceType: "contact",
        resourceId: contatoUnicoId,
        requestId,
        metadata: {
          contatos: r.alterados.length,
          ...(r.alterados.length > 1 ? { contact_ids: r.alterados } : {}),
          tipo_id: marcar ? (tipo_id ?? null) : null,
          negocios: r.previa.negocios,
        },
      });
    }

    return ok({ alterados: r.alterados.length, previa: r.previa }, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Falha ao atualizar.", 500, { requestId });
  }
}
