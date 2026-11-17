/**
 * O RELATO DA SECRETARIA — o que a IA entendeu quando ela contou como está a agenda.
 *
 * A agenda real da clínica vive no CRM da franquia, que ainda não integra com o nosso. A secretaria lê lá e conta
 * por mensagem ("terça 14h Maria, 15h João; quarta fechado"). A IA converte o texto livre neste formato, devolve um
 * RESUMO para ela conferir, e só depois do "sim" a agenda daqui passa a refletir o que ela disse.
 *
 * Este arquivo é a parte PURA: o formato (Zod), a coerência e o resumo em português. Nada aqui lê banco, relógio
 * ou modelo — o relógio entra por parâmetro, porque o modelo não sabe que dia é hoje e quem resolve "amanhã" é o
 * servidor (ver `docs/superpowers/specs/2026-11-17-secretaria-e-marketing-design.md`, § 5.2).
 */
import { z } from "zod";

import { diaLocalISO, instanteDe, partesNoFuso } from "../fuso";

const DIA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const diaIso = z.string().regex(DIA_ISO, "use AAAA-MM-DD");
const instante = z.string().datetime({ offset: true });

/** Quantos dias um único relato pode cobrir. Mais que isso é erro de leitura, não relato. */
export const MAXIMO_DE_DIAS_DA_JANELA = 31;
export const MAXIMO_DE_MARCADOS = 200;

export const marcadoSchema = z.object({
  /** Como a secretaria escreveu o nome. Só o nome — nada além disso é pedido nem guardado. */
  nome: z.string().trim().min(1).max(80),
  /** Início, com fuso (offset). O servidor resolve datas relativas; o modelo só entrega o instante. */
  inicio: instante,
  /** Fim, quando ela disse. Ausente = o servidor usa a duração do atendimento. */
  fim: instante.optional(),
});

export const diaFechadoSchema = z.object({
  data: diaIso,
  motivo: z.string().trim().max(120).optional(),
});

export const relatoLidoSchema = z
  .object({
    /** Os dias que o relato COBRE: só dentro dela um relato novo pode cancelar o que o anterior criou. */
    janela: z.object({ de: diaIso, ate: diaIso }),
    marcados: z.array(marcadoSchema).max(MAXIMO_DE_MARCADOS),
    dias_fechados: z.array(diaFechadoSchema).max(MAXIMO_DE_DIAS_DA_JANELA),
    /** O que o modelo não conseguiu entender. Quem lê isto pergunta de volta em vez de adivinhar. */
    duvidas: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  })
  .superRefine((r, ctx) => {
    if (r.janela.ate < r.janela.de) {
      ctx.addIssue({ code: "custom", path: ["janela"], message: "o fim da janela é antes do começo" });
      return;
    }
    if (diasEntre(r.janela.de, r.janela.ate) + 1 > MAXIMO_DE_DIAS_DA_JANELA) {
      ctx.addIssue({
        code: "custom",
        path: ["janela"],
        message: `a janela cobre mais de ${MAXIMO_DE_DIAS_DA_JANELA} dias`,
      });
    }
    for (const [i, d] of r.dias_fechados.entries()) {
      if (d.data < r.janela.de || d.data > r.janela.ate) {
        ctx.addIssue({ code: "custom", path: ["dias_fechados", i, "data"], message: "dia fechado fora da janela" });
      }
    }
  });

export type RelatoLido = z.output<typeof relatoLidoSchema>;
export type Marcado = z.output<typeof marcadoSchema>;

/** Dias de calendário entre duas datas ISO (ambas inclusive nas contas de quem chama). */
export function diasEntre(de: string, ate: string): number {
  const a = Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) - 1, Number(de.slice(8, 10)));
  const b = Date.UTC(Number(ate.slice(0, 4)), Number(ate.slice(5, 7)) - 1, Number(ate.slice(8, 10)));
  return Math.round((b - a) / 86_400_000);
}

/** Todos os dias ISO de `de` a `ate`, inclusive. */
export function diasDaJanela(de: string, ate: string): string[] {
  const dias: string[] = [];
  const total = diasEntre(de, ate);
  const base = Date.UTC(Number(de.slice(0, 4)), Number(de.slice(5, 7)) - 1, Number(de.slice(8, 10)));
  for (let i = 0; i <= total; i += 1) dias.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  return dias;
}

/** O primeiro e o último instante de uma janela de dias locais, no fuso da agenda. */
export function limitesDaJanela(janela: { de: string; ate: string }, fuso: string): { inicio: Date; fim: Date } {
  const [a, m, d] = janela.de.split("-").map(Number) as [number, number, number];
  const [a2, m2, d2] = janela.ate.split("-").map(Number) as [number, number, number];
  const inicio = instanteDe({ ano: a, mes: m, dia: d, hora: 0, minuto: 0 }, fuso);
  // O fim é o começo do dia SEGUINTE ao último (exclusivo): evita decidir o que é "23:59:59".
  const depois = new Date(Date.UTC(a2, m2 - 1, d2) + 86_400_000);
  const fim = instanteDe(
    { ano: depois.getUTCFullYear(), mes: depois.getUTCMonth() + 1, dia: depois.getUTCDate(), hora: 0, minuto: 0 },
    fuso,
  );
  return { inicio, fim };
}

/** Nome para comparar: sem acento, sem caixa, espaços únicos. "  JOÃO  da  Silva " === "joao da silva". */
export function normalizarNome(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface ProblemaDoRelato {
  /** O que a pessoa precisa saber para corrigir, em português. */
  mensagem: string;
}

/**
 * O que ainda está ERRADO num relato que passou no esquema: horário fora da janela dela, fim antes do começo.
 * Devolve a lista (vazia = coerente). Quem chama pergunta de volta em vez de gravar um palpite.
 */
export function problemasDoRelato(relato: RelatoLido, fuso: string): ProblemaDoRelato[] {
  const problemas: ProblemaDoRelato[] = [];
  for (const m of relato.marcados) {
    const ini = new Date(m.inicio);
    const dia = diaLocalISO(ini, fuso);
    if (dia < relato.janela.de || dia > relato.janela.ate) {
      problemas.push({ mensagem: `${m.nome} aparece em ${rotuloDoDia(dia)}, que está fora dos dias que ela informou.` });
    }
    if (m.fim && new Date(m.fim).getTime() <= ini.getTime()) {
      problemas.push({ mensagem: `O horário de ${m.nome} termina antes de começar.` });
    }
  }
  return problemas;
}

const DIAS_DA_SEMANA = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"] as const;

/** "ter 18/11" — dia da semana abreviado e dia/mês, de uma data ISO. */
export function rotuloDoDia(dia: string): string {
  const ano = Number(dia.slice(0, 4));
  const mes = Number(dia.slice(5, 7));
  const d = Number(dia.slice(8, 10));
  const semana = DIAS_DA_SEMANA[new Date(Date.UTC(ano, mes - 1, d)).getUTCDay()] ?? "";
  return `${semana} ${String(d).padStart(2, "0")}/${String(mes).padStart(2, "0")}`;
}

/** "14h" ou "14h30". */
export function rotuloDaHora(quando: Date, fuso: string): string {
  const p = partesNoFuso(quando, fuso);
  return p.minuto === 0 ? `${p.hora}h` : `${p.hora}h${String(p.minuto).padStart(2, "0")}`;
}

/**
 * O resumo que a secretaria CONFERE — um dia por linha, na ordem do calendário:
 *
 *     ter 18/11: 14h Maria · 15h João
 *     qua 19/11: fechado
 *     qui 20/11: ninguém marcado
 *
 * Dia dentro da janela sem nada vira "ninguém marcado" (e não some): é o que ela precisa ver para dizer "não, na
 * quinta tem a Ana". O resumo termina com a pergunta; a resposta ("sim", ou o que corrigir) é lida pelo bastidor.
 */
export function resumoParaConferencia(relato: RelatoLido, fuso: string): string {
  const fechados = new Map(relato.dias_fechados.map((d) => [d.data, d.motivo]));
  const porDia = new Map<string, Array<{ ini: Date; nome: string }>>();
  for (const m of relato.marcados) {
    const ini = new Date(m.inicio);
    const dia = diaLocalISO(ini, fuso);
    const lista = porDia.get(dia) ?? [];
    lista.push({ ini, nome: m.nome });
    porDia.set(dia, lista);
  }

  const linhas = diasDaJanela(relato.janela.de, relato.janela.ate).map((dia) => {
    const rotulo = rotuloDoDia(dia);
    if (fechados.has(dia)) {
      const motivo = fechados.get(dia);
      return `${rotulo}: fechado${motivo ? ` (${motivo})` : ""}`;
    }
    const lista = (porDia.get(dia) ?? []).sort((a, b) => a.ini.getTime() - b.ini.getTime());
    if (lista.length === 0) return `${rotulo}: ninguém marcado`;
    return `${rotulo}: ${lista.map((x) => `${rotuloDaHora(x.ini, fuso)} ${x.nome}`).join(" · ")}`;
  });

  return ["Entendi assim:", ...linhas, "Está certo? Responda *sim* ou me diga o que corrigir."].join("\n");
}
