/**
 * GET /api/v1/conversations/[id]/mentionable — quem pode ser marcado com @ numa
 * nota interna desta conversa: os colegas que ENXERGAM a conversa (a regra de
 * visibilidade por setor e por modo, perguntada ao banco — migration 0222).
 *
 * Devolve id, nome e papel. Sem e-mail. Fora quem pergunta: ninguém se marca.
 *
 * Primeiro confirma, pela conexão do usuário (RLS), que ELE enxerga a conversa — a
 * lista de colegas de uma conversa que ele não abre não é dele. 404 honesto, sem
 * dizer se a conversa existe em outra organização.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcaveisDaConversa, paraATela } from "@/lib/mencoes/marcaveis";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversation_notes" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversation) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  return ok(paraATela(await marcaveisDaConversa(org.orgId, id), user.id), { requestId });
}
