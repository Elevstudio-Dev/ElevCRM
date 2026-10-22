/**
 * POST /api/v1/channels/groups/import — traz para o CRM os grupos que a conta
 * JÁ participa.
 *
 * ## Por que uma importação, e não só a ingestão
 *
 * Desde a migration 0210 toda mensagem de grupo vira conversa. Só que isso faz
 * aparecer o grupo em que ALGUÉM ESCREVEU depois que a chave foi ligada: um
 * grupo parado há uma semana continuaria invisível, e "cadê os meus grupos?" é a
 * primeira coisa que quem liga isso pergunta.
 *
 * ## Ela também é o único lugar que sabe o NOME do grupo
 *
 * O payload de uma mensagem de grupo traz o nome de QUEM ESCREVEU, não o assunto
 * do grupo. Por isso a ingestão cria sem nome — batizar "Time comercial" de
 * "Roberto" seria pior que não batizar. O nome real vem daqui, e por isso a
 * importação é RE-EXECUTÁVEL de propósito: rodá-la de novo conserta o nome de um
 * grupo que chegou primeiro por mensagem, e renomeia os que mudaram de assunto.
 *
 * ## Por que NENHUM nome de provider aparece aqui
 *
 * A primeira versão desta rota importava o cliente do transporte direto e
 * filtrava `.eq("provider", "<nome>")`. Passou no `lint` e no `typecheck` e foi
 * REPROVADA pelo `lint:channels` — o invariante 1 da doutrina de restrição de
 * canal: *nenhuma feature nomeia um provider*. A catraca estava certa: com a
 * régua escrita aqui, o dia em que um segundo canal soubesse listar grupos
 * exigiria mexer nesta rota, e o dia em que o primeiro mudasse de cliente também.
 *
 * A versão certa pergunta uma CAPACIDADE: pede o adapter da sessão e testa se
 * ele sabe listar grupos. Canal que não sabe simplesmente não aparece na busca —
 * sem `if`, sem lista de nomes.
 *
 * ## O que ela NÃO faz
 *
 * Não traz histórico. Importar conversa antiga de grupo mexe com volume e com
 * LGPD (mensagem de gente que nunca falou com esta empresa) e é decisão de
 * produto, não desta rota. O grupo nasce vazio e recebe o que chegar dali em
 * diante.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  getAdapter,
  resolveSessionRef,
  type ChannelSessionRef,
} from "@/lib/channels";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface Resultado {
  encontrados: number;
  vinculados: number;
  falharam: number;
}

export async function POST(req: Request): Promise<Response> {
  const requestId = randomUUID();

  // `manager` e não `agent`: importar grupo cria contato e conversa para a
  // organização inteira, e é ação de configuração do canal — não de atendimento.
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  let corpo: { channel_session_id?: unknown } = {};
  try {
    corpo = (await req.json()) as { channel_session_id?: unknown };
  } catch {
    // Corpo ausente é aceito: a instalação típica tem UM canal, e obrigar o
    // cliente a descobrir o id de uma sessão que ele nem vê seria burocracia.
    corpo = {};
  }
  const pedido =
    typeof corpo.channel_session_id === "string" && corpo.channel_session_id
      ? corpo.channel_session_id
      : null;

  const supabase = await createClient();
  // A sessão vem pela conexão do USUÁRIO (RLS), não pelo service role: é o que
  // impede alguém de importar os grupos do canal de outra organização passando
  // um id adivinhado. O service role só entra depois, para escrever.
  //
  // Duas closures, não um builder reaproveitado: o cliente do PostgREST é
  // thenable, então reusar o mesmo objeto na segunda tentativa reenviaria uma
  // requisição já resolvida (ver `queryTolerantToMissingArchived`).
  const buscar = (colunas: string) => {
    let q = supabase
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", activeOrg.orgId);
    if (pedido) q = q.eq("id", pedido);
    return q;
  };
  const { data: sessoesRaw, error: erroSessao } = await queryTolerantToMissingArchived(
    () => buscar(`id, ${CHANNEL_SESSION_REF_COLUMNS}, ${ARCHIVED_AT}`),
    () => buscar(`id, ${CHANNEL_SESSION_REF_COLUMNS}`),
  );
  if (erroSessao) {
    return fail("db_error", "Não foi possível ler os canais desta empresa.", 500, { requestId });
  }

  const sessoes = (sessoesRaw ?? []) as unknown as Array<
    ChannelSessionRef & { id: string; archived_at?: string | null }
  >;

  // A ESCOLHA DO CANAL É POR CAPACIDADE, e é aqui que a doutrina se paga.
  //
  // `archived_at == null` cobre os dois casos: coluna ausente (schema antigo, o
  // fallback acima) e coluna nula (canal vivo). Canal arquivado não entrega
  // nada — importar por ele criaria conversas num canal morto.
  //
  // `listGroups` presente é a pergunta inteira: canal que não sabe listar grupos
  // não é candidato, e nenhum nome de provider precisou ser escrito para saber
  // disso.
  const viva = sessoes.find(
    (s) => s.archived_at == null && typeof getAdapter(s.provider).listGroups === "function",
  );
  if (!viva) {
    return fail(
      "no_channel",
      "Nenhum canal conectado que saiba listar grupos — conecte um antes de importar.",
      404,
      { requestId },
    );
  }

  const adapter = getAdapter(viva.provider);
  let grupos: Array<{ chatId: string; subject: string | null }>;
  try {
    // `!` seguro: a presença do método foi a condição que escolheu esta sessão.
    grupos = await adapter.listGroups!({
      organizationId: activeOrg.orgId,
      sessionRef: resolveSessionRef(viva),
    });
  } catch (err) {
    logger.warn("grupos.import: o canal não devolveu a lista", {
      organization_id: activeOrg.orgId,
      detail: (err instanceof Error ? err.message : String(err)).slice(0, 160),
    });
    return fail(
      "channel_error",
      "Não foi possível falar com o WhatsApp agora. Tente de novo em alguns instantes.",
      502,
      { requestId },
    );
  }

  const admin = createAdminClient();
  const resultado: Resultado = { encontrados: grupos.length, vinculados: 0, falharam: 0 };

  for (const g of grupos) {
    // Um grupo que falha não derruba os outros: quem tem 40 grupos e um com
    // problema prefere 39 na tela a uma mensagem de erro e nenhum.
    const { data: contactId, error } = await admin.rpc("fn_upsert_wa_group_contact" as never, {
      p_org: activeOrg.orgId,
      p_group_chat_id: g.chatId,
      p_subject: g.subject,
    } as never);
    if (error || !contactId) {
      resultado.falharam += 1;
      logger.warn("grupos.import: contato do grupo não gravado", {
        organization_id: activeOrg.orgId,
        detail: (error?.message ?? "rpc devolveu vazio").slice(0, 160),
      });
      continue;
    }

    // A conversa do grupo é achada pela CHAVE do grupo, numa operação só — e já
    // nasce com `is_group` e `group_chat_id`. A versão anterior criava a conversa
    // 1:1 e a carimbava depois com um UPDATE, que colidia com o índice
    // `(org, contato, sessão, group_chat_id)` assim que o grupo já existia (a
    // importação roda DE NOVO sempre que alguém clica em "importar"). Ver a
    // migration 0216 e `upsertConversaDeGrupo`, no ingest do canal.
    //
    // A marca `is_group` é o que mantém a IA calada neste grupo: o filtro
    // `ignore_groups` do despachante a lê. Por isso falhar aqui CONTA como falha
    // do grupo inteiro, e não como detalhe cosmético.
    const { data: conversationId, error: erroConversa } = await admin.rpc(
      "fn_upsert_wa_group_conversation" as never,
      {
        p_org: activeOrg.orgId,
        p_contact: contactId,
        p_session: viva.id,
        p_group_chat_id: g.chatId,
      } as never,
    );
    if (erroConversa || !conversationId) {
      resultado.falharam += 1;
      logger.warn("grupos.import: conversa do grupo não criada", {
        organization_id: activeOrg.orgId,
        detail: (erroConversa?.message ?? "rpc devolveu vazio").slice(0, 160),
      });
      continue;
    }

    resultado.vinculados += 1;
  }

  logger.info("grupos.import: concluída", {
    organization_id: activeOrg.orgId,
    encontrados: resultado.encontrados,
    vinculados: resultado.vinculados,
    falharam: resultado.falharam,
  });

  return ok(resultado, { requestId });
}
