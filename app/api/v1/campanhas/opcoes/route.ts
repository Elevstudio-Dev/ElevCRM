/**
 * GET /api/v1/campanhas/opcoes — o que a tela de nova campanha oferece: as
 * etiquetas da organização (com quantos contatos cada uma tem) e os números
 * conectados (manager+).
 */
import { randomUUID } from "node:crypto";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { etiquetasDaOrganizacao } from "@/lib/campanhas/servico";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { createAdminClient } from "@/lib/supabase/admin";

import { respostaDeErro } from "../_comum";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;
  try {
    const admin = createAdminClient();
    const [etiquetas, canais] = await Promise.all([
      etiquetasDaOrganizacao(admin, authz.org.orgId),
      listSelectableChannels(admin, authz.org.orgId),
    ]);
    return ok(
      {
        etiquetas,
        canais: canais.map((c) => ({ id: c.id, nome: c.display_name, status: c.status, telefone: c.phone_number })),
      },
      { requestId },
    );
  } catch (err) {
    return respostaDeErro(err, requestId, "opcoes");
  }
}
