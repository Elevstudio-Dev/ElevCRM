/**
 * Grava no CRM o histórico de um contato que o canal devolveu (`MensagemDoHistorico[]`).
 *
 * ## O que é — e o que NÃO é — uma mensagem importada
 *
 * Ela já aconteceu antes de o CRM conhecê-la. Por isso, ao contrário de uma mensagem que chega ao vivo:
 *   - NÃO dispara a IA, automações, sentimento nem follow-up. O gatilho de `messages` não emite evento quando a
 *     linha traz `metadata.historico_importado = true` (migration 0226), e este módulo nunca chama os efeitos
 *     pós-entrada (`aplicarEfeitosPosEntrada`) nem a pausa por atendimento manual;
 *   - NÃO conta como não lida: o contador do atendente não sobe por conversa de meses atrás;
 *   - NÃO traz o arquivo dos anexos (foto, áudio, documento). A linha existe, com o tipo e a legenda, marcada
 *     `midia_nao_importada`; baixar o conteúdo de um histórico inteiro seria pesado e levaria para o nosso
 *     armazenamento arquivos que o cliente nunca mandou para esta empresa neste canal.
 *
 * ## Idempotente — rodar duas vezes não duplica
 *
 * A mesma mensagem pode já estar gravada sob duas formas de id (o composto do webhook, o cru que o envio do CRM
 * grava). `MensagemDoHistorico.idsEquivalentes` traz todas; a importação pula a que casar com QUALQUER uma. E a
 * restrição única `(organization_id, external_id)` fecha a corrida: uma linha que escapou da checagem e colide
 * cai no insert linha a linha e é contada como "já existia", sem derrubar o resto.
 *
 * ## O anúncio
 *
 * Mensagem que carregava o clique de um anúncio leva `metadata.anuncio` (a bolha diz "Veio de anúncio"). Se a
 * mensagem JÁ estava no CRM sem a marca — chegou antes de o sistema marcar —, a importação a completa. E a primeira
 * mensagem de anúncio (a mais antiga) carimba o CONTATO, pela mesma guarda de primeiro toque da ingestão ao vivo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { MensagemDoHistorico } from "@/lib/channels/historico";
import {
  estamparAtribuicaoDoContato,
  marcaDeAnuncio,
  marcaDeAnuncioDaMensagem,
} from "@/lib/leads/atribuicao-de-anuncio";
import { logger } from "@/lib/logger";

/** O vocabulário de `messages.type` (a constraint `messages_type_check`). */
const TIPOS_VALIDOS = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
  "reaction",
  "system",
]);

const TAMANHO_DO_LOTE = 200;
const PAGINA_DE_LEITURA = 1_000;

export interface AlvoDaImportacao {
  organizationId: string;
  contactId: string;
  conversationId: string;
  channelSessionId: string;
}

export interface ResultadoDoHistorico {
  /** Quantas mensagens o canal devolveu. */
  encontradas: number;
  /** Quantas entraram agora. */
  importadas: number;
  /** Quantas já estavam no CRM. */
  jaExistiam: number;
  /** Quantas não puderam ser gravadas (a conversa segue; o número aparece para o atendente). */
  falharam: number;
  /** Quantas, entre as encontradas, vinham de um anúncio. */
  deAnuncio: number;
  /** O contato foi carimbado como "veio de anúncio" por esta importação. */
  contatoMarcadoComoAnuncio: boolean;
  primeiraEm: string | null;
  ultimaEm: string | null;
}

/** O status de uma mensagem importada, pelo último recibo conhecido. Inbound já foi entregue a nós. */
export function statusDaMensagemImportada(
  direcao: MensagemDoHistorico["direcao"],
  ack: number | null,
): "delivered" | "sent" | "read" {
  if (direcao === "inbound") return "delivered";
  if (ack !== null && ack >= 3) return "read";
  if (ack === 2) return "delivered";
  // Recibo 0, 1, ausente ou -1: "enviada". -1 NUNCA vira falha aqui — é o ruído que o canal manda em grupo e em
  // mensagem antiga, e marcar "falhou" numa conversa de meses faria o atendente reenviar o que o cliente já recebeu.
  return "sent";
}

function previaDa(m: MensagemDoHistorico): string {
  if (m.texto) return m.texto.slice(0, 280);
  return m.tipo !== "text" ? `[${m.tipo}]` : "";
}

function linhaDaMensagem(alvo: AlvoDaImportacao, m: MensagemDoHistorico) {
  const status = statusDaMensagemImportada(m.direcao, m.ack);
  return {
    organization_id: alvo.organizationId,
    conversation_id: alvo.conversationId,
    channel_session_id: alvo.channelSessionId,
    contact_id: alvo.contactId,
    external_id: m.externalId,
    type: TIPOS_VALIDOS.has(m.tipo) ? m.tipo : "text",
    direction: m.direcao,
    status,
    ack: m.ack,
    body: m.texto,
    media_mime: m.mediaMime,
    sent_via: "external_device",
    sent_at: m.enviadaEm,
    delivered_at: status === "sent" ? null : m.enviadaEm,
    metadata: {
      historico_importado: true,
      ...(m.anuncio ? { anuncio: marcaDeAnuncio(m.anuncio) } : {}),
      ...(m.temMidia ? { midia_nao_importada: true } : {}),
    },
  };
}

type Linha = ReturnType<typeof linhaDaMensagem>;

interface Existente {
  id: string;
  external_id: string | null;
  metadata: Record<string, unknown> | null;
}

/** Tudo o que o contato já tem gravado, por `external_id` — para não duplicar e para completar a marca de anúncio. */
async function lerExistentes(admin: SupabaseClient, alvo: AlvoDaImportacao): Promise<Map<string, Existente>> {
  const porExternalId = new Map<string, Existente>();
  for (let de = 0; ; de += PAGINA_DE_LEITURA) {
    const { data, error } = await admin
      .from("messages")
      .select("id, external_id, metadata")
      .eq("organization_id", alvo.organizationId)
      .eq("contact_id", alvo.contactId)
      .not("external_id", "is", null)
      .order("sent_at", { ascending: true })
      .range(de, de + PAGINA_DE_LEITURA - 1);
    if (error) throw new Error(`historico_leitura: ${error.message}`);
    const lote = (data ?? []) as Existente[];
    for (const e of lote) if (e.external_id) porExternalId.set(e.external_id, e);
    if (lote.length < PAGINA_DE_LEITURA) break;
  }
  return porExternalId;
}

/** Insere um lote; se o lote inteiro falha (uma linha colidiu), tenta linha a linha e conta cada desfecho. */
async function inserirLote(
  admin: SupabaseClient,
  linhas: Linha[],
): Promise<{ entraram: number; jaExistiam: number; falharam: number }> {
  if (linhas.length === 0) return { entraram: 0, jaExistiam: 0, falharam: 0 };
  const { error } = await admin.from("messages").insert(linhas);
  if (!error) return { entraram: linhas.length, jaExistiam: 0, falharam: 0 };

  let entraram = 0;
  let jaExistiam = 0;
  let falharam = 0;
  for (const linha of linhas) {
    const { error: erroDaLinha } = await admin.from("messages").insert(linha);
    if (!erroDaLinha) entraram += 1;
    else if (erroDaLinha.code === "23505") jaExistiam += 1;
    else {
      falharam += 1;
      logger.warn("historico.importar: linha não gravada", { detail: erroDaLinha.message.slice(0, 160) });
    }
  }
  return { entraram, jaExistiam, falharam };
}

export async function importarHistoricoDoContato(
  admin: SupabaseClient,
  alvo: AlvoDaImportacao,
  mensagens: MensagemDoHistorico[],
): Promise<ResultadoDoHistorico> {
  const vazio: ResultadoDoHistorico = {
    encontradas: 0,
    importadas: 0,
    jaExistiam: 0,
    falharam: 0,
    deAnuncio: 0,
    contatoMarcadoComoAnuncio: false,
    primeiraEm: null,
    ultimaEm: null,
  };
  if (mensagens.length === 0) return vazio;

  // Do mais antigo para o mais novo: a ordem de gravação acompanha a conversa, e "a primeira mensagem de anúncio"
  // (a que carimba o contato) é a mais antiga.
  const ordenadas = [...mensagens].sort((a, b) => a.enviadaEm.localeCompare(b.enviadaEm));
  const existentes = await lerExistentes(admin, alvo);

  const novas: MensagemDoHistorico[] = [];
  const aCompletar: Array<{ existente: Existente; mensagem: MensagemDoHistorico }> = [];
  let jaExistiam = 0;
  for (const m of ordenadas) {
    const achada = m.idsEquivalentes.map((id) => existentes.get(id)).find((e): e is Existente => Boolean(e));
    if (!achada) {
      novas.push(m);
      continue;
    }
    jaExistiam += 1;
    // Já estava no CRM mas sem a marca do anúncio: o histórico a completa.
    if (m.anuncio && !marcaDeAnuncioDaMensagem(achada.metadata)) {
      aCompletar.push({ existente: achada, mensagem: m });
    }
  }

  let importadas = 0;
  let falharam = 0;
  for (let i = 0; i < novas.length; i += TAMANHO_DO_LOTE) {
    const r = await inserirLote(
      admin,
      novas.slice(i, i + TAMANHO_DO_LOTE).map((m) => linhaDaMensagem(alvo, m)),
    );
    importadas += r.entraram;
    jaExistiam += r.jaExistiam;
    falharam += r.falharam;
  }

  for (const { existente, mensagem } of aCompletar) {
    const { error } = await admin
      .from("messages")
      .update({ metadata: { ...(existente.metadata ?? {}), anuncio: marcaDeAnuncio(mensagem.anuncio!) } })
      .eq("organization_id", alvo.organizationId)
      .eq("id", existente.id);
    if (error) logger.warn("historico.importar: marca de anúncio não completada", { detail: error.message.slice(0, 160) });
  }

  // O contato "veio de anúncio" pela mais antiga mensagem que carregou o clique. Primeiro toque: se o contato já
  // tem origem, o banco não troca (ver `estamparAtribuicaoDoContato`).
  const primeiraDeAnuncio = ordenadas.find((m) => m.anuncio && m.direcao === "inbound");
  let contatoMarcadoComoAnuncio = false;
  if (primeiraDeAnuncio?.anuncio) {
    const { data: antes } = await admin
      .from("contacts")
      .select("source_metadata")
      .eq("organization_id", alvo.organizationId)
      .eq("id", alvo.contactId)
      .maybeSingle();
    const jaTinha = Boolean((antes?.source_metadata as Record<string, unknown> | null)?.ad_platform);
    await estamparAtribuicaoDoContato(admin, alvo.contactId, primeiraDeAnuncio.anuncio);
    contatoMarcadoComoAnuncio = !jaTinha;
  }

  await atualizarConversa(admin, alvo, ordenadas);

  return {
    encontradas: mensagens.length,
    importadas,
    jaExistiam,
    falharam,
    deAnuncio: mensagens.filter((m) => m.anuncio).length,
    contatoMarcadoComoAnuncio,
    primeiraEm: ordenadas[0]!.enviadaEm,
    ultimaEm: ordenadas[ordenadas.length - 1]!.enviadaEm,
  };
}

/**
 * Se a mensagem mais nova do histórico é mais nova que o que a conversa mostra, a conversa passa a mostrá-la
 * (a lista do Inbox ordena por `last_message_at`). NUNCA mexe em `unread_count_for_assignee` — conversa antiga não
 * é "não lida" — e nunca recua a data: histórico não pode fazer a conversa parecer mais velha do que é.
 */
async function atualizarConversa(
  admin: SupabaseClient,
  alvo: AlvoDaImportacao,
  ordenadas: MensagemDoHistorico[],
): Promise<void> {
  const { data: conv, error } = await admin
    .from("conversations")
    .select("last_message_at, last_inbound_at, last_outbound_at")
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.conversationId)
    .maybeSingle();
  if (error || !conv) return;

  const maisNovaDe = (d: MensagemDoHistorico["direcao"]) => [...ordenadas].reverse().find((m) => m.direcao === d);
  const ultima = ordenadas[ordenadas.length - 1]!;
  const entrada = maisNovaDe("inbound");
  const saida = maisNovaDe("outbound");
  const maisNovo = (atual: string | null, candidato: string | undefined) =>
    candidato && (!atual || candidato > atual) ? candidato : undefined;

  const patch: Record<string, string> = {};
  const novaUltima = maisNovo(conv.last_message_at as string | null, ultima.enviadaEm);
  if (novaUltima) {
    patch.last_message_at = novaUltima;
    patch.last_message_preview = previaDa(ultima);
  }
  const novaEntrada = maisNovo(conv.last_inbound_at as string | null, entrada?.enviadaEm);
  if (novaEntrada) patch.last_inbound_at = novaEntrada;
  const novaSaida = maisNovo(conv.last_outbound_at as string | null, saida?.enviadaEm);
  if (novaSaida) patch.last_outbound_at = novaSaida;
  if (Object.keys(patch).length === 0) return;

  const { error: erroDoPatch } = await admin
    .from("conversations")
    .update(patch)
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.conversationId);
  if (erroDoPatch) {
    logger.warn("historico.importar: conversa não atualizada", { detail: erroDoPatch.message.slice(0, 160) });
  }
}
