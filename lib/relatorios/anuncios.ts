/**
 * O RELATÓRIO POR ANÚNCIO: o que o banco junta (negócios + gasto) vira o que a tela mostra (custos e retorno).
 *
 * Puro: sem banco, sem relógio. O banco devolve uma linha por anúncio (`fn_relatorio_de_anuncios`); aqui entram as
 * contas, e é aqui que ficam as regras para NÃO mentir:
 *  - Custo por contato = gasto ÷ contatos. Sem contato, ou sem gasto informado, é `null` ("—"), nunca 0: zero diria
 *    "de graça", e dividir por zero não é custo infinito, é ausência de resposta.
 *  - Retorno = valor ganho ÷ gasto. O valor ganho do CRM é em reais; então o retorno só existe quando o gasto
 *    também está em reais. Conta de anúncios em outra moeda mostra o gasto na moeda dela e deixa o retorno em "—":
 *    dividir reais por dólares seria um número bonito e errado.
 *  - Custo por conversa = gasto ÷ conversas iniciadas que a Meta informa (não os contatos do CRM). Mesma regra: sem
 *    conversa ou sem gasto é `null`.
 *  - O gasto TOTAL só soma quando todas as linhas estão na mesma moeda.
 */

/** Uma linha de `fn_relatorio_de_anuncios`, com os `bigint` já convertidos. */
export interface LinhaDeAnuncio {
  ad_id: string | null;
  titulo: string | null;
  campanha: string | null;
  conjunto: string | null;
  anuncio: string | null;
  leads: number;
  abertos: number;
  ganhos: number;
  perdidos: number;
  valor_ganho_cents: number;
  gasto_cents: number;
  impressoes: number;
  cliques: number;
  /** Conversas iniciadas, como a Meta as conta (o número do Gerenciador de Anúncios). */
  conversas: number;
  moeda: string | null;
}

export interface Desempenho {
  /** Contatos que o CRM reconheceu como vindos do anúncio. */
  leads: number;
  /** Conversas iniciadas que a PRÓPRIA Meta informa — pode ser maior que `leads` (o CRM só conta o que reconheceu). */
  conversas: number;
  /** gasto ÷ conversas da Meta, em centavos da moeda da conta. */
  custoPorConversaCents: number | null;
  impressoes: number;
  cliques: number;
  ganhos: number;
  valorGanhoCents: number;
  gastoCents: number;
  moeda: string | null;
  /** gasto ÷ contatos, em centavos da moeda da conta. */
  custoPorContatoCents: number | null;
  /** gasto ÷ vendas, em centavos da moeda da conta. */
  custoPorVendaCents: number | null;
  /** valor ganho ÷ gasto (ex.: 4.2 = R$ 4,20 para cada R$ 1). Só com o gasto em reais. */
  retorno: number | null;
}

export interface AnuncioDoRelatorio extends Desempenho {
  chave: string;
  /** O nome do anúncio na Meta; se o gasto ainda não foi sincronizado, o título que veio no clique. */
  rotulo: string;
  campanha: string | null;
  conjunto: string | null;
  abertos: number;
  perdidos: number;
  /** Gastou e ninguém chamou: o achado mais útil da tabela. */
  gastouSemContato: boolean;
}

/** Dinheiro na moeda da conta de anúncios ("R$ 123,45", "US$ 10,00"). Moeda desconhecida cai em reais. */
export function formatarDinheiro(cents: number, moeda: string | null): string {
  const m = moeda && /^[A-Z]{3}$/.test(moeda) ? moeda : "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: m }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2).replace(".", ",")} ${m}`;
  }
}

/** 4.2 → "4,20x". `null` → "—". */
export function formatarRetorno(retorno: number | null): string {
  return retorno === null ? "—" : `${retorno.toFixed(2).replace(".", ",")}x`;
}

export function desempenho(d: {
  leads: number;
  conversas?: number;
  impressoes?: number;
  cliques?: number;
  ganhos: number;
  valorGanhoCents: number;
  gastoCents: number;
  moeda: string | null;
}): Desempenho {
  const temGasto = d.gastoCents > 0;
  const conversas = d.conversas ?? 0;
  return {
    ...d,
    conversas,
    impressoes: d.impressoes ?? 0,
    cliques: d.cliques ?? 0,
    custoPorConversaCents: temGasto && conversas > 0 ? Math.round(d.gastoCents / conversas) : null,
    custoPorContatoCents: temGasto && d.leads > 0 ? Math.round(d.gastoCents / d.leads) : null,
    custoPorVendaCents: temGasto && d.ganhos > 0 ? Math.round(d.gastoCents / d.ganhos) : null,
    retorno: temGasto && d.moeda === "BRL" ? d.valorGanhoCents / d.gastoCents : null,
  };
}

export function montarAnuncios(linhas: LinhaDeAnuncio[]): { anuncios: AnuncioDoRelatorio[]; total: Desempenho } {
  const anuncios: AnuncioDoRelatorio[] = linhas.map((l) => {
    const d = desempenho({
      leads: l.leads,
      conversas: l.conversas,
      impressoes: l.impressoes,
      cliques: l.cliques,
      ganhos: l.ganhos,
      valorGanhoCents: l.valor_ganho_cents,
      gastoCents: l.gasto_cents,
      moeda: l.moeda,
    });
    return {
      ...d,
      chave: l.ad_id ? `anuncio:${l.ad_id}` : "sem-codigo",
      rotulo: l.anuncio?.trim() || l.titulo?.trim() || (l.ad_id ? "Anúncio sem nome" : "Anúncio sem identificação"),
      campanha: l.campanha,
      conjunto: l.conjunto,
      abertos: l.abertos,
      perdidos: l.perdidos,
      // Só "ninguém chamou" quando nem a Meta registrou conversa: se ela contou conversas, alguém chamou.
      gastouSemContato: l.gasto_cents > 0 && l.leads === 0 && l.conversas === 0,
    };
  });

  anuncios.sort(
    (a, b) => b.gastoCents - a.gastoCents || b.leads - a.leads || a.rotulo.localeCompare(b.rotulo, "pt-BR"),
  );

  const moedas = new Set(anuncios.filter((a) => a.gastoCents > 0).map((a) => a.moeda ?? "?"));
  const moedaUnica = moedas.size === 1 ? ([...moedas][0] === "?" ? null : [...moedas][0]!) : null;
  const gastoSomavel = moedas.size <= 1;
  const soma = anuncios.reduce(
    (acc, a) => ({
      leads: acc.leads + a.leads,
      conversas: acc.conversas + a.conversas,
      impressoes: acc.impressoes + a.impressoes,
      cliques: acc.cliques + a.cliques,
      ganhos: acc.ganhos + a.ganhos,
      valorGanhoCents: acc.valorGanhoCents + a.valorGanhoCents,
      gastoCents: acc.gastoCents + a.gastoCents,
    }),
    { leads: 0, conversas: 0, impressoes: 0, cliques: 0, ganhos: 0, valorGanhoCents: 0, gastoCents: 0 },
  );

  return {
    anuncios,
    total: desempenho({
      ...soma,
      // Moedas misturadas: o gasto total não existe (zerado e sem custo/retorno) em vez de somar maçã com dólar.
      gastoCents: gastoSomavel ? soma.gastoCents : 0,
      moeda: gastoSomavel ? moedaUnica : null,
    }),
  };
}
