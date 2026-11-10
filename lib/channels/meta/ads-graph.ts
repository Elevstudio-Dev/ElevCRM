/**
 * O CLIENTE DA META (Graph API) — só leitura, só o endereço oficial.
 *
 * Três regras que valem para qualquer chamada daqui:
 *  1. A CHAVE vai no cabeçalho `Authorization`, nunca na URL: URL aparece em log de proxy, de erro e de
 *     "próxima página". O campo `paging.next` que a Meta devolve não traz a chave justamente por isso.
 *  2. O único host é `graph.facebook.com`. A "próxima página" vem de dentro da resposta de um terceiro; seguir
 *     qualquer URL que ela mande seria SSRF. Host diferente → a página é recusada.
 *  3. O erro devolvido à tela é um CÓDIGO nosso (`token_invalido`, `sem_permissao`, `limite`, `indisponivel`),
 *     nunca o texto cru da Meta: a mensagem de um terceiro não vira texto de tela nem de log.
 */
import { linhaDeGasto, type LinhaDeGasto } from "@/lib/meta-ads/gasto";

/** A Meta mantém cada versão da Graph por ~2 anos; subir esta constante é uma mudança de código, revisada. */
export const VERSAO_DA_GRAPH = "v23.0";

const HOST = "graph.facebook.com";
const PAGINAS_NO_MAXIMO = 60;
const POR_PAGINA = 500;
const TIMEOUT_MS = 25_000;

/** Todos os estados em que um anúncio pode estar — incluindo arquivado, apagado e de campanha desativada. */
const STATUS_DE_ANUNCIO = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "ARCHIVED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
];

export type ErroDaMeta = "token_invalido" | "sem_permissao" | "limite" | "conta_invalida" | "indisponivel";

export class MetaAdsError extends Error {
  constructor(
    public readonly codigo: ErroDaMeta,
    public readonly httpStatus?: number,
  ) {
    super(codigo);
    this.name = "MetaAdsError";
  }
}

type Fetcher = typeof fetch;

/** O que a Meta disse, traduzido para o nosso vocabulário. Só olha os códigos, nunca repassa a mensagem. */
export function classificarErro(httpStatus: number, corpo: unknown): MetaAdsError {
  const e = (corpo as { error?: { code?: unknown; error_subcode?: unknown } } | null)?.error;
  const code = typeof e?.code === "number" ? e.code : null;
  if (code === 190 || httpStatus === 401) return new MetaAdsError("token_invalido", httpStatus);
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80004 || httpStatus === 429) {
    return new MetaAdsError("limite", httpStatus);
  }
  if (code === 10 || code === 200 || code === 294 || (code !== null && code >= 200 && code <= 299)) {
    return new MetaAdsError("sem_permissao", httpStatus);
  }
  if (code === 100 || httpStatus === 400 || httpStatus === 404) return new MetaAdsError("conta_invalida", httpStatus);
  return new MetaAdsError("indisponivel", httpStatus);
}

async function pedir(url: string, token: string, fetcher: Fetcher): Promise<unknown> {
  const alvo = new URL(url);
  if (alvo.protocol !== "https:" || alvo.hostname !== HOST) throw new MetaAdsError("indisponivel");
  let res: Response;
  try {
    res = await fetcher(alvo.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new MetaAdsError("indisponivel");
  }
  let corpo: unknown = null;
  try {
    corpo = await res.json();
  } catch {
    corpo = null;
  }
  if (!res.ok) throw classificarErro(res.status, corpo);
  return corpo;
}

export interface ContaDeAnuncios {
  nome: string | null;
  moeda: string | null;
}

/** Confere que a chave enxerga a conta e lê o nome e a moeda dela. */
export async function lerConta(
  adAccountId: string,
  token: string,
  fetcher: Fetcher = fetch,
): Promise<ContaDeAnuncios> {
  if (!/^\d{5,20}$/.test(adAccountId)) throw new MetaAdsError("conta_invalida");
  const url = `https://${HOST}/${VERSAO_DA_GRAPH}/act_${adAccountId}?fields=name,currency`;
  const corpo = (await pedir(url, token, fetcher)) as { name?: unknown; currency?: unknown } | null;
  const moeda = typeof corpo?.currency === "string" && /^[A-Z]{3}$/.test(corpo.currency) ? corpo.currency : null;
  const nome = typeof corpo?.name === "string" && corpo.name.trim() ? corpo.name.trim().slice(0, 200) : null;
  return { nome, moeda };
}

export interface ResultadoDosInsights {
  linhas: LinhaDeGasto[];
  descartadas: number;
}

/** O gasto por dia e por anúncio entre duas datas (`YYYY-MM-DD`, inclusive nas duas pontas). */
export async function lerGastoPorAnuncio(
  adAccountId: string,
  token: string,
  de: string,
  ate: string,
  moedaDaConta: string | null,
  fetcher: Fetcher = fetch,
): Promise<ResultadoDosInsights> {
  if (!/^\d{5,20}$/.test(adAccountId)) throw new MetaAdsError("conta_invalida");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) throw new MetaAdsError("conta_invalida");

  const montar = (comFiltroDeStatus: boolean): string => {
    const q = new URLSearchParams({
      level: "ad",
      fields: "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,account_currency",
      time_range: JSON.stringify({ since: de, until: ate }),
      time_increment: "1",
      limit: String(POR_PAGINA),
    });
    // Sem este filtro a Meta devolve só os anúncios "vivos": o gasto dos arquivados e dos de campanhas
    // desativadas some do relatório, embora o Gerenciador o mostre (e some do total).
    if (comFiltroDeStatus) {
      q.set("filtering", JSON.stringify([{ field: "ad.effective_status", operator: "IN", value: STATUS_DE_ANUNCIO }]));
    }
    return `https://${HOST}/${VERSAO_DA_GRAPH}/act_${adAccountId}/insights?${q.toString()}`;
  };

  const lerTudo = async (primeira: string): Promise<ResultadoDosInsights> => {
    let url: string | null = primeira;
    const linhas: LinhaDeGasto[] = [];
    let descartadas = 0;
    for (let pagina = 0; url && pagina < PAGINAS_NO_MAXIMO; pagina += 1) {
      const corpo = (await pedir(url, token, fetcher)) as {
        data?: unknown;
        paging?: { next?: unknown };
      } | null;
      const dados = Array.isArray(corpo?.data) ? corpo.data : [];
      for (const bruta of dados) {
        const l = linhaDeGasto(bruta, moedaDaConta);
        if (l) linhas.push(l);
        else descartadas += 1;
      }
      url = typeof corpo?.paging?.next === "string" ? corpo.paging.next : null;
    }
    return { linhas, descartadas };
  };

  try {
    return await lerTudo(montar(true));
  } catch (err) {
    // Se a Meta recusar o filtro (parâmetro inválido), lê como antes: pior ter só os anúncios vivos do que nada.
    if (err instanceof MetaAdsError && err.codigo === "conta_invalida") return lerTudo(montar(false));
    throw err;
  }
}
