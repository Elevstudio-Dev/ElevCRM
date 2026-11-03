/**
 * GET /api/v1/team-chat/channels/[id]/mentionable — quem pode ser marcado com @
 * neste canal: quem o enxerga (Geral = a equipe toda; setor = o setor e manager+;
 * direto = os dois do par — e nesse a lista só traz a outra pessoa, que o campo
 * ignora, porque marcar alguém numa conversa de duas pessoas não diz nada).
 *
 * Migration 0222. Devolve id, nome e papel; sem e-mail; sem quem pergunta.
 *
 * A existência do canal é conferida pela conexão do usuário (a RLS de
 * `team_channels` herda `fn_can_view_team_channel`): canal que ele não vê é 404.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { marcaveisDoCanal, paraATela } from "@/lib/mencoes/marcaveis";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const supabase = await createClient();
  const { data: canal } = await supabase
    .from("team_channels")
    .select("id, kind")
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!canal) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  // Conversa direta não tem a quem marcar: devolver a outra pessoa só convidaria a
  // um `@` que avisa quem já está lendo.
  if ((canal as { kind: string }).kind === "direto") return ok([], { requestId });
  return ok(paraATela(await marcaveisDoCanal(org.orgId, id), user.id), { requestId });
}
