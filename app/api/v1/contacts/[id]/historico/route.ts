/**
 * POST /api/v1/contacts/:id/historico — puxa para o CRM as mensagens que o canal já tem desse contato.
 *
 * ## Por que existe
 *
 * O CRM só enxerga o que chega DEPOIS de conectado. O atendente abre um contato antigo e vê meia conversa:
 * falta o que foi dito antes, inclusive o clique do anúncio que trouxe a pessoa. Este botão busca o resto no
 * canal e identifica, entre as mensagens, as que vieram de anúncio.
 *
 * ## O que ela NÃO faz
 *
 * - Não é automática, nem em massa: UM contato por clique, por alguém da equipe (agent+). Importar o histórico de
 *   toda a base seria decisão de produto e de LGPD, não desta rota.
 * - Não responde a ninguém e não aciona a IA (ver `lib/inbox/importar-historico.ts`).
 * - Não traz o arquivo dos anexos.
 *
 * ## Por que nenhum nome de provider aparece aqui
 *
 * Mesma doutrina da importação de grupos: a rota pergunta uma CAPACIDADE (`fetchChatHistory`). Canal que não sabe
 * consultar o passado — a API oficial só entrega o que chega dali em diante — responde 422, sem `if` de provider.
 *
 * ## Isolamento
 *
 * Contato, conversa e canal são lidos pela conexão do USUÁRIO (RLS): um id adivinhado de outra empresa volta 404.
 * O service role só entra depois, para gravar.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  HistoricoIndisponivel,
  LIMITE_DO_HISTORICO,
  resolveSessionRef,
  type ChannelSessionRef,
  type MensagemDoHistorico,
  type RecipientInput,
} from "@/lib/channels";
import { importarHistoricoDoContato } from "@/lib/inbox/importar-historico";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
/** Páginas do canal em série: uma conversa longa leva alguns segundos. */
export const maxDuration = 60;

const Id = z.string().uuid();

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contact_history" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) {
    return fail("invalid_request", "Contato inválido.", 400, { requestId });
  }

  const supabase = await createClient();
  const { data: contato, error: erroContato } = await supabase
    .from("contacts")
    .select("id, phone_number, wa_lid")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroContato) return fail("db_error", "Não foi possível ler o contato.", 500, { requestId });
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  // A conversa 1:1 mais recente do contato: é por ela (e pelo canal dela) que o histórico se busca. Grupo não
  // entra — mensagem de gente que nunca falou com esta empresa é decisão de produto (ver a rota de grupos).
  const { data: conversa, error: erroConversa } = await supabase
    .from("conversations")
    .select("id, channel_session_id")
    .eq("organization_id", org.orgId)
    .eq("contact_id", id)
    .eq("is_group", false)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (erroConversa) return fail("db_error", "Não foi possível ler a conversa.", 500, { requestId });
  if (!conversa) {
    return fail("no_conversation", "Este contato ainda não tem uma conversa em nenhum canal.", 404, { requestId });
  }

  const { data: sessaoRaw, error: erroSessao } = await supabase
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("organization_id", org.orgId)
    .eq("id", conversa.channel_session_id)
    .maybeSingle();
  if (erroSessao) return fail("db_error", "Não foi possível ler o canal da conversa.", 500, { requestId });
  const sessao = sessaoRaw as unknown as ChannelSessionRef | null;
  if (!sessao) return fail("no_channel", "O canal desta conversa não existe mais.", 404, { requestId });

  const adapter = getAdapter(sessao.provider);
  if (typeof adapter.fetchChatHistory !== "function") {
    return fail(
      "history_not_supported",
      "Este canal não permite puxar conversas antigas — só mostra o que chega a partir da conexão.",
      422,
      { requestId },
    );
  }

  // O mesmo contato pode ter sido gravado por mais de um endereço (o id opaco `@lid` e o telefone). Busca por
  // todos que existirem: pegar só um perderia metade da conversa em silêncio.
  const base = { isGroup: false, groupChatId: null, waIdentity: null } as const;
  const candidatos: RecipientInput[] = [
    { ...base, phoneNumber: null, waLid: contato.wa_lid ?? null },
    { ...base, phoneNumber: contato.phone_number ?? null, waLid: null },
  ];
  const destinos = [...new Set(candidatos.map((c) => adapter.resolveRecipient(c)).filter((d): d is string => !!d))];
  if (destinos.length === 0) {
    return fail("no_recipient", "Este contato não tem um número de WhatsApp para buscar.", 422, { requestId });
  }

  const sessionRef = resolveSessionRef(sessao);
  const achadas = new Map<string, MensagemDoHistorico>();
  let respondeu = 0;
  let ultimoErro: unknown = null;
  for (const recipient of destinos) {
    try {
      const lote = await adapter.fetchChatHistory({
        organizationId: org.orgId,
        sessionRef,
        recipient,
        limite: LIMITE_DO_HISTORICO,
      });
      respondeu += 1;
      for (const m of lote) if (!achadas.has(m.externalId)) achadas.set(m.externalId, m);
    } catch (err) {
      if (err instanceof HistoricoIndisponivel) {
        return fail(
          "history_unavailable",
          "O WhatsApp desta empresa ainda não guarda o histórico das conversas, então não há o que puxar. " +
            "É preciso ligar o armazenamento de histórico no canal (a equipe técnica faz isso) e reconectar o número.",
          409,
          { requestId },
        );
      }
      ultimoErro = err;
      logger.warn("historico.puxar: um endereço do contato não respondeu", {
        organization_id: org.orgId,
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      });
    }
  }
  // Nenhum endereço respondeu: não é "sem histórico", é falha — dizer "0 mensagens" mentiria ao atendente.
  if (respondeu === 0) {
    logger.warn("historico.puxar: o canal não devolveu o histórico", {
      organization_id: org.orgId,
      detail: (ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)).slice(0, 160),
    });
    return fail(
      "channel_error",
      "Não foi possível falar com o WhatsApp agora. Tente de novo em alguns instantes.",
      502,
      { requestId },
    );
  }

  const resultado = await importarHistoricoDoContato(
    createAdminClient(),
    {
      organizationId: org.orgId,
      contactId: id,
      conversationId: conversa.id as string,
      channelSessionId: conversa.channel_session_id as string,
    },
    [...achadas.values()],
  );

  void audit({
    action: "contact.history_imported",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: {
      encontradas: resultado.encontradas,
      importadas: resultado.importadas,
      ja_existiam: resultado.jaExistiam,
      falharam: resultado.falharam,
      de_anuncio: resultado.deAnuncio,
    },
  });

  return ok(
    {
      encontradas: resultado.encontradas,
      importadas: resultado.importadas,
      ja_existiam: resultado.jaExistiam,
      falharam: resultado.falharam,
      de_anuncio: resultado.deAnuncio,
      contato_marcado_como_anuncio: resultado.contatoMarcadoComoAnuncio,
      primeira_em: resultado.primeiraEm,
      ultima_em: resultado.ultimaEm,
      // Se o canal devolveu o teto, há mais antigas que ficaram de fora: o atendente precisa saber.
      limite_atingido: achadas.size >= LIMITE_DO_HISTORICO,
    },
    { requestId },
  );
}
