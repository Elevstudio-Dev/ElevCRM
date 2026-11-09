/**
 * Extrator de atribuição de anúncio da mensagem crua do transporte por QR.
 *
 * Mora em `lib/waha/` pelo mesmo motivo do irmão em `lib/channels/`: nomear o
 * provider aqui é legítimo (é o próprio canal), e fora daqui o
 * `pnpm lint:channels` reprova. O formato agnóstico e a gravação estão em
 * `lib/leads/atribuicao-de-anuncio.ts`.
 */
import type { AtribuicaoDeAnuncio, Bruto } from "@/lib/leads/atribuicao-de-anuncio";
import { obj, str } from "@/lib/leads/atribuicao-de-anuncio";

/**
 * `contextInfo.externalAdReply` do Baileys — o mesmo dado do anúncio,
 * embutido na PRÓPRIA mensagem que o app do cliente manda ao clicar num
 * anúncio "Clique para o WhatsApp". `messageRaw` é `_data.message` do payload
 * do WAHA (NOWEB) — a forma bruta do Baileys, sem normalização.
 *
 * ⚠️ O NOME DA CHAVE é `externalAdReply`. Este extrator lia `externalAdReplyInfo`
 * (o nome do TIPO no protobuf, não o do campo) e nunca reconheceu um anúncio:
 * a primeira mensagem de uma campanha real da Meta chegou, o contato foi criado
 * e ficou sem origem. Os testes escreviam a mesma chave errada, então passavam.
 * O formato real foi lido do webhook da clínica (06/11/2026); a forma antiga
 * continua aceita por não custar nada.
 *
 * O ad-reply pode chegar em qualquer tipo de mensagem com `contextInfo`
 * (o clique manda texto na maioria dos casos, daí `extendedTextMessage` vir
 * primeiro na lista de candidatos), então a busca varre os tipos comuns em
 * vez de assumir um só.
 */
export function extrairAtribuicaoWaha(messageRaw: unknown): AtribuicaoDeAnuncio | null {
  const m = obj(messageRaw);
  if (!m) return null;

  // Os tipos comuns primeiro (o clique manda texto na maioria dos casos), depois
  // QUALQUER outro tipo de mensagem que traga `contextInfo` — áudio, documento,
  // figurinha: o anúncio pode vir em qualquer um, e a lista fixa os perdia.
  const candidatos = [
    obj(m.extendedTextMessage)?.contextInfo,
    obj(m.imageMessage)?.contextInfo,
    obj(m.videoMessage)?.contextInfo,
    obj(m.conversation) ? null : m.contextInfo,
    ...Object.values(m).map((v) => obj(v)?.contextInfo),
  ];
  // O primeiro `contextInfo` que de fato carrega o anúncio — um `contextInfo`
  // de resposta/menção que vem antes não pode esconder o que está num irmão.
  const ad = candidatos
    .map(obj)
    .map((c) => obj(c?.externalAdReply) ?? obj(c?.externalAdReplyInfo))
    .find((a): a is Bruto => a !== null);
  if (!ad) return null;

  // O mesmo filtro que o irmão da API oficial aplica, e que aqui faltava: post
  // ORGÂNICO compartilhado não é anúncio pago. Sem esta linha, o primeiro
  // compartilhamento de um post carimba `meta_ads` no contato — e a guarda de
  // primeiro toque torna isso IRREVERSÍVEL pelo caminho normal.
  const tipo = str(ad.sourceType) ?? str(ad.source_type);
  if (tipo && tipo !== "ad") return null;

  const sourceId = str(ad.ctwaClid) ?? str(ad.sourceId);
  const titulo = str(ad.title);
  const sourceUrl = str(ad.sourceUrl);
  if (!sourceId && !titulo && !sourceUrl) return null;

  return {
    plataforma: "meta_ads",
    sourceId,
    titulo,
    corpo: str(ad.body),
    sourceUrl,
    bruto: ad,
  };
}
