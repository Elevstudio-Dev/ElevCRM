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
 * `conversionSource` é o campo em que a própria Meta declara a origem do clique ("FB_Ads" no webhook real).
 * Só os valores de anúncio pago contam; vazio ou qualquer outro valor não carimba — carimbar errado é
 * irreversível pela guarda de primeiro toque.
 */
const ORIGEM_DE_ANUNCIO = /^(fb|ig|facebook|instagram|meta)[_\s-]?ads?$/i;

/**
 * O clique que chegou sem `externalAdReply`: não há título, código do anúncio nem link — só a prova de que
 * veio de um anúncio. `bruto` guarda só os sinais (nunca o texto da mensagem). Sem `sourceId`, o relatório
 * conta o lead como "anúncio sem código" em vez de atribuí-lo a um anúncio específico.
 */
function atribuicaoSemCartao(contextos: (Bruto | null)[]): AtribuicaoDeAnuncio | null {
  const c = contextos.find((x) => {
    const origem = str(x?.conversionSource);
    return origem !== null && ORIGEM_DE_ANUNCIO.test(origem);
  });
  if (!c) return null;

  const bruto: Bruto = {};
  for (const chave of [
    "conversionSource",
    "ctwaSignals",
    "ctwaPayload",
    "entryPointConversionSource",
    "entryPointConversionApp",
  ]) {
    const valor = str(c[chave]);
    if (valor) bruto[chave] = valor;
  }
  return { plataforma: "meta_ads", sourceId: null, titulo: null, corpo: null, sourceUrl: null, bruto };
}

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
 *
 * Se o clique chegar SEM o cartão (só com os sinais `conversionSource`/`ctwaPayload`),
 * ainda é um lead de anúncio: ver `atribuicaoSemCartao`.
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
  const contextos = candidatos.map(obj);
  const ad = contextos
    .map((c) => obj(c?.externalAdReply) ?? obj(c?.externalAdReplyInfo))
    .find((a): a is Bruto => a !== null);
  // Sem o cartão: o WhatsApp às vezes entrega o clique SÓ com os sinais da Meta (visto na clínica em
  // 10/11/2026). Quem clicou continua sendo um lead de anúncio — só não sabemos qual anúncio.
  if (!ad) return atribuicaoSemCartao(contextos);

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
