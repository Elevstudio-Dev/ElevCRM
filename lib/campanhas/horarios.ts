/**
 * QUANDO CADA MENSAGEM DA CAMPANHA SAI.
 *
 * Mandar para centenas de pessoas que não falam com a empresa há meses, tudo de
 * uma vez, é o jeito mais rápido de o WhatsApp bloquear o número. A campanha
 * por isso já nasce com a agenda inteira decidida: cada destinatário recebe uma
 * hora, dentro do horário comercial, com um intervalo irregular entre um e
 * outro e um teto por dia.
 *
 * ⚠️ O INTERVALO É DETERMINÍSTICO. O "sorteio" sai de um hash da semente (o id
 * da campanha) com o índice do envio: a mesma campanha planejada duas vezes dá
 * a mesma agenda, o teste não depende de `Math.random`, e retomar uma campanha
 * pausada não embaralha quem já estava na fila.
 *
 * ⚠️ O DIA E A HORA SÃO OS DO FUSO DA ORGANIZAÇÃO. "Das 9h às 18h" em UTC
 * mandaria mensagem às 6h da manhã em São Paulo.
 */
import { z } from "zod";

export const ritmoDaCampanhaSchema = z
  .strictObject({
    por_dia: z.number().int().min(1).max(200),
    min_minutos: z.number().int().min(1).max(120),
    max_minutos: z.number().int().min(1).max(240),
    hora_inicio: z.number().int().min(0).max(23),
    hora_fim: z.number().int().min(1).max(24),
    /** 0 = domingo … 6 = sábado. */
    dias: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  })
  .refine((r) => r.max_minutos >= r.min_minutos, {
    message: "O intervalo máximo precisa ser maior ou igual ao mínimo.",
    path: ["max_minutos"],
  })
  .refine((r) => r.hora_fim > r.hora_inicio, {
    message: "O fim do horário precisa ser depois do início.",
    path: ["hora_fim"],
  });

export type RitmoDaCampanha = z.infer<typeof ritmoDaCampanhaSchema>;

/** Padrão conservador para número de WhatsApp comum (não oficial). */
export const RITMO_PADRAO: RitmoDaCampanha = {
  por_dia: 30,
  min_minutos: 6,
  max_minutos: 15,
  hora_inicio: 9,
  hora_fim: 18,
  dias: [1, 2, 3, 4, 5, 6],
};

interface PartesLocais {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  diaDaSemana: number;
}

const DIAS_DA_SEMANA: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatadores = new Map<string, Intl.DateTimeFormat>();
function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatadores.set(fuso, f);
  }
  return f;
}

export function partesLocais(instante: Date, fuso: string): PartesLocais {
  const partes: Record<string, string> = {};
  for (const p of formatador(fuso).formatToParts(instante)) partes[p.type] = p.value;
  return {
    ano: Number(partes.year),
    mes: Number(partes.month),
    dia: Number(partes.day),
    hora: Number(partes.hour),
    minuto: Number(partes.minute),
    diaDaSemana: DIAS_DA_SEMANA[partes.weekday ?? "Sun"] ?? 0,
  };
}

/** O instante UTC de uma hora local (ano/mês/dia/hora/minuto) no fuso. */
export function instanteLocal(ano: number, mes: number, dia: number, hora: number, minuto: number, fuso: string): Date {
  const alvo = Date.UTC(ano, mes - 1, dia, hora, minuto);
  let palpite = alvo;
  // Duas voltas bastam para fuso com horário de verão: a 1ª acha o deslocamento,
  // a 2ª corrige o caso em que o palpite caiu do outro lado da virada.
  for (let i = 0; i < 2; i++) {
    const p = partesLocais(new Date(palpite), fuso);
    const comoLocal = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto);
    palpite += alvo - comoLocal;
  }
  return new Date(palpite);
}

function hash(texto: string): number {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Intervalo (minutos) antes do envio `indice`. Sempre em [min, max]. */
export function intervaloAntesDe(semente: string, indice: number, ritmo: RitmoDaCampanha): number {
  const faixa = ritmo.max_minutos - ritmo.min_minutos + 1;
  return ritmo.min_minutos + (hash(`${semente}:${indice}`) % faixa);
}

function chaveDoDia(p: PartesLocais): string {
  return `${p.ano}-${p.mes}-${p.dia}`;
}

/** Início (hora_inicio local) do primeiro dia permitido DEPOIS do dia de `p`. */
function inicioDoProximoDia(p: PartesLocais, ritmo: RitmoDaCampanha, fuso: string): Date {
  for (let salto = 1; salto <= 8; salto++) {
    const d = new Date(Date.UTC(p.ano, p.mes - 1, p.dia + salto));
    const diaDaSemana = d.getUTCDay();
    if (ritmo.dias.includes(diaDaSemana)) {
      return instanteLocal(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), ritmo.hora_inicio, 0, fuso);
    }
  }
  // `dias` tem pelo menos um dia (schema): oito saltos sempre acham um.
  throw new Error("ritmo sem nenhum dia da semana permitido");
}

/**
 * A hora de cada um dos `quantos` envios, em ordem, a partir de `agora`.
 *
 * O primeiro sai assim que a janela permitir; os seguintes, depois de um
 * intervalo entre `min_minutos` e `max_minutos`. Fora do horário, em dia não
 * permitido ou com o teto do dia batido, o envio passa para o início do
 * próximo dia permitido.
 */
export function planejarHorarios(
  agora: Date,
  quantos: number,
  ritmo: RitmoDaCampanha,
  fuso: string,
  semente: string,
  /** Envios já agendados por dia local (retomada não estoura o teto de hoje). */
  jaNoDia: ReadonlyMap<string, number> = new Map(),
): Date[] {
  const saida: Date[] = [];
  const porDia = new Map(jaNoDia);
  let cursor = agora.getTime();

  for (let i = 0; i < quantos; i++) {
    if (i > 0) cursor += intervaloAntesDe(semente, i, ritmo) * 60_000;

    // Cada volta move o cursor para frente; 400 voltas cobrem um ano de dias bloqueados.
    for (let volta = 0; volta < 400; volta++) {
      const p = partesLocais(new Date(cursor), fuso);
      if (!ritmo.dias.includes(p.diaDaSemana) || p.hora >= ritmo.hora_fim) {
        cursor = inicioDoProximoDia(p, ritmo, fuso).getTime();
        continue;
      }
      if (p.hora < ritmo.hora_inicio) {
        cursor = instanteLocal(p.ano, p.mes, p.dia, ritmo.hora_inicio, 0, fuso).getTime();
        continue;
      }
      if ((porDia.get(chaveDoDia(p)) ?? 0) >= ritmo.por_dia) {
        cursor = inicioDoProximoDia(p, ritmo, fuso).getTime();
        continue;
      }
      break;
    }

    const p = partesLocais(new Date(cursor), fuso);
    porDia.set(chaveDoDia(p), (porDia.get(chaveDoDia(p)) ?? 0) + 1);
    saida.push(new Date(cursor));
  }
  return saida;
}

/** Conta envios por dia local — para a retomada respeitar o que já saiu hoje. */
export function contarPorDia(instantes: readonly Date[], fuso: string): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const d of instantes) {
    const k = chaveDoDia(partesLocais(d, fuso));
    mapa.set(k, (mapa.get(k) ?? 0) + 1);
  }
  return mapa;
}
