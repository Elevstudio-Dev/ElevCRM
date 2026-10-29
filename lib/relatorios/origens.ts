/**
 * AGRUPAR O RELATÓRIO DE ORIGENS.
 *
 * O banco devolve uma linha por (origem, detalhe) — `fn_relatorio_de_origens` — e aqui ela vira o que a tela
 * mostra: oito grupos com rótulo humano, cada um com seus detalhes (cada QR pelo nome, cada anúncio pelo título,
 * cada formulário pela campanha), mais o total.
 *
 * Puro: sem banco, sem relógio. Os nomes dos QRs e das fontes de formulário chegam por mapa — o banco só guarda
 * ids no detalhe, e um QR renomeado depois tem de aparecer com o nome de hoje.
 */
import { diaNoFuso } from "./periodo";

export type GrupoDeOrigem = "qr" | "anuncio" | "formulario" | "whatsapp" | "manual" | "importado" | "ia" | "outros";

export const ORDEM_DOS_GRUPOS: GrupoDeOrigem[] = [
  "qr",
  "anuncio",
  "formulario",
  "whatsapp",
  "manual",
  "importado",
  "ia",
  "outros",
];

export const ROTULO_DO_GRUPO: Record<GrupoDeOrigem, string> = {
  qr: "QR codes",
  anuncio: "Anúncios",
  formulario: "Formulários",
  whatsapp: "WhatsApp direto",
  manual: "Criados à mão",
  importado: "Importados",
  ia: "IA e retomadas",
  outros: "Outras origens",
};

export function grupoDaOrigem(source: string): GrupoDeOrigem {
  switch (source) {
    case "qr_code":
      return "qr";
    case "meta_ads":
    case "google_ads":
      return "anuncio";
    case "webhook":
      return "formulario";
    case "whatsapp":
      return "whatsapp";
    case "manual":
      return "manual";
    case "import":
    case "importacao":
    case "csv":
    case "planilha":
      return "importado";
    case "agent":
    case "ai_agent":
    case "reactivation":
      return "ia";
    default:
      return "outros";
  }
}

/** Uma linha de `fn_relatorio_de_origens`, com os `bigint` já convertidos. */
export interface LinhaDeOrigem {
  source: string;
  detalhe: string | null;
  leads: number;
  abertos: number;
  ganhos: number;
  perdidos: number;
  valor_ganho_cents: number;
}

export interface Totais {
  leads: number;
  abertos: number;
  ganhos: number;
  perdidos: number;
  valorGanhoCents: number;
  conversao: number | null;
}

export interface DetalheDoGrupo extends Totais {
  chave: string;
  rotulo: string;
}

export interface GrupoDoRelatorio extends Totais {
  grupo: GrupoDeOrigem;
  detalhes: DetalheDoGrupo[];
}

/** Ganhos ÷ (ganhos + perdidos). `null` enquanto ninguém fechou — "0%" mentiria que todos foram perdidos. */
export function conversao(ganhos: number, perdidos: number): number | null {
  const fechados = ganhos + perdidos;
  return fechados === 0 ? null : ganhos / fechados;
}

const ZERO = { leads: 0, abertos: 0, ganhos: 0, perdidos: 0, valorGanhoCents: 0 };

function somar(a: Omit<Totais, "conversao">, l: LinhaDeOrigem): Omit<Totais, "conversao"> {
  return {
    leads: a.leads + l.leads,
    abertos: a.abertos + l.abertos,
    ganhos: a.ganhos + l.ganhos,
    perdidos: a.perdidos + l.perdidos,
    valorGanhoCents: a.valorGanhoCents + l.valor_ganho_cents,
  };
}

function comConversao(t: Omit<Totais, "conversao">): Totais {
  return { ...t, conversao: conversao(t.ganhos, t.perdidos) };
}

export interface NomesDoRelatorio {
  /** id do QR → nome de hoje */
  qr: Map<string, string>;
  /** id da fonte de formulário → nome */
  fonte: Map<string, string>;
}

function detalheDaLinha(l: LinhaDeOrigem, grupo: GrupoDeOrigem, nomes: NomesDoRelatorio): { chave: string; rotulo: string } {
  switch (grupo) {
    case "qr": {
      // A chave é o ID: dois QRs podem ter o mesmo nome e continuam sendo dois.
      const id = l.detalhe ?? "";
      return { chave: `qr:${id}`, rotulo: nomes.qr.get(id) ?? "QR removido" };
    }
    case "anuncio": {
      const titulo = l.detalhe?.trim();
      const rotulo = titulo ? titulo : "Anúncio sem título";
      return { chave: rotulo, rotulo };
    }
    case "formulario": {
      const bruto = l.detalhe?.trim() ?? "";
      if (bruto.startsWith("fonte:")) {
        const rotulo = nomes.fonte.get(bruto.slice("fonte:".length)) ?? "Formulário sem campanha";
        return { chave: rotulo, rotulo };
      }
      const rotulo = bruto === "" ? "Formulário sem campanha" : bruto;
      return { chave: rotulo, rotulo };
    }
    default: {
      const rotulo = ROTULO_DO_GRUPO[grupo];
      return { chave: rotulo, rotulo };
    }
  }
}

export function agruparOrigens(
  linhas: LinhaDeOrigem[],
  nomes: NomesDoRelatorio,
): { grupos: GrupoDoRelatorio[]; total: Totais } {
  const porGrupo = new Map<GrupoDeOrigem, Map<string, { rotulo: string; t: Omit<Totais, "conversao"> }>>();
  let total: Omit<Totais, "conversao"> = ZERO;

  for (const l of linhas) {
    const grupo = grupoDaOrigem(l.source);
    const { chave, rotulo } = detalheDaLinha(l, grupo, nomes);
    const detalhes = porGrupo.get(grupo) ?? new Map();
    const atual = detalhes.get(chave) ?? { rotulo, t: ZERO };
    detalhes.set(chave, { rotulo, t: somar(atual.t, l) });
    porGrupo.set(grupo, detalhes);
    total = somar(total, l);
  }

  const grupos: GrupoDoRelatorio[] = [];
  for (const grupo of ORDEM_DOS_GRUPOS) {
    const detalhes = porGrupo.get(grupo);
    if (!detalhes) continue;
    const lista: DetalheDoGrupo[] = [...detalhes.entries()]
      .map(([chave, v]) => ({ chave, rotulo: v.rotulo, ...comConversao(v.t) }))
      .sort((a, b) => b.leads - a.leads || a.rotulo.localeCompare(b.rotulo, "pt-BR"));
    const soma = lista.reduce<Omit<Totais, "conversao">>(
      (acc, d) => ({
        leads: acc.leads + d.leads,
        abertos: acc.abertos + d.abertos,
        ganhos: acc.ganhos + d.ganhos,
        perdidos: acc.perdidos + d.perdidos,
        valorGanhoCents: acc.valorGanhoCents + d.valorGanhoCents,
      }),
      ZERO,
    );
    if (soma.leads === 0) continue;
    grupos.push({ grupo, ...comConversao(soma), detalhes: lista });
  }

  return { grupos, total: comConversao(total) };
}

export type DiaDaSerie = { dia: string } & Record<GrupoDeOrigem, number>;

function diaVazio(dia: string): DiaDaSerie {
  return { dia, qr: 0, anuncio: 0, formulario: 0, whatsapp: 0, manual: 0, importado: 0, ia: 0, outros: 0 };
}

/**
 * Leads por dia e por grupo, com TODOS os dias do período — dia sem lead entra com zero, senão o gráfico
 * "pula" o dia e a linha do tempo mente sobre a distância entre dois picos.
 */
export function serieDiaria(
  linhas: Array<{ dia: string; source: string; leads: number }>,
  de: Date,
  ate: Date,
  fuso: string,
): DiaDaSerie[] {
  const porDia = new Map<string, DiaDaSerie>();
  // Avança de 24h em 24h a partir da meia-noite inicial e deduplica: na virada do horário de verão um dia
  // tem 23 ou 25h e o mesmo rótulo pode aparecer duas vezes.
  for (let t = de.getTime(); t < ate.getTime(); t += 24 * 3600 * 1000) {
    const dia = diaNoFuso(new Date(t), fuso);
    if (!porDia.has(dia)) porDia.set(dia, diaVazio(dia));
  }
  for (const l of linhas) {
    // Linha fora da janela (fuso diferente do pedido, por exemplo) NÃO some: ganha o próprio dia.
    const linha = porDia.get(l.dia) ?? diaVazio(l.dia);
    linha[grupoDaOrigem(l.source)] += l.leads;
    porDia.set(l.dia, linha);
  }
  return [...porDia.values()].sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}
