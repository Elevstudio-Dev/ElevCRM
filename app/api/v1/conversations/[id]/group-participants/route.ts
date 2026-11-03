/**
 * GET /api/v1/conversations/[id]/group-participants — quem está neste GRUPO de WhatsApp, para a atendente
 * escolher quem marcar com `@` ao escrever no grupo.
 *
 * O canal só sabe o endereço de cada participante; o NOME que a atendente reconhece vem do que o CRM viu
 * dessa pessoa nas mensagens do grupo (`lib/mencoes/participantes-do-grupo`). Quem nunca escreveu
 * aparece pelo telefone.
 *
 * ## O que ela NUNCA faz
 *
 *  - Não erra por causa do canal: transporte fora do ar, sessão que não responde ou canal que não sabe
 *    listar participantes devolvem `[]` (com o motivo no log). A lista vazia DESLIGA o `@` no campo —
 *    a conversa continua funcionando. Um 502 aqui trancaria a atendente fora de escrever no grupo por
 *    causa de um enfeite.
 *  - Não fala em provider: pergunta ao adapter se ele sabe (`listGroupParticipants`), como a importação
 *    de grupos (doutrina de restrição de canal, invariante 1).
 *  - Não serve conversa 1:1: não há a quem marcar, e devolve `[]` em vez de erro.
 *
 * `agent+`; a conversa é conferida pela conexão do usuário (RLS) — grupo que ele não vê é 404.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { logger } from "@/lib/logger";
import { nomesDasMensagens, participantesParaATela } from "@/lib/mencoes/participantes-do-grupo";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Quantas mensagens recentes do grupo se olham para descobrir os nomes. */
const MENSAGENS_PARA_NOMES = 500;

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const { id } = await params;

  const supabase = await createClient();
  const { data: conversa } = await supabase
    .from("conversations")
    .select(
      `id, is_group, group_chat_id, channel_sessions:channel_session_id(${CHANNEL_SESSION_REF_COLUMNS}, status)`,
    )
    .eq("id", id)
    .eq("organization_id", org.orgId)
    .maybeSingle();
  if (!conversa) return fail("not_found", "Conversa não encontrada.", 404, { requestId });

  const c = conversa as unknown as {
    id: string;
    is_group: boolean;
    group_chat_id: string | null;
    channel_sessions: (ChannelSessionRef & { status: string }) | null;
  };
  if (!c.is_group || !c.group_chat_id || !c.channel_sessions) return ok([], { requestId });

  const adapter = getAdapter(c.channel_sessions.provider ?? DEFAULT_CHANNEL_PROVIDER);
  if (typeof adapter.listGroupParticipants !== "function") return ok([], { requestId });

  let participantes;
  try {
    participantes = await adapter.listGroupParticipants({
      organizationId: org.orgId,
      sessionRef: resolveSessionRef(c.channel_sessions),
      groupChatId: c.group_chat_id,
    });
  } catch (err) {
    logger.warn("grupo.participantes: o canal não devolveu a lista", {
      organization_id: org.orgId,
      conversation_id: id,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return ok([], { requestId, meta: { indisponivel: true } });
  }
  if (participantes.length === 0) return ok([], { requestId });

  // Os nomes: o que cada pessoa disse no grupo, da mensagem mais nova para a mais antiga.
  const { data: linhas } = await supabase
    .from("messages")
    .select("metadata")
    .eq("organization_id", org.orgId)
    .eq("conversation_id", id)
    .eq("direction", "inbound")
    .not("metadata->>grupo_participante", "is", null)
    .order("sent_at", { ascending: false })
    .limit(MENSAGENS_PARA_NOMES);
  const nomes = nomesDasMensagens(
    ((linhas ?? []) as Array<{ metadata: Record<string, unknown> | null }>).map((l) => l.metadata),
  );

  return ok(participantesParaATela(participantes, nomes), { requestId });
}
