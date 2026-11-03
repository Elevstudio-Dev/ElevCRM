/**
 * GET  /api/v1/team-chat/channels/[id]/messages?before=<iso>&limit=50 — as
 *      mensagens do canal, da mais antiga para a mais nova (paginação para
 *      trás por `before`). A RLS de `team_messages` herda a do canal: canal
 *      que a pessoa não vê devolve vazio, não erro.
 * POST /api/v1/team-chat/channels/[id]/messages { body } — envia. O remetente
 *      é quem está logado (a policy exige), o nome vai desnormalizado na
 *      linha, e a própria leitura avança junto: quem escreve já leu.
 *
 * `agent+`. Migration 0214.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import type { MensagemDaEquipe } from "@/lib/chat-interno/canais";
import { emitirMencoes } from "@/lib/mencoes/avisar";
import { marcaveisDoCanal } from "@/lib/mencoes/marcaveis";
import { mencoesPedidasSchema, resolverMencoes } from "@/lib/mencoes/servidor";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const COLS = "id, channel_id, sender_user_id, sender_name, body, mentions, created_at";
const corpoSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  /** Quem foi marcado com @ (só o id; o servidor confere e põe o nome). Migration 0222. */
  mentions: mencoesPedidasSchema,
});

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;

  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);

  const supabase = await createClient();
  let q = supabase
    .from("team_messages")
    .select(COLS)
    .eq("organization_id", authz.org.orgId)
    .eq("channel_id", id)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("created_at", before);
  const { data, error } = await q;
  if (error) return fail("internal_error", "Erro ao ler as mensagens.", 500, { requestId });
  const lista = ((data ?? []) as MensagemDaEquipe[]).reverse();
  return ok(lista, { requestId, meta: { has_more: lista.length === limit } });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  const authz = await requireRole("agent", { requestId, resource: "team_chat" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "Escreva alguma coisa.", 422, { requestId });

  const supabase = await createClient();
  const agora = new Date().toISOString();

  // Quem PODE ser marcado vem do banco (quem enxerga este canal). Canal alheio ou
  // inexistente devolve lista vazia — e o INSERT logo abaixo o recusa por RLS.
  const marcaveis = parsed.data.mentions.length > 0 ? await marcaveisDoCanal(org.orgId, id) : [];
  const { gravar, avisar } = resolverMencoes({
    texto: parsed.data.body,
    pedidas: parsed.data.mentions,
    marcaveis,
    autorId: user.id,
  });

  const { data, error } = await supabase
    .from("team_messages")
    .insert({
      organization_id: org.orgId,
      channel_id: id,
      sender_user_id: user.id,
      sender_name: user.full_name?.trim() || user.email,
      body: parsed.data.body,
      mentions: gravar,
      created_at: agora,
    })
    .select(COLS)
    .single();
  if (error) {
    // A policy de INSERT exige que o canal seja visível: canal alheio (ou
    // inexistente) cai aqui como violação de RLS, e 404 é a resposta honesta.
    if (error.code === "42501") return fail("not_found", "Canal não encontrado.", 404, { requestId });
    return fail("internal_error", "Erro ao enviar.", 500, { requestId });
  }

  // Quem escreve já leu até aqui. Best-effort: falhar aqui não desfaz o envio.
  await supabase
    .from("team_channel_members")
    .upsert({ channel_id: id, user_id: user.id, organization_id: org.orgId, last_read_at: agora }, { onConflict: "channel_id,user_id" });

  // O aviso de quem foi marcado. Best-effort: nunca desfaz a mensagem.
  const gravada = data as MensagemDaEquipe;
  void emitirMencoes({
    organizationId: org.orgId,
    entityKind: "team_message",
    entityId: gravada.id,
    avisar,
    fromUserId: user.id,
    destino: { channel_id: id },
    texto: parsed.data.body,
  });

  return ok(gravada, { requestId, status: 201 });
}
