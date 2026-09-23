/**
 * GET /api/v1/integrations/despachocerto/clients/[contactId] — já é cliente lá?
 *
 * É o que decide o rótulo do botão no inbox: "Cadastrar" quando não há vínculo,
 * e o nome do cadastro (com link para a ficha) quando há. Sem esta resposta, o
 * botão ofereceria cadastrar alguém que já está cadastrado — e o operador
 * descobriria isso só depois de preencher o formulário inteiro.
 *
 * Lê o VÍNCULO local, não o Despacho Certo: a pergunta é "eu já liguei este
 * contato a alguém de lá?", e essa resposta mora aqui. Ir ao outro sistema a
 * cada conversa aberta seria uma requisição externa por clique no inbox.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { PROVEDOR } from "@/lib/integrations/despachocerto/contrato";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ contactId: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "integrations" });
  if (!authz.ok) return authz.response;

  const { contactId } = await ctx.params;
  // Client de SESSÃO: a RLS de `integration_contact_links` já limita à
  // organização de quem pergunta, e é ela que se quer exercitando aqui.
  const supabase = await createClient();
  const { data } = await supabase
    .from("integration_contact_links")
    .select("external_id, external_metadata")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", PROVEDOR)
    .eq("contact_id", contactId)
    .maybeSingle();

  if (!data) return ok({ vinculado: false }, { requestId });

  const meta = (data.external_metadata ?? {}) as { name?: unknown; url?: unknown };
  return ok(
    {
      vinculado: true,
      external_id: data.external_id as string,
      name: typeof meta.name === "string" ? meta.name : null,
      url: typeof meta.url === "string" ? meta.url : null,
    },
    { requestId },
  );
}
