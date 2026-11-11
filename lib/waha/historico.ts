/**
 * O histórico de um chat do WAHA, traduzido para a forma neutra do CRM (`MensagemDoHistorico`).
 *
 * Duas peças, ambas sem banco:
 *   - `mensagemDoHistorico`  uma mensagem do store → a forma neutra (função pura, testada com payloads reais);
 *   - `buscarHistoricoWaha`  pagina o store até o teto e traduz.
 *
 * ## Por que reaproveita o schema do webhook
 *
 * O store devolve cada mensagem com a MESMA forma do payload do webhook (`id`, `fromMe`, `timestamp` em segundos,
 * `body`, `_data`…). Ler com o mesmo schema e os mesmos leitores (`payload.ts`) é o que garante que uma mensagem
 * importada e a mesma mensagem recebida ao vivo saiam IGUAIS — mesmo tipo, mesmo texto, mesma detecção de anúncio.
 */
import type { MensagemDoHistorico } from "@/lib/channels/historico";

import { extrairAtribuicaoWaha } from "./atribuicao-de-anuncio";
import type { WahaClient } from "./client";
import { wahaPayloadSchema } from "./envelope";
import { bareWaMessageId, chatIdFromWaMessageId } from "./message-id";
import { bodyOf, mediaMimeOf, notifyNameOf, resolveMessageType } from "./payload";

/** Itens por página. O WAHA aceita mais, mas página grande demais estoura o teto de tempo da chamada. */
export const TAMANHO_DA_PAGINA = 100;

/**
 * Todos os ids sob os quais ESTA mensagem pode já estar gravada:
 *   - o composto do webhook (`true_<chat>_<id>` / `false_<chat>_<id>`);
 *   - o cru que o envio do CRM devolve e grava (`<id>`).
 * O chat vem do pedido e do próprio id composto: o mesmo contato pode ter sido gravado por `@c.us` ou por `@lid`.
 */
function idsEquivalentes(id: string, chatId: string): string[] {
  const bare = bareWaMessageId(id);
  const chats = new Set<string>([chatId]);
  const doId = chatIdFromWaMessageId(id);
  if (doId) chats.add(doId);
  const ids = new Set<string>([id, bare]);
  for (const c of chats) {
    ids.add(`true_${c}_${bare}`);
    ids.add(`false_${c}_${bare}`);
  }
  return [...ids];
}

/**
 * Uma mensagem do store → a forma neutra. `null` quando não é uma mensagem que o CRM mostraria: sem id, sem hora,
 * sem texto nem anexo (eventos de protocolo, recibos), ou reação (que no WhatsApp é um adorno da mensagem
 * reagida, não uma bolha — importá-la soltaria um emoji sem contexto no meio da conversa).
 */
export function mensagemDoHistorico(cru: unknown, chatId: string): MensagemDoHistorico | null {
  const lido = wahaPayloadSchema.safeParse(cru);
  if (!lido.success) return null;
  const p = lido.data;
  if (!p.id || typeof p.timestamp !== "number" || !Number.isFinite(p.timestamp) || p.timestamp <= 0) return null;

  const tipo = resolveMessageType(p);
  if (tipo === "reaction") return null;

  const texto = bodyOf(p);
  const temMidia = Boolean(p.hasMedia || p.media || p.mediaUrl);
  if (!texto && !temMidia) return null;

  const saida = p.fromMe === true;
  // Anúncio é do que a PESSOA mandou: a nossa resposta nunca é o clique.
  const anuncio = saida ? null : extrairAtribuicaoWaha(p._data?.message);

  return {
    externalId: p.id,
    idsEquivalentes: idsEquivalentes(p.id, chatId),
    direcao: saida ? "outbound" : "inbound",
    enviadaEm: new Date(p.timestamp * 1000).toISOString(),
    tipo,
    texto,
    temMidia,
    mediaMime: mediaMimeOf(p),
    ack: typeof p.ack === "number" ? p.ack : null,
    nomeDoContato: saida ? null : notifyNameOf(p),
    anuncio,
  };
}

/**
 * Pagina o store do chat, das mais novas para as mais antigas, até `limite` mensagens ÚTEIS (ver
 * `mensagemDoHistorico`) ou até o store acabar. Um teto de páginas protege contra um store que repete a última
 * página para sempre: nada aqui roda sem fim.
 *
 * O erro `waha_store_desligado` do cliente PROPAGA — quem chama (o adapter) o traduz para o tipo do CRM.
 */
export async function buscarHistoricoWaha(
  client: Pick<WahaClient, "getChatMessages">,
  session: string,
  chatId: string,
  limite: number,
): Promise<MensagemDoHistorico[]> {
  const vistas = new Set<string>();
  const idsCrus = new Set<string>();
  const saida: MensagemDoHistorico[] = [];
  const maxPaginas = Math.ceil(limite / TAMANHO_DA_PAGINA) + 5;

  for (let pagina = 0; pagina < maxPaginas && saida.length < limite; pagina += 1) {
    const itens = await client.getChatMessages(session, chatId, {
      limit: TAMANHO_DA_PAGINA,
      offset: pagina * TAMANHO_DA_PAGINA,
    });
    let idsNovosNaPagina = 0;
    for (const cru of itens) {
      const idCru = (cru as { id?: unknown } | null)?.id;
      if (typeof idCru === "string") {
        if (!idsCrus.has(idCru)) idsNovosNaPagina += 1;
        idsCrus.add(idCru);
      }
      const m = mensagemDoHistorico(cru, chatId);
      if (!m || vistas.has(m.externalId)) continue;
      vistas.add(m.externalId);
      saida.push(m);
      if (saida.length >= limite) break;
    }
    // Página incompleta = o store acabou. Página cheia sem NENHUM id que ainda não vimos = o store está repetindo
    // a mesma página (offset ignorado): parar, em vez de pedir a mesma coisa até o teto.
    if (itens.length < TAMANHO_DA_PAGINA) break;
    if (idsNovosNaPagina === 0) break;
  }
  return saida;
}
