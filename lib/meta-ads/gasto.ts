/**
 * O GASTO QUE A META INFORMA, NA FORMA QUE O BANCO GUARDA.
 *
 * A Meta devolve dinheiro como TEXTO decimal na moeda da conta ("123.45") e contadores como texto ("1200"). Dois
 * cuidados que este arquivo existe para ter num lugar só:
 *  - dinheiro NÃO passa por `parseFloat`: "0.29" * 100 dá 28.999999999999996 em ponto flutuante. O texto é cortado
 *    em parte inteira e fracionária e vira centavos por aritmética de inteiros.
 *  - tudo o que vem de fora é validado: um anúncio sem código, uma data fora do formato ou um valor negativo é
 *    DESCARTADO (e contado), nunca gravado torto.
 */

export interface LinhaDeGasto {
  dia: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  spend_cents: number;
  impressions: number;
  clicks: number;
  /** Conversas iniciadas no WhatsApp a partir do anúncio, como a Meta as conta (o número do Gerenciador). */
  conversations: number;
  currency: string | null;
}

/**
 * O tipo de ação em que a Meta conta "Conversas por mensagem iniciadas" — a coluna que o Gerenciador de Anúncios
 * mostra para campanhas de mensagem (clique para o WhatsApp). Em `actions` ela vem como
 * `{ action_type, value: "3" }`, com o valor em texto.
 */
export const ACAO_CONVERSA_INICIADA = "onsite_conversion.messaging_conversation_started_7d";

/** As conversas iniciadas dentro de `actions` (0 quando o anúncio não é de mensagem ou a lista não existe). */
export function conversasIniciadas(actions: unknown): number {
  if (!Array.isArray(actions)) return 0;
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const { action_type: tipo, value } = a as Record<string, unknown>;
    if (tipo === ACAO_CONVERSA_INICIADA) return contador(value) ?? 0;
  }
  return 0;
}

/** "123.45" → 12345. `null` para qualquer coisa que não seja dinheiro bem formado. */
export function centavos(valor: unknown): number | null {
  if (typeof valor === "number") {
    if (!Number.isFinite(valor) || valor < 0) return null;
    return centavos(valor.toFixed(6));
  }
  if (typeof valor !== "string") return null;
  const m = /^(\d{1,12})(?:\.(\d{1,8}))?$/.exec(valor.trim());
  if (!m) return null;
  const inteiro = Number(m[1]);
  const fracao = (m[2] ?? "").padEnd(3, "0");
  const centavosBase = Number(fracao.slice(0, 2));
  const arredonda = Number(fracao[2]) >= 5 ? 1 : 0;
  const total = inteiro * 100 + centavosBase + arredonda;
  return Number.isSafeInteger(total) ? total : null;
}

/** Contador ("1200") → 1200. `null` se não for inteiro não negativo. */
export function contador(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isSafeInteger(valor) && valor >= 0 ? valor : null;
  if (typeof valor !== "string") return null;
  return /^\d{1,15}$/.test(valor.trim()) ? Number(valor.trim()) : null;
}

function texto(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, max);
}

/** Código na Meta: só dígitos. */
function codigo(v: unknown): string | null {
  return typeof v === "string" && /^\d{5,25}$/.test(v.trim()) ? v.trim() : null;
}

/**
 * Uma linha de `GET /act_<id>/insights?level=ad&time_increment=1` → a linha do banco, ou `null` se não presta.
 * `moedaDaConta` é o fallback quando a linha não traz `account_currency`.
 */
export function linhaDeGasto(bruta: unknown, moedaDaConta: string | null): LinhaDeGasto | null {
  if (!bruta || typeof bruta !== "object" || Array.isArray(bruta)) return null;
  const r = bruta as Record<string, unknown>;
  const adId = codigo(r.ad_id);
  const dia = typeof r.date_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date_start) ? r.date_start : null;
  const gasto = centavos(r.spend);
  if (!adId || !dia || gasto === null) return null;
  const moeda = texto(r.account_currency, 3)?.toUpperCase() ?? moedaDaConta;
  return {
    dia,
    ad_id: adId,
    ad_name: texto(r.ad_name),
    adset_id: codigo(r.adset_id),
    adset_name: texto(r.adset_name),
    campaign_id: codigo(r.campaign_id),
    campaign_name: texto(r.campaign_name),
    spend_cents: gasto,
    impressions: contador(r.impressions) ?? 0,
    clicks: contador(r.clicks) ?? 0,
    conversations: conversasIniciadas(r.actions),
    currency: moeda && /^[A-Z]{3}$/.test(moeda) ? moeda : null,
  };
}
