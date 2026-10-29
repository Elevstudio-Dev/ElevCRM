/**
 * O PERÍODO DO RELATÓRIO, NO FUSO DE QUEM O LÊ.
 *
 * "Hoje" para um gestor em São Paulo não é "hoje" em UTC: um lead das 22h chega às 01h do dia seguinte em UTC, e
 * somá-lo no dia errado desloca o gráfico. Tudo aqui trabalha com datas `YYYY-MM-DD` do fuso informado e só
 * converte para instante (UTC) na hora de perguntar ao banco.
 *
 * Puro e sem dependência: `Intl` resolve o fuso, inclusive horário de verão.
 */

/** Diferença (local − UTC), em ms, do fuso naquele instante. */
function deslocamentoDoFuso(instanteMs: number, fuso: string): number {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instanteMs));
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value);
  const comoSeFosseUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return comoSeFosseUtc - Math.floor(instanteMs / 1000) * 1000;
}

/** O instante em que o dia `YYYY-MM-DD` começa no fuso. */
export function meiaNoiteNoFuso(ymd: string, fuso: string): Date {
  const [a, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const chute = Date.UTC(a, m - 1, d, 0, 0, 0);
  const primeiro = deslocamentoDoFuso(chute, fuso);
  let t = chute - primeiro;
  // Se o deslocamento muda entre o chute e o resultado (virada de horário de verão), refaz com o novo.
  const segundo = deslocamentoDoFuso(t, fuso);
  if (segundo !== primeiro) t = chute - segundo;
  return new Date(t);
}

/** O dia `YYYY-MM-DD` em que o instante cai, no fuso. */
export function diaNoFuso(instante: Date, fuso: string): string {
  // `en-CA` formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instante);
}

/** `YYYY-MM-DD` mais `n` dias (calendário, sem fuso: só aritmética de data). */
export function somarDias(ymd: string, n: number): string {
  const [a, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Os botões "7 / 30 / 90 dias": termina HOJE (no fuso) e conta hoje como o primeiro dia. */
export function periodoPreDefinido(dias: 7 | 30 | 90, agora: Date, fuso: string): { de: string; ate: string } {
  const hoje = diaNoFuso(agora, fuso);
  return { de: somarDias(hoje, -(dias - 1)), ate: hoje };
}
